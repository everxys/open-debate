import { NextResponse } from "next/server";

import { toErrorResponse } from "@/lib/http";
import { getRetrievalConfig, updateRetrievalConfig } from "@/lib/retrieval";

export async function GET() {
  try {
    const data = await getRetrievalConfig();
    return NextResponse.json({ success: true, data });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const body = await request.json();
    const data = await updateRetrievalConfig(body);
    return NextResponse.json({ success: true, data });
  } catch (error) {
    return toErrorResponse(error);
  }
}
