import { NextResponse } from "next/server";

import { listDebateAgentFiles, readDebateAgentFile } from "@/lib/debates";
import { toErrorResponse } from "@/lib/http";

function toPositiveInt(value: string | null) {
  if (!value) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const i = Math.floor(n);
  if (i <= 0) return null;
  return Math.min(i, 2_000_000);
}

function maybeTruncateFileContent(input: {
  path: string;
  content: string;
  updatedAt: string;
  maxChars: number | null;
  tail: boolean;
}) {
  const totalChars = input.content.length;
  const isJsonl = input.path.toLowerCase().endsWith(".jsonl");
  const defaultMax = isJsonl ? 250_000 : null;
  const limit = input.maxChars ?? defaultMax;
  if (!limit || totalChars <= limit) return { ...input, truncated: false, totalChars, shownChars: totalChars, slice: "full" as const };
  const slice = input.tail ? ("tail" as const) : ("head" as const);
  const content = input.tail ? input.content.slice(Math.max(0, totalChars - limit)) : input.content.slice(0, limit);
  return { ...input, content, truncated: true, totalChars, shownChars: content.length, slice };
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string; debateAgentId: string }> }
) {
  try {
    const { id, debateAgentId } = await context.params;
    const url = new URL(request.url);
    const path = url.searchParams.get("path");
    const prefix = url.searchParams.get("prefix");
    const maxChars = toPositiveInt(url.searchParams.get("maxChars"));
    const tail = url.searchParams.get("tail") === "1";

    if (path) {
      const file = await readDebateAgentFile(id, debateAgentId, path);
      const data = maybeTruncateFileContent({ ...file, maxChars, tail });
      return NextResponse.json({ success: true, data });
    }

    const files = await listDebateAgentFiles(id, debateAgentId, prefix ?? undefined);
    return NextResponse.json({ success: true, data: files });
  } catch (error) {
    return toErrorResponse(error);
  }
}
