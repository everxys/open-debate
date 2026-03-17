import { NextResponse } from "next/server";

import { favoriteStrategy, unfavoriteStrategy } from "@/lib/strategies";
import { toErrorResponse } from "@/lib/http";

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const result = await favoriteStrategy(id);
    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const result = await unfavoriteStrategy(id);
    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    return toErrorResponse(error);
  }
}

