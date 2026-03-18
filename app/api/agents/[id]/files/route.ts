import { NextResponse } from "next/server";

import { deleteAgentFile, deleteAgentFilesByPrefix, getAgentFile, listAgentFiles, moveAgentFile, upsertAgentFile } from "@/lib/agents";
import { toErrorResponse } from "@/lib/http";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const url = new URL(request.url);
    const path = url.searchParams.get("path");
    if (path) {
      const file = await getAgentFile(id, path);
      return NextResponse.json({ success: true, data: file });
    }
    const files = await listAgentFiles(id);
    return NextResponse.json({ success: true, data: files }); // meta list (no content)
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
    const prefix = body && typeof body === "object" && "prefix" in body ? String((body as any).prefix ?? "").trim() : "";
    if (prefix) {
      const result = await deleteAgentFilesByPrefix(id, prefix);
      return NextResponse.json({ success: true, data: result });
    }
    await deleteAgentFile(id, body);
    return NextResponse.json({ success: true, data: { deleted: 1 } });
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
    const file = await moveAgentFile(id, body);
    return NextResponse.json({ success: true, data: file });
  } catch (error) {
    return toErrorResponse(error);
  }
}
