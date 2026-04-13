import { NextResponse } from "next/server";

import {
  deleteStrategySharedFile,
  deleteStrategySharedFilesByPrefix,
  getStrategySharedFile,
  listStrategySharedFiles,
  moveStrategySharedFile,
  upsertStrategySharedFile
} from "@/lib/strategies";
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
      const file = await getStrategySharedFile(id, path);
      return NextResponse.json({ success: true, data: file });
    }
    const files = await listStrategySharedFiles(id);
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
    const file = await upsertStrategySharedFile(id, body);
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
      const result = await deleteStrategySharedFilesByPrefix(id, prefix);
      return NextResponse.json({ success: true, data: result });
    }
    await deleteStrategySharedFile(id, body);
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
    const file = await moveStrategySharedFile(id, body);
    return NextResponse.json({ success: true, data: file });
  } catch (error) {
    return toErrorResponse(error);
  }
}
