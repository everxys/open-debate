import { NextResponse } from "next/server";

import { testAgentConnection, testAgentConnectionDebug } from "@/lib/agents";
import { toErrorResponse } from "@/lib/http";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const url = new URL(request.url);
    const debug = url.searchParams.get("debug") === "1";
    const result = debug ? await testAgentConnectionDebug(id) : await testAgentConnection(id);
    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    return toErrorResponse(error);
  }
}
