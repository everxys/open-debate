import { NextResponse } from "next/server";

import {
  deleteWorkspaceFile,
  deleteWorkspaceFilesByPrefix,
  getWorkspaceFile,
  listWorkspaceFiles,
  moveWorkspaceFile,
  upsertWorkspaceFile
} from "@/lib/workspaces";
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
      const file = await getWorkspaceFile(id, path);
      return NextResponse.json({ success: true, data: file });
    }
    const files = await listWorkspaceFiles(id);
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
    const file = await upsertWorkspaceFile(id, body);
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
    const prefix = body && typeof body === "object" && "prefix" in body ? String((body as { prefix?: unknown }).prefix ?? "").trim() : "";
    if (prefix) {
      const result = await deleteWorkspaceFilesByPrefix(id, prefix);
      return NextResponse.json({ success: true, data: result });
    }
    const result = await deleteWorkspaceFile(id, body);
    return NextResponse.json({ success: true, data: result });
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
    const file = await moveWorkspaceFile(id, body);
    return NextResponse.json({ success: true, data: file });
  } catch (error) {
    return toErrorResponse(error);
  }
}
