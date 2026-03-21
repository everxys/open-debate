import { NextResponse } from "next/server";

import { listDebateTurns } from "@/lib/debates";
import { toErrorResponse } from "@/lib/http";

function toOptionalNonNegativeInt(value: string | null) {
  if (value === null) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const i = Math.floor(n);
  if (i < 0) return null;
  return i;
}

function toOptionalPositiveInt(value: string | null) {
  if (value === null) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const i = Math.floor(n);
  if (i <= 0) return null;
  return i;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const url = new URL(request.url);
    const after = toOptionalNonNegativeInt(url.searchParams.get("after"));
    const before = toOptionalNonNegativeInt(url.searchParams.get("before"));
    const limit = toOptionalPositiveInt(url.searchParams.get("limit"));
    const mode = url.searchParams.get("mode") === "full" ? "full" : "summary";
    const turns = await listDebateTurns(id, {
      afterTurnNumber: after ?? undefined,
      beforeTurnNumber: before ?? undefined,
      limit: limit ?? undefined,
      mode
    });
    return NextResponse.json({ success: true, data: turns.items, meta: { hasMore: turns.hasMore, mode } });
  } catch (error) {
    return toErrorResponse(error);
  }
}
