import { NextResponse } from "next/server";

import { query } from "@/lib/db";
import { AppError, toErrorResponse } from "@/lib/http";
import { sendVerificationEmail } from "@/lib/email";
import { getClientIp, getUserAgent } from "@/lib/request";
import { createSignupVerificationCode, getSignupVerificationSendStatus } from "@/lib/verification";

function isValidEmail(value: string) {
  const email = value.trim().toLowerCase();
  return email.length >= 3 && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export async function POST(request: Request) {
  try {
    const { email, purpose } = (await request.json()) as { email?: string; purpose?: string };
    if (!email || !isValidEmail(email)) {
      throw new AppError("VALIDATION_ERROR", 400, "Valid email is required");
    }
    if (purpose && purpose !== "signup") {
      throw new AppError("VALIDATION_ERROR", 400, "Invalid purpose");
    }

    const normalizedEmail = email.trim().toLowerCase();
    const ip = getClientIp(request);
    const userAgent = getUserAgent(request);

    const throttle = await getSignupVerificationSendStatus({ email: normalizedEmail, ip });
    if (!throttle.ok) {
      return NextResponse.json({
        success: true,
        data: { sent: true, retryAfterSeconds: throttle.retryAfterSeconds }
      });
    }

    // Avoid account enumeration: always respond success, even if the email is already registered.
    const existing = await query<{ id: string }>("select id from users where email = $1", [
      normalizedEmail
    ]);
    if ((existing.rowCount ?? 0) > 0) {
      return NextResponse.json({ success: true, data: { sent: true, retryAfterSeconds: 60 } });
    }

    const created = await createSignupVerificationCode({
      email: normalizedEmail,
      ip,
      userAgent,
      expiresInMinutes: 10
    });

    await sendVerificationEmail({
      email: normalizedEmail,
      code: created.code,
      purpose: "signup",
      expiresInMinutes: created.expiresInMinutes
    });

    const shouldReturnCode =
      process.env.NODE_ENV !== "production" && (process.env.EMAIL_DEBUG_RETURN_CODE ?? "1") === "1";

    return NextResponse.json({
      success: true,
      data: {
        sent: true,
        retryAfterSeconds: 60,
        ...(shouldReturnCode ? { debugCode: created.code } : null)
      }
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}

