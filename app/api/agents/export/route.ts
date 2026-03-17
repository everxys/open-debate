import { NextResponse } from "next/server";

import { exportAgentsPack } from "@/lib/agents";
import { toErrorResponse } from "@/lib/http";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const pack = await exportAgentsPack(body);
    return NextResponse.json({ success: true, data: pack });
  } catch (error) {
    return toErrorResponse(error);
  }
}

