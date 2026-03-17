import { NextResponse } from "next/server";

import { importAgentsPack } from "@/lib/agents";
import { toErrorResponse } from "@/lib/http";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const agents = await importAgentsPack(body);
    return NextResponse.json({ success: true, data: agents }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
