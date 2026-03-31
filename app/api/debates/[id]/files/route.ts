import { NextResponse } from "next/server";

import { listDebateFiles, readDebateFile } from "@/lib/debates";
import { AppError, toErrorResponse } from "@/lib/http";

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
  version?: number | null;
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

function getOptionalSystemFileFallback(path: string) {
  const normalized = path.replace(/\\/g, "/").replace(/^\/+/, "").trim().toLowerCase();
  if (normalized === "votes/open.json") {
    return { path, content: JSON.stringify({ status: "closed" }), updatedAt: "", version: null };
  }
  if (normalized === "context/usage.json" || normalized === "context/usage_totals.json") {
    return { path, content: JSON.stringify({ byDebateAgentId: {} }), updatedAt: "", version: null };
  }
  if (normalized === "question/history.json") {
    return { path, content: "[]", updatedAt: "", version: null };
  }
  return null;
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const url = new URL(request.url);
    const path = url.searchParams.get("path");
    const prefix = url.searchParams.get("prefix");
    const maxChars = toPositiveInt(url.searchParams.get("maxChars"));
    const tail = url.searchParams.get("tail") === "1";

    if (path) {
      let file;
      try {
        file = await readDebateFile(id, path);
      } catch (error) {
        if (error instanceof AppError && error.code === "NOT_FOUND") {
          const fallback = getOptionalSystemFileFallback(path);
          if (fallback) {
            file = fallback;
          } else {
            throw error;
          }
        } else {
          throw error;
        }
      }
      const data = maybeTruncateFileContent({ ...file, maxChars, tail });
      return NextResponse.json({ success: true, data });
    }

    const files = await listDebateFiles(id, prefix ?? undefined);
    return NextResponse.json({ success: true, data: files });
  } catch (error) {
    return toErrorResponse(error);
  }
}
