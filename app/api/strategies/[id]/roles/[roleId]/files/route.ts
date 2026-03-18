import { NextResponse } from "next/server";

import {
  deleteStrategyRoleFile,
  deleteStrategyRoleFilesByPrefix,
  getStrategyRoleFile,
  listStrategyRoleFiles,
  moveStrategyRoleFile,
  upsertStrategyRoleFile
} from "@/lib/strategies";
import { toErrorResponse } from "@/lib/http";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string; roleId: string }> }
) {
  try {
    const { id, roleId } = await context.params;
    const url = new URL(request.url);
    const path = url.searchParams.get("path");
    if (path) {
      const file = await getStrategyRoleFile(id, roleId, path);
      return NextResponse.json({ success: true, data: file });
    }
    const files = await listStrategyRoleFiles(id, roleId);
    return NextResponse.json({ success: true, data: files }); // meta list (no content)
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; roleId: string }> }
) {
  try {
    const { id, roleId } = await context.params;
    const body = await request.json();
    const file = await upsertStrategyRoleFile(id, roleId, body);
    return NextResponse.json({ success: true, data: file });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string; roleId: string }> }
) {
  try {
    const { id, roleId } = await context.params;
    const body = await request.json();
    const prefix = body && typeof body === "object" && "prefix" in body ? String((body as any).prefix ?? "").trim() : "";
    if (prefix) {
      const result = await deleteStrategyRoleFilesByPrefix(id, roleId, prefix);
      return NextResponse.json({ success: true, data: result });
    }
    await deleteStrategyRoleFile(id, roleId, body);
    return NextResponse.json({ success: true, data: { deleted: 1 } });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string; roleId: string }> }
) {
  try {
    const { id, roleId } = await context.params;
    const body = await request.json();
    const file = await moveStrategyRoleFile(id, roleId, body);
    return NextResponse.json({ success: true, data: file });
  } catch (error) {
    return toErrorResponse(error);
  }
}
