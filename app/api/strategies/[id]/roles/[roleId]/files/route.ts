import { NextResponse } from "next/server";

import {
  deleteStrategyRoleFile,
  listStrategyRoleFiles,
  moveStrategyRoleFile,
  upsertStrategyRoleFile
} from "@/lib/strategies";
import { toErrorResponse } from "@/lib/http";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string; roleId: string }> }
) {
  try {
    const { id, roleId } = await context.params;
    const files = await listStrategyRoleFiles(id, roleId);
    return NextResponse.json({ success: true, data: files });
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
    await deleteStrategyRoleFile(id, roleId, body);
    return NextResponse.json({ success: true, data: null });
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

