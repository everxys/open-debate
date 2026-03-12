import { NextResponse } from "next/server";

import { deleteAgentFile, listAgentFiles, upsertAgentFile } from "@/lib/agents";
import { toErrorResponse } from "@/lib/http";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const files = await listAgentFiles(id);
    return NextResponse.json({ success: true, data: files });
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
    const file = await upsertAgentFile(id, body);
    return NextResponse.json({ success: true, data: file });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const body = await request.json();
    await deleteAgentFile(id, body);
    return NextResponse.json({ success: true, data: null });
  } catch (error) {
    return toErrorResponse(error);
  }
}

