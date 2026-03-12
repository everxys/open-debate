import { NextResponse } from "next/server";

import { deleteAgent, getAgentById, updateAgent } from "@/lib/agents";
import { toErrorResponse } from "@/lib/http";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const agent = await getAgentById(id);
    return NextResponse.json({ success: true, data: agent });
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
    const agent = await updateAgent(id, body);
    return NextResponse.json({ success: true, data: agent });
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
    await deleteAgent(id);
    return NextResponse.json({ success: true, data: null });
  } catch (error) {
    return toErrorResponse(error);
  }
}
