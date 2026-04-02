import { NextResponse } from "next/server";

import { getWorkspaceDetail, updateWorkspace } from "@/lib/workspaces";
import { toErrorResponse } from "@/lib/http";

export async function GET(_: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const item = await getWorkspaceDetail(id);
    return NextResponse.json({ success: true, data: item });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const body = await request.json();
    const item = await updateWorkspace(id, body);
    return NextResponse.json({ success: true, data: item });
  } catch (error) {
    return toErrorResponse(error);
  }
}
