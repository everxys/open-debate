import { NextResponse } from "next/server";

import { testAgentConfig } from "@/lib/agents";
import { toErrorResponse } from "@/lib/http";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const result = await testAgentConfig(body);
    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    return toErrorResponse(error);
  }
}
