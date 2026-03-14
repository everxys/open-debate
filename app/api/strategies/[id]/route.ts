import { NextResponse } from "next/server";

import { deleteStrategy, getStrategyDetail, updateStrategy } from "@/lib/strategies";
import { toErrorResponse } from "@/lib/http";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const strategy = await getStrategyDetail(id);
    return NextResponse.json({ success: true, data: strategy });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const body = await request.json();
    const strategy = await updateStrategy(id, body);
    return NextResponse.json({ success: true, data: strategy });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    await deleteStrategy(id);
    return NextResponse.json({ success: true, data: null });
  } catch (error) {
    return toErrorResponse(error);
  }
}

