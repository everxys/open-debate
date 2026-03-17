import { NextResponse } from "next/server";

import { createDebate, listDebates } from "@/lib/debates";
import { toErrorResponse } from "@/lib/http";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const scope = url.searchParams.get("scope") === "shared" ? "shared" : "mine";
    const debates = await listDebates(scope);
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
