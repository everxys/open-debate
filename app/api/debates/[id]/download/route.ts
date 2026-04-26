import path from "node:path";

import { NextResponse } from "next/server";

import { listDebateAllFiles, readDebateAgentFile, readDebateFile } from "@/lib/debates";
import { AppError, toErrorResponse } from "@/lib/http";
import { normalizeFsPath } from "@/lib/fs-tree";
import { buildZipStream, type ZipEntry } from "@/lib/zip";

export const runtime = "nodejs";

type DownloadBody = { paths?: unknown };

type DownloadEntry =
  | { virtualPath: string; scope: "debate"; path: string }
  | { virtualPath: string; scope: "agent"; debateAgentId: string; path: string };

async function loadDownloadEntryContent(
  debateId: string,
  entry: DownloadEntry
): Promise<{ path: string; content: string; updatedAt?: string | null }> {
  if (entry.scope === "debate") {
    const file = await readDebateFile(debateId, entry.path);
    return { path: entry.virtualPath, content: file.content, updatedAt: file.updatedAt };
  }
  const file = await readDebateAgentFile(debateId, entry.debateAgentId, entry.path);
  return { path: entry.virtualPath, content: file.content, updatedAt: file.updatedAt };
}

function makeVirtualPath(entry: Awaited<ReturnType<typeof listDebateAllFiles>>[number]) {
  if (entry.scope === "debate") return `debate/${entry.path}`;
  const seat = entry.turnOrder && entry.turnOrder > 0 ? `Seat-${entry.turnOrder}` : "Seat-?";
  const folderName = `${seat} ${entry.agentName} (${entry.debateAgentId.slice(0, 4)})`;
  return `agents/${folderName}/${entry.path}`;
}

function normalizeSelectedPaths(input: unknown) {
  const raw = Array.isArray((input as DownloadBody | null)?.paths) ? ((input as DownloadBody).paths as unknown[]) : [];
  const values = raw
    .map((item) => normalizeFsPath(String(item ?? "")))
    .filter(Boolean);
  return Array.from(new Set(values));
}

async function* loadZipEntries(debateId: string, entries: DownloadEntry[]): AsyncIterable<ZipEntry> {
  for (const entry of entries) {
    yield loadDownloadEntryContent(debateId, entry);
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const body = (await request.json().catch(() => ({}))) as DownloadBody;
    const selectedPaths = normalizeSelectedPaths(body);
    if (selectedPaths.length === 0) {
      throw new AppError("VALIDATION_ERROR", 400, "At least one file or folder must be selected");
    }

    const allFiles = await listDebateAllFiles(id);
    const byVirtualPath = new Map<string, Awaited<ReturnType<typeof listDebateAllFiles>>[number]>();
    for (const entry of allFiles) {
      byVirtualPath.set(makeVirtualPath(entry), entry);
    }

    const selectedEntries = new Map<string, DownloadEntry>();
    for (const selectedPath of selectedPaths) {
      const exact = byVirtualPath.get(selectedPath);
      if (exact) {
        if (exact.scope === "debate") {
          selectedEntries.set(selectedPath, { virtualPath: selectedPath, scope: "debate", path: exact.path });
        } else {
          selectedEntries.set(selectedPath, {
            virtualPath: selectedPath,
            scope: "agent",
            debateAgentId: exact.debateAgentId,
            path: exact.path
          });
        }
      }

      const prefix = `${selectedPath}/`;
      for (const [virtualPath, entry] of byVirtualPath.entries()) {
        if (!virtualPath.startsWith(prefix)) continue;
        if (entry.scope === "debate") {
          selectedEntries.set(virtualPath, { virtualPath, scope: "debate", path: entry.path });
        } else {
          selectedEntries.set(virtualPath, {
            virtualPath,
            scope: "agent",
            debateAgentId: entry.debateAgentId,
            path: entry.path
          });
        }
      }
    }

    if (selectedEntries.size === 0) {
      throw new AppError("NOT_FOUND", 404, "Selected files or folders do not contain downloadable files");
    }

    const sortedSelectedEntries = Array.from(selectedEntries.values()).sort((a, b) => a.virtualPath.localeCompare(b.virtualPath));

    const singleSelectedPath = selectedPaths.length === 1 ? selectedPaths[0] : null;
    const singleFile =
      singleSelectedPath &&
      sortedSelectedEntries.length === 1 &&
      sortedSelectedEntries[0].virtualPath === singleSelectedPath
        ? sortedSelectedEntries[0]
        : null;

    if (singleFile) {
      const loaded = await loadDownloadEntryContent(id, singleFile);
      const filename = path.posix.basename(loaded.path) || "download.txt";
      const content = Buffer.from(loaded.content, "utf8");
      return new NextResponse(content, {
        status: 200,
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(content.length),
          "Content-Disposition": `attachment; filename="${filename}"`,
          "Cache-Control": "no-store"
        }
      });
    }

    const archive = buildZipStream(loadZipEntries(id, sortedSelectedEntries));
    return new NextResponse(archive, {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="debate-${id}-files.zip"`,
        "Cache-Control": "no-store"
      }
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
