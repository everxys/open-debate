import { NextResponse } from "next/server";

import {
  deleteDebate,
  getDebateDetail,
  ignoreDebateRuntimeError,
  updateDebateAutoRecover,
  updateDebateQuestion,
  updateDebateSharing
} from "@/lib/debates";
import { toErrorResponse } from "@/lib/http";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const debate = await getDebateDetail(id);
    return NextResponse.json({ success: true, data: debate });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const body = await request.json();
    const debate =
      body && typeof body === "object" && "question" in body
        ? await updateDebateQuestion(id, body)
        : body && typeof body === "object" && "ignoreRuntimeError" in body
          ? await ignoreDebateRuntimeError(id, body)
          : body && typeof body === "object" && "autoRecoverOnceOnFailed" in body
            ? await updateDebateAutoRecover(id, body)
          : await updateDebateSharing(id, body);
    return NextResponse.json({ success: true, data: debate });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const result = await deleteDebate(id);
    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    return toErrorResponse(error);
  }
}
