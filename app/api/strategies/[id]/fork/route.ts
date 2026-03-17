import { NextResponse } from "next/server";

import { forkStrategy } from "@/lib/strategies";
import { toErrorResponse } from "@/lib/http";

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const result = await forkStrategy(id);
    return NextResponse.json({ success: true, data: result }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}

