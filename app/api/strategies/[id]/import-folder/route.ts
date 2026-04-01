import { NextResponse } from "next/server";

import { toErrorResponse } from "@/lib/http";
import { overwriteStrategyFromFolderUpload } from "@/lib/strategies";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const formData = await request.formData();
    const rawFiles = formData.getAll("files").filter((entry): entry is File => entry instanceof File);
    const rawPaths = formData.getAll("paths").map((entry) => String(entry ?? ""));
    const uploadedFiles = rawFiles.map(async (file, index) => ({
      relativePath: rawPaths[index] || file.name,
      content: Buffer.from(await file.arrayBuffer()).toString("utf8")
    }));

    const data = await overwriteStrategyFromFolderUpload(id, await Promise.all(uploadedFiles));
    return NextResponse.json({ success: true, data });
  } catch (error) {
    return toErrorResponse(error);
  }
}
