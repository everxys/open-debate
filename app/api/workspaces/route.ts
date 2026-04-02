import { NextResponse } from "next/server";

import { createWorkspace, listWorkspaces } from "@/lib/workspaces";
import { toErrorResponse } from "@/lib/http";

export async function GET() {
  try {
    const items = await listWorkspaces();
    return NextResponse.json({ success: true, data: items });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const item = await createWorkspace(body);
    return NextResponse.json({ success: true, data: item }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
