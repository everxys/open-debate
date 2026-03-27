import { NextResponse } from "next/server";

import { toErrorResponse } from "@/lib/http";
import { getStrategyWorkflowConfig, updateStrategyWorkflowConfig } from "@/lib/strategies";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const data = await getStrategyWorkflowConfig(id);
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
    const data = await updateStrategyWorkflowConfig(id, body);
    return NextResponse.json({ success: true, data });
  } catch (error) {
    return toErrorResponse(error);
  }
}
