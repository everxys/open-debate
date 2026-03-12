import { NextResponse } from "next/server";

import { createAgent, listAgents } from "@/lib/agents";
import { toErrorResponse } from "@/lib/http";

export async function GET() {
  try {
    const agents = await listAgents();
    return NextResponse.json({ success: true, data: agents });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const agent = await createAgent(body);
    return NextResponse.json({ success: true, data: agent }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
