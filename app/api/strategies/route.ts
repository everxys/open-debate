import { NextResponse } from "next/server";

import { createStrategy, listStrategies } from "@/lib/strategies";
import { toErrorResponse } from "@/lib/http";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const scopeRaw = url.searchParams.get("scope") ?? "mine";
    const scope = scopeRaw === "shared" ? "shared" : "mine";
    const strategies = await listStrategies(scope);
    return NextResponse.json({ success: true, data: strategies });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const strategy = await createStrategy(body);
    return NextResponse.json({ success: true, data: strategy }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}

