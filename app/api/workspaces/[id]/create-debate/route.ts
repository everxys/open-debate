import { NextResponse } from "next/server";

import { createDebateFromWorkspace } from "@/lib/workspaces";
import { toErrorResponse } from "@/lib/http";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const body = await request.json().catch(() => ({}));
    const debate = await createDebateFromWorkspace(id, body);
    return NextResponse.json({ success: true, data: debate }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
