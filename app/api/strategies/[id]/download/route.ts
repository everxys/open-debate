import { NextResponse } from "next/server";

import { toErrorResponse } from "@/lib/http";
import { getStrategyFolderExport } from "@/lib/strategies";
import { buildZipStream, toAsciiDownloadName } from "@/lib/zip";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const exported = await getStrategyFolderExport(id);
    const archive = buildZipStream(exported.entries);
    const asciiFilename = toAsciiDownloadName(exported.filename, `strategy-${id}.zip`);
    const encodedFilename = encodeURIComponent(exported.filename);
    return new NextResponse(archive, {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodedFilename}`,
        "Cache-Control": "no-store"
      }
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
