import { NextResponse } from "next/server";

import { duplicateAgent } from "@/lib/agents";
import { toErrorResponse } from "@/lib/http";

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const created = await duplicateAgent(id);
    return NextResponse.json({ success: true, data: created }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}

