import { query } from "@/lib/db";
import { toErrorResponse } from "@/lib/http";
import { readSession } from "@/lib/session";

export const runtime = "nodejs";

function safeParseJson(text: string) {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function readDebateFileContent(debateId: string, path: string) {
  const result = await query<{ content: string }>(
    "select content from debate_files where debate_id = $1 and path = $2 limit 1",
    [debateId, path]
  );
  if ((result.rowCount ?? 0) !== 1) return null;
  return String(result.rows[0].content ?? "");
}

async function upsertDebateFileContent(debateId: string, path: string, content: string, now: string) {
  await query(
    `
      insert into debate_files (debate_id, path, content, created_at, updated_at)
      values ($1, $2, $3, $4, $4)
      on conflict (debate_id, path)
      do update set content = excluded.content, updated_at = excluded.updated_at
    `,
    [debateId, path, content, now]
  );
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const session = await readSession();
    if (!session) {
      return new Response(JSON.stringify({ success: false, error: { code: "AUTH_REQUIRED" } }), {
        status: 401,
        headers: { "Content-Type": "application/json" }
      });
    }

    const { id } = await context.params;
    const ownership = await query<{ user_id: string }>("select user_id from debates where id = $1", [id]);
    if ((ownership.rowCount ?? 0) !== 1 || String(ownership.rows[0].user_id) !== session.userId) {
      return new Response(JSON.stringify({ success: false, error: { code: "NOT_FOUND" } }), {
        status: 404,
        headers: { "Content-Type": "application/json" }
      });
    }

    const body = (await request.json().catch(() => ({}))) as { debateAgentId?: unknown };
    const debateAgentId = String(body.debateAgentId ?? "").trim();
    if (!debateAgentId) {
      return new Response(JSON.stringify({ success: false, error: { code: "VALIDATION_ERROR", message: "debateAgentId is required" } }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    const totalsRaw = await readDebateFileContent(id, "context/usage_totals.json");
    const totalsParsed = totalsRaw ? safeParseJson(totalsRaw) : null;
    const byTotals =
      totalsParsed && typeof totalsParsed.byDebateAgentId === "object" && totalsParsed.byDebateAgentId
        ? (totalsParsed.byDebateAgentId as Record<string, unknown>)
        : {};
    const row = byTotals[debateAgentId] && typeof byTotals[debateAgentId] === "object" ? (byTotals[debateAgentId] as any) : null;
    const cumulative = row && Number.isFinite(Number(row.cumulativePromptTokens)) ? Math.floor(Number(row.cumulativePromptTokens)) : 0;

    const baselineRaw = await readDebateFileContent(id, "context/usage_baseline.json");
    const baselineParsed = baselineRaw ? safeParseJson(baselineRaw) : null;
    const byBaseline =
      baselineParsed && typeof baselineParsed.byDebateAgentId === "object" && baselineParsed.byDebateAgentId
        ? (baselineParsed.byDebateAgentId as Record<string, unknown>)
        : {};

    const prev = byBaseline[debateAgentId] && typeof byBaseline[debateAgentId] === "object" ? (byBaseline[debateAgentId] as any) : null;
    const prevSessionId = prev && Number.isFinite(Number(prev.sessionId)) ? Math.floor(Number(prev.sessionId)) : 1;
    const nextSessionId = prevSessionId + 1;
    const now = new Date().toISOString();

    const nextByBaseline = { ...byBaseline };
    nextByBaseline[debateAgentId] = {
      ...(prev && typeof prev === "object" ? { seat: prev.seat, agentName: prev.agentName, model: prev.model } : {}),
      sessionId: nextSessionId,
      baselineCumulativePromptTokens: cumulative,
      at: now
    };

    await upsertDebateFileContent(
      id,
      "context/usage_baseline.json",
      JSON.stringify({ updatedAt: now, byDebateAgentId: nextByBaseline }, null, 2),
      now
    );

    // Also update totals row's sessionId/baseline so UI reflects immediately.
    const nextByTotals = { ...byTotals };
    if (row) {
      nextByTotals[debateAgentId] = {
        ...row,
        sessionId: nextSessionId,
        baselineCumulativePromptTokens: cumulative,
        sessionPromptTokens: 0,
        ratio: 0,
        updatedAt: now
      };
      await upsertDebateFileContent(
        id,
        "context/usage_totals.json",
        JSON.stringify({ ...(totalsParsed ?? {}), updatedAt: now, byDebateAgentId: nextByTotals }, null, 2),
        now
      );
    }

    return new Response(JSON.stringify({ success: true, data: { debateAgentId, sessionId: nextSessionId } }), {
      headers: { "Content-Type": "application/json" }
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}

