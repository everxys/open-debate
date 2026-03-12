import { NextResponse } from "next/server";

import { appendAgentToDebate } from "@/lib/debates";
import { AppError, toErrorResponse } from "@/lib/http";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const body = (await request.json()) as { agentId?: string };
    if (!body.agentId) {
      throw new AppError("VALIDATION_ERROR", 400, "agentId is required");
    }
    const debate = await appendAgentToDebate(id, body.agentId);
    return NextResponse.json({ success: true, data: debate });
  } catch (error) {
    return toErrorResponse(error);
  }
}

