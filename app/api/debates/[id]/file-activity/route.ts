import { NextResponse } from "next/server";

import { getDebateFileActivityDetail, listDebateFileActivity, listDebateFileActivityNav } from "@/lib/debates";
import { toErrorResponse } from "@/lib/http";

function toOptionalPositiveInt(value: string | null) {
  if (!value) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const i = Math.floor(n);
  if (i <= 0) return null;
  return i;
}

function toOptionalInt(value: string | null) {
  if (!value) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  return Math.floor(n);
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const url = new URL(request.url);
    const entryId = url.searchParams.get("entryId");
    if (entryId) {
      const detail = await getDebateFileActivityDetail(id, entryId);
      return NextResponse.json({ success: true, data: detail });
    }

    const actionRaw = url.searchParams.get("action");
    const action = actionRaw === "read" || actionRaw === "write" || actionRaw === "summarizer_write" ? actionRaw : undefined;
    if (url.searchParams.get("mode") === "nav") {
      const nav = await listDebateFileActivityNav(id, { action });
      return NextResponse.json({ success: true, data: nav.groups, meta: { counts: nav.counts } });
    }

    const path = url.searchParams.get("path") ?? undefined;
    const debateAgentId = url.searchParams.get("debateAgentId") ?? undefined;
    const roundNumber = toOptionalInt(url.searchParams.get("roundNumber"));
    const turnNumber = toOptionalInt(url.searchParams.get("turnNumber"));
    const beforeId = url.searchParams.get("beforeId") ?? undefined;
    const limit = toOptionalPositiveInt(url.searchParams.get("limit")) ?? undefined;

    const list = await listDebateFileActivity(id, {
      action,
      path,
      debateAgentId,
      roundNumber,
      turnNumber,
      beforeId,
      limit
    });
    return NextResponse.json({ success: true, data: list.items, meta: { hasMore: list.hasMore, counts: list.counts } });
  } catch (error) {
    return toErrorResponse(error);
  }
}
