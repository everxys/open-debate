import { NextResponse } from "next/server";

import { getDebateTurnDetail } from "@/lib/debates";
import { toErrorResponse } from "@/lib/http";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string; turnNumber: string }> }
) {
  try {
    const { id, turnNumber } = await context.params;
    const safeTurnNumber = Number(turnNumber);
    const detail = await getDebateTurnDetail(id, safeTurnNumber);
    return NextResponse.json({ success: true, data: detail });
  } catch (error) {
    return toErrorResponse(error);
  }
}
