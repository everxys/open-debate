import { NextResponse } from "next/server";

import { AppError, toErrorResponse } from "@/lib/http";
import { checkSignupVerificationCode } from "@/lib/verification";

export async function POST(request: Request) {
  try {
    const { email, code, purpose } = (await request.json()) as {
      email?: string;
      code?: string;
      purpose?: string;
    };

    if (!email || !code) {
      throw new AppError("VALIDATION_ERROR", 400, "Email and code are required");
    }
    if (purpose && purpose !== "signup") {
      throw new AppError("VALIDATION_ERROR", 400, "Invalid purpose");
    }

    const ok = await checkSignupVerificationCode({ email, code });
    if (!ok) {
      throw new AppError("CODE_INVALID", 400, "Invalid or expired code");
    }

    return NextResponse.json({ success: true, data: { ok: true } });
  } catch (error) {
    return toErrorResponse(error);
  }
}
