import { NextResponse } from "next/server";

import { listDebateAllFiles } from "@/lib/debates";
import { toErrorResponse } from "@/lib/http";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const entries = await listDebateAllFiles(id);
    return NextResponse.json({ success: true, data: entries });
  } catch (error) {
    return toErrorResponse(error);
  }
}

