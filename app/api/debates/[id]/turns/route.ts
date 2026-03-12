import { NextResponse } from "next/server";

import { listDebateTurns } from "@/lib/debates";
import { toErrorResponse } from "@/lib/http";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const turns = await listDebateTurns(id);
    return NextResponse.json({ success: true, data: turns });
  } catch (error) {
    return toErrorResponse(error);
  }
}
