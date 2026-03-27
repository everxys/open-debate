import { NextResponse } from "next/server";

import { toErrorResponse } from "@/lib/http";
import { testRetrievalConfig } from "@/lib/retrieval";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const data = await testRetrievalConfig(body);
    return NextResponse.json({ success: true, data });
  } catch (error) {
    return toErrorResponse(error);
  }
}
