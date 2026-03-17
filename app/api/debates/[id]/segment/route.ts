import { NextResponse } from "next/server";

import { startDebateSegment } from "@/lib/debates";
import { toErrorResponse } from "@/lib/http";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const body = await request.json().catch(() => ({}));
    const result = await startDebateSegment(id, body);
    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    return toErrorResponse(error);
  }
}

