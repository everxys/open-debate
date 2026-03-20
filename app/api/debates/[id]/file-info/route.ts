import { NextResponse } from "next/server";

import { query } from "@/lib/db";
import { AppError, toErrorResponse } from "@/lib/http";
import { readSession } from "@/lib/session";

type RequestBody =
  | { scope?: "debate"; path?: unknown }
  | { scope?: "agent"; debateAgentId?: unknown; path?: unknown };

async function requireDebateOwner(debateId: string, userId: string) {
  const result = await query<{ id: string }>(
    "select id from debates where id = $1 and user_id = $2 limit 1",
    [debateId, userId]
  );
  if ((result.rowCount ?? 0) !== 1) {
    throw new AppError("NOT_FOUND", 404, "Debate not found");
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const session = await readSession();
    if (!session) {
      throw new AppError("AUTH_REQUIRED", 401, "Authentication required");
    }
    await requireDebateOwner(id, session.userId);

    const body = (await request.json().catch(() => ({}))) as RequestBody;
    const scope = body.scope === "agent" ? "agent" : "debate";
    const path = String(body.path ?? "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
    if (!path) {
      throw new AppError("VALIDATION_ERROR", 400, "File path is required");
    }

    if (scope === "debate") {
      const result = await query<{ content: string; created_at: string; updated_at: string }>(
        `
          select content, created_at, updated_at
            from debate_files
           where debate_id = $1
             and path = $2
           limit 1
        `,
        [id, path]
      );
      if ((result.rowCount ?? 0) !== 1) {
        throw new AppError("NOT_FOUND", 404, "File not found");
      }
      const content = String(result.rows[0].content ?? "");
      return NextResponse.json({
        success: true,
        data: {
          charCount: content.length,
          byteSize: Buffer.byteLength(content, "utf8"),
          createdAt: String(result.rows[0].created_at ?? ""),
          updatedAt: String(result.rows[0].updated_at ?? "")
        }
      });
    }

    const debateAgentId = String((body as { debateAgentId?: unknown }).debateAgentId ?? "").trim();
    if (!debateAgentId) {
      throw new AppError("VALIDATION_ERROR", 400, "debateAgentId is required");
    }

    const result = await query<{ content: string; created_at: string; updated_at: string }>(
      `
        select f.content, f.created_at, f.updated_at
          from debate_agent_files f
          join debate_agents da on da.id = f.debate_agent_id
         where da.debate_id = $1
           and f.debate_agent_id = $2
           and f.path = $3
         limit 1
      `,
      [id, debateAgentId, path]
    );
    if ((result.rowCount ?? 0) !== 1) {
      throw new AppError("NOT_FOUND", 404, "File not found");
    }
    const content = String(result.rows[0].content ?? "");
    return NextResponse.json({
      success: true,
      data: {
        charCount: content.length,
        byteSize: Buffer.byteLength(content, "utf8"),
        createdAt: String(result.rows[0].created_at ?? ""),
        updatedAt: String(result.rows[0].updated_at ?? "")
      }
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
