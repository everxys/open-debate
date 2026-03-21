import { NextResponse } from "next/server";

import { toErrorResponse } from "@/lib/http";
import { getStrategyWorkflowPhasePrompts, updateStrategyWorkflowPhasePrompts } from "@/lib/strategies";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const data = await getStrategyWorkflowPhasePrompts(id);
    return NextResponse.json({ success: true, data });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const body = await request.json();
    const data = await updateStrategyWorkflowPhasePrompts(id, body);
    return NextResponse.json({ success: true, data });
  } catch (error) {
    return toErrorResponse(error);
  }
}
