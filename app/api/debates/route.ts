import { NextResponse } from "next/server";

import { createDebate, listDebates } from "@/lib/debates";
import { toErrorResponse } from "@/lib/http";

export async function GET() {
  try {
    const debates = await listDebates();
    return NextResponse.json({ success: true, data: debates });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const debate = await createDebate(body);
    return NextResponse.json({ success: true, data: debate }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
