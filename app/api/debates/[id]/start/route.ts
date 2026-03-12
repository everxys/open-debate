import { NextResponse } from "next/server";

import { startDebate } from "@/lib/debates";
import { toErrorResponse } from "@/lib/http";

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const debate = await startDebate(id);
    return NextResponse.json({ success: true, data: debate });
  } catch (error) {
    return toErrorResponse(error);
  }
}
