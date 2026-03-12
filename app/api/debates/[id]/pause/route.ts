import { NextResponse } from "next/server";

import { pauseDebate } from "@/lib/debates";
import { toErrorResponse } from "@/lib/http";

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const debate = await pauseDebate(id);
    return NextResponse.json({ success: true, data: debate });
  } catch (error) {
    return toErrorResponse(error);
  }
}
