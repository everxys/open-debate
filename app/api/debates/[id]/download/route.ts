import path from "node:path";

import { NextResponse } from "next/server";

import { listDebateAllFiles, readDebateAgentFile, readDebateFile } from "@/lib/debates";
import { AppError, toErrorResponse } from "@/lib/http";
import { normalizeFsPath } from "@/lib/fs-tree";

export const runtime = "nodejs";

type DownloadBody = { paths?: unknown };

type DownloadEntry =
  | { virtualPath: string; scope: "debate"; path: string }
  | { virtualPath: string; scope: "agent"; debateAgentId: string; path: string };

function crc32(buffer: Buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc ^= buffer[i];
    for (let j = 0; j < 8; j += 1) {
      const mask = -(crc & 1);
      crc = (crc >>> 1) ^ (0xedb88320 & mask);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function toDosDateTime(value: Date) {
  const year = Math.min(2107, Math.max(1980, value.getFullYear()));
  const month = value.getMonth() + 1;
  const day = value.getDate();
  const hours = value.getHours();
  const minutes = value.getMinutes();
  const seconds = Math.floor(value.getSeconds() / 2);
  return {
    time: (hours << 11) | (minutes << 5) | seconds,
    date: ((year - 1980) << 9) | (month << 5) | day
  };
}

function createZipEndRecord(entryCount: number, centralSize: number, centralOffset: number) {
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entryCount, 8);
  end.writeUInt16LE(entryCount, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20);
  return end;
}

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

function buildZipStream(
  debateId: string,
  entries: DownloadEntry[]
) {
  const centralDirectory: Buffer[] = [];
  let offset = 0;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let writtenEntries = 0;
      try {
        for (const entry of entries) {
          const loaded = await loadDownloadEntryContent(debateId, entry);
          if (!loaded) continue;
          const fileName = Buffer.from(loaded.path, "utf8");
          const content = Buffer.from(loaded.content, "utf8");
          const crc = crc32(content);
          const dateTime = toDosDateTime(loaded.updatedAt ? new Date(loaded.updatedAt) : new Date());
          const flags = 0x0800;

          const localHeader = Buffer.alloc(30);
          localHeader.writeUInt32LE(0x04034b50, 0);
          localHeader.writeUInt16LE(20, 4);
          localHeader.writeUInt16LE(flags, 6);
          localHeader.writeUInt16LE(0, 8);
          localHeader.writeUInt16LE(dateTime.time, 10);
          localHeader.writeUInt16LE(dateTime.date, 12);
          localHeader.writeUInt32LE(crc, 14);
          localHeader.writeUInt32LE(content.length, 18);
          localHeader.writeUInt32LE(content.length, 22);
          localHeader.writeUInt16LE(fileName.length, 26);
          localHeader.writeUInt16LE(0, 28);

          controller.enqueue(localHeader);
          controller.enqueue(fileName);
          controller.enqueue(content);

          const centralHeader = Buffer.alloc(46);
          centralHeader.writeUInt32LE(0x02014b50, 0);
          centralHeader.writeUInt16LE(20, 4);
          centralHeader.writeUInt16LE(20, 6);
          centralHeader.writeUInt16LE(flags, 8);
          centralHeader.writeUInt16LE(0, 10);
          centralHeader.writeUInt16LE(dateTime.time, 12);
          centralHeader.writeUInt16LE(dateTime.date, 14);
          centralHeader.writeUInt32LE(crc, 16);
          centralHeader.writeUInt32LE(content.length, 20);
          centralHeader.writeUInt32LE(content.length, 24);
          centralHeader.writeUInt16LE(fileName.length, 28);
          centralHeader.writeUInt16LE(0, 30);
          centralHeader.writeUInt16LE(0, 32);
          centralHeader.writeUInt16LE(0, 34);
          centralHeader.writeUInt16LE(0, 36);
          centralHeader.writeUInt32LE(0, 38);
          centralHeader.writeUInt32LE(offset, 42);

          centralDirectory.push(centralHeader, fileName);
          offset += localHeader.length + fileName.length + content.length;
          writtenEntries += 1;
        }

        const centralSize = centralDirectory.reduce((total, part) => total + part.length, 0);
        const end = createZipEndRecord(writtenEntries, centralSize, offset);
        for (const part of centralDirectory) controller.enqueue(part);
        controller.enqueue(end);
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    }
  });
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

    const archive = buildZipStream(id, sortedSelectedEntries);
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
