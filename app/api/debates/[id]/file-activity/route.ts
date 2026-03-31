import { NextResponse } from "next/server";

import { getDebateFileActivityDetail, listDebateFileActivity } from "@/lib/debates";
import { toErrorResponse } from "@/lib/http";

function toOptionalPositiveInt(value: string | null) {
  if (!value) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const i = Math.floor(n);
  if (i <= 0) return null;
  return i;
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
    const action = actionRaw === "read" || actionRaw === "write" ? actionRaw : undefined;
    const path = url.searchParams.get("path") ?? undefined;
    const beforeId = url.searchParams.get("beforeId") ?? undefined;
    const limit = toOptionalPositiveInt(url.searchParams.get("limit")) ?? undefined;

    const list = await listDebateFileActivity(id, {
      action,
      path,
      beforeId,
      limit
    });
    return NextResponse.json({ success: true, data: list.items, meta: { hasMore: list.hasMore, counts: list.counts } });
  } catch (error) {
    return toErrorResponse(error);
  }
}
