import { NextResponse } from "next/server";

import { deleteStoppedDebates } from "@/lib/debates";
import { toErrorResponse } from "@/lib/http";

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      maxCompletedRounds?: unknown;
    };
    const rawThreshold =
      typeof body.maxCompletedRounds === "number"
        ? body.maxCompletedRounds
        : typeof body.maxCompletedRounds === "string"
          ? Number(body.maxCompletedRounds)
          : Number.NaN;
    if (!Number.isFinite(rawThreshold) || rawThreshold < 0) {
      return NextResponse.json({ error: { message: "请输入有效的轮数阈值" } }, { status: 400 });
    }
    const result = await deleteStoppedDebates({
      maxCompletedRounds: Math.floor(rawThreshold)
    });
    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    return toErrorResponse(error);
  }
}
