import { query } from "@/lib/db";
import { toErrorResponse } from "@/lib/http";
import { readSession } from "@/lib/session";

export const runtime = "nodejs";

function splitJsonLines(raw: string) {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function safeParseJsonLine(line: string) {
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function median(values: number[]) {
  const sorted = [...values].filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

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

    const body = (await request.json().catch(() => ({}))) as { rounds?: unknown };
    const rounds = Math.max(1, Math.min(50, Math.floor(Number(body.rounds ?? 3) || 3)));

    const countRes = await query<{ n: number }>(
      "select count(*)::int as n from debate_agents where debate_id = $1",
      [id]
    );
    const participantCount = Math.max(1, Number(countRes.rows[0]?.n ?? 1));
    const windowSize = rounds * participantCount;

    const logRaw = await readDebateFileContent(id, "context/usage_log.jsonl");
    if (!logRaw) {
      const now = new Date().toISOString();
      await upsertDebateFileContent(
        id,
        "context/usage_calibration.json",
        JSON.stringify(
          {
            at: now,
            rounds,
            participantCount,
            samples: 0,
            multiplier: 1,
            note: "No usage log yet. Run at least 1 turn to collect usage, then calibrate again."
          },
          null,
          2
        ),
        now
      );
      return new Response(
        JSON.stringify({
          success: true,
          data: { multiplier: 1, samples: 0, rounds, message: "No usage log yet. Run at least 1 turn, then calibrate again." }
        }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    const lines = splitJsonLines(logRaw);
    const entries = lines.map(safeParseJsonLine).filter(Boolean) as Array<Record<string, unknown>>;
    const tail = entries.slice(Math.max(0, entries.length - windowSize));

    const ratios: number[] = [];
    for (const e of tail) {
      const api = Number(e.apiPromptTokens);
      const est = Number(e.estimatedPromptTokens);
      if (!Number.isFinite(api) || api <= 0) continue;
      if (!Number.isFinite(est) || est <= 0) continue;
      ratios.push(api / est);
    }

    const m = median(ratios);
    const multiplier = m && Number.isFinite(m) && m > 0 ? m : 1;
    const now = new Date().toISOString();

    await upsertDebateFileContent(
      id,
      "context/usage_calibration.json",
      JSON.stringify(
        {
          at: now,
          rounds,
          participantCount,
          samples: ratios.length,
          multiplier
        },
        null,
        2
      ),
      now
    );

    // Recompute cumulative totals from the entire log, but keep per-agent baselines as-is.
    const baselineRaw = await readDebateFileContent(id, "context/usage_baseline.json");
    const baselineParsed = baselineRaw ? safeParseJson(baselineRaw) : null;
    const byBaseline =
      baselineParsed && typeof baselineParsed.byDebateAgentId === "object" && baselineParsed.byDebateAgentId
        ? (baselineParsed.byDebateAgentId as Record<string, unknown>)
        : {};

    const cumulativeBy: Record<
      string,
      { cumulative: number; ctx: number | null; seat: string; agentName: string; model: string; sessionId: number; baseline: number }
    > = {};

    for (const e of entries) {
      const debateAgentId = String(e.debateAgentId ?? "");
      if (!debateAgentId) continue;
      const ctxRaw = Number(e.contextLength);
      const ctx = Number.isFinite(ctxRaw) && ctxRaw > 0 ? Math.floor(ctxRaw) : null;

      const api = Number(e.apiPromptTokens);
      const est = Number(e.estimatedPromptTokens);
      const used =
        Number.isFinite(api) && api > 0
          ? Math.floor(api)
          : Number.isFinite(est) && est > 0
            ? Math.max(1, Math.floor(est * multiplier))
            : 0;
      if (used <= 0) continue;

      const seat = String(e.seat ?? "");
      const agentName = String(e.agentName ?? "");
      const model = String(e.model ?? "");
      const baselineRow =
        byBaseline[debateAgentId] && typeof byBaseline[debateAgentId] === "object"
          ? (byBaseline[debateAgentId] as any)
          : null;
      const baseline = baselineRow && Number.isFinite(Number(baselineRow.baselineCumulativePromptTokens))
        ? Math.floor(Number(baselineRow.baselineCumulativePromptTokens))
        : 0;
      const sessionId = baselineRow && Number.isFinite(Number(baselineRow.sessionId)) ? Math.floor(Number(baselineRow.sessionId)) : 1;
      const existing = cumulativeBy[debateAgentId];
      if (!existing) {
        cumulativeBy[debateAgentId] = {
          cumulative: used,
          ctx,
          seat,
          agentName,
          model,
          sessionId,
          baseline
        };
      } else {
        existing.cumulative += used;
        existing.ctx = existing.ctx || ctx;
      }
    }

    await upsertDebateFileContent(
      id,
      "context/usage_totals.json",
      JSON.stringify(
        {
          updatedAt: now,
          multiplier,
          byDebateAgentId: Object.fromEntries(
            Object.entries(cumulativeBy).map(([debateAgentId, v]) => {
              const sessionPromptTokens = Math.max(0, v.cumulative - v.baseline);
              const ratio = v.ctx && v.ctx > 0 ? sessionPromptTokens / v.ctx : 0;
              return [
                debateAgentId,
                {
                  seat: v.seat,
                  agentName: v.agentName,
                  model: v.model,
                  contextLength: v.ctx,
                  sessionId: v.sessionId,
                  baselineCumulativePromptTokens: v.baseline,
                  cumulativePromptTokens: v.cumulative,
                  sessionPromptTokens,
                  ratio
                }
              ];
            })
          )
        },
        null,
        2
      ),
      now
    );

    return new Response(JSON.stringify({ success: true, data: { multiplier, samples: ratios.length, rounds } }), {
      headers: { "Content-Type": "application/json" }
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
