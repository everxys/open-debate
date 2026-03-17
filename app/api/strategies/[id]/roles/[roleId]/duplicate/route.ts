import { NextResponse } from "next/server";

import { duplicateStrategyRole } from "@/lib/strategies";
import { toErrorResponse } from "@/lib/http";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string; roleId: string }> }
) {
  try {
    const { id, roleId } = await params;
    const created = await duplicateStrategyRole(id, roleId);
    return NextResponse.json({ success: true, data: created }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}

