import { NextResponse } from "next/server";

import { exportAgentsPack } from "@/lib/agents";
import { toErrorResponse } from "@/lib/http";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const pack = await exportAgentsPack({ agentIds: [id] });
    return NextResponse.json({ success: true, data: pack });
  } catch (error) {
    return toErrorResponse(error);
  }
}
