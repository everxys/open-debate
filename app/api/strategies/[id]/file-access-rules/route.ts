import { NextResponse } from "next/server";

import { createStrategyFileAccessRule, listStrategyFileAccessRules } from "@/lib/strategies";
import { toErrorResponse } from "@/lib/http";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const rules = await listStrategyFileAccessRules(id);
    return NextResponse.json({ success: true, data: rules });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const body = await request.json();
    const rule = await createStrategyFileAccessRule(id, body);
    return NextResponse.json({ success: true, data: rule });
  } catch (error) {
    return toErrorResponse(error);
  }
}
