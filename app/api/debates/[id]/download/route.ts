import path from "node:path";

import { NextResponse } from "next/server";

import { query } from "@/lib/db";
import { listDebateAllFiles } from "@/lib/debates";
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

function buildZip(entries: Array<{ path: string; content: Buffer; updatedAt?: string | null }>) {
  const files: Buffer[] = [];
  const centralDirectory: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const fileName = Buffer.from(entry.path, "utf8");
    const content = entry.content;
    const crc = crc32(content);
    const dateTime = toDosDateTime(entry.updatedAt ? new Date(entry.updatedAt) : new Date());
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

    files.push(localHeader, fileName, content);

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
  }

  const centralSize = centralDirectory.reduce((total, part) => total + part.length, 0);
  const centralOffset = offset;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...files, ...centralDirectory, end]);
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

    const debatePaths = Array.from(selectedEntries.values())
      .filter((entry): entry is Extract<DownloadEntry, { scope: "debate" }> => entry.scope === "debate")
      .map((entry) => entry.path);
    const agentPathsById = new Map<string, string[]>();
    for (const entry of selectedEntries.values()) {
      if (entry.scope !== "agent") continue;
      const list = agentPathsById.get(entry.debateAgentId) ?? [];
      list.push(entry.path);
      agentPathsById.set(entry.debateAgentId, list);
    }

    const contentByVirtualPath = new Map<string, { content: Buffer; updatedAt: string | null }>();

    if (debatePaths.length > 0) {
      const result = await query<{ path: string; content: string; updated_at: string | null }>(
        `
          select path, content, updated_at
            from debate_files
           where debate_id = $1
             and path = any($2::text[])
        `,
        [id, debatePaths]
      );
      for (const row of result.rows) {
        const virtualPath = `debate/${normalizeFsPath(String(row.path ?? ""))}`;
        contentByVirtualPath.set(virtualPath, {
          content: Buffer.from(String(row.content ?? ""), "utf8"),
          updatedAt: row.updated_at ? String(row.updated_at) : null
        });
      }
    }

    for (const [debateAgentId, paths] of agentPathsById.entries()) {
      const result = await query<{ path: string; content: string; updated_at: string | null; turn_order: number | null; display_name: string | null }>(
        `
          select f.path,
                 f.content,
                 f.updated_at,
                 da.turn_order,
                 da.display_name
            from debate_agent_files f
            join debate_agents da on da.id = f.debate_agent_id
           where da.debate_id = $1
             and f.debate_agent_id = $2
             and f.path = any($3::text[])
        `,
        [id, debateAgentId, paths]
      );
      for (const row of result.rows) {
        const seat = row.turn_order && Number(row.turn_order) > 0 ? `Seat-${Math.floor(Number(row.turn_order))}` : "Seat-?";
        const agentName = String(row.display_name ?? "Unknown").trim() || "Unknown";
        const folderName = `${seat} ${agentName} (${debateAgentId.slice(0, 4)})`;
        const virtualPath = `agents/${folderName}/${normalizeFsPath(String(row.path ?? ""))}`;
        contentByVirtualPath.set(virtualPath, {
          content: Buffer.from(String(row.content ?? ""), "utf8"),
          updatedAt: row.updated_at ? String(row.updated_at) : null
        });
      }
    }

    const zipEntries = Array.from(selectedEntries.values())
      .sort((a, b) => a.virtualPath.localeCompare(b.virtualPath))
      .map((entry) => {
        const file = contentByVirtualPath.get(entry.virtualPath);
        if (!file) return null;
        return {
          path: entry.virtualPath,
          content: file.content,
          updatedAt: file.updatedAt
        };
      })
      .filter((entry): entry is { path: string; content: Buffer; updatedAt: string | null } => Boolean(entry));

    if (zipEntries.length === 0) {
      throw new AppError("NOT_FOUND", 404, "Selected files were not found");
    }

    const singleSelectedPath = selectedPaths.length === 1 ? selectedPaths[0] : null;
    const singleFile =
      singleSelectedPath &&
      zipEntries.length === 1 &&
      zipEntries[0].path === singleSelectedPath
        ? zipEntries[0]
        : null;

    if (singleFile) {
      const filename = path.posix.basename(singleFile.path) || "download.txt";
      return new NextResponse(singleFile.content, {
        status: 200,
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(singleFile.content.length),
          "Content-Disposition": `attachment; filename="${filename}"`,
          "Cache-Control": "no-store"
        }
      });
    }

    const archive = buildZip(zipEntries);
    return new NextResponse(archive, {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Length": String(archive.length),
        "Content-Disposition": `attachment; filename="debate-${id}-files.zip"`,
        "Cache-Control": "no-store"
      }
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
