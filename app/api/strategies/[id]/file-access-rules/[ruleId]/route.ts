import { NextResponse } from "next/server";

import { deleteStrategyFileAccessRule, updateStrategyFileAccessRule } from "@/lib/strategies";
import { toErrorResponse } from "@/lib/http";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string; ruleId: string }> }
) {
  try {
    const { id, ruleId } = await context.params;
    const body = await request.json();
    const rule = await updateStrategyFileAccessRule(id, ruleId, body);
    return NextResponse.json({ success: true, data: rule });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string; ruleId: string }> }
) {
  try {
    const { id, ruleId } = await context.params;
    await deleteStrategyFileAccessRule(id, ruleId);
    return NextResponse.json({ success: true, data: { deleted: 1 } });
  } catch (error) {
    return toErrorResponse(error);
  }
}
