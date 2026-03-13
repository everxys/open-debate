import { NextResponse } from "next/server";

import { query } from "@/lib/db";
import { AppError, toErrorResponse } from "@/lib/http";
import { hashPassword } from "@/lib/password";
import { isStrongEnoughPassword } from "@/lib/password-policy";
import { enforceIpRateLimit } from "@/lib/rate-limit";
import { consumeSignupVerificationCode, isSixDigitCode } from "@/lib/verification";
import { createSessionToken, setSessionCookie } from "@/lib/session";
import { isAdminEmail } from "@/lib/roles";

export async function POST(request: Request) {
  try {
    await enforceIpRateLimit(request, { action: "auth_signup", limit: 5, windowSeconds: 600 });

    const { email, password, code } = (await request.json()) as {
      email?: string;
      password?: string;
      code?: string;
    };

    if (!email || !password || !code) {
      throw new AppError("VALIDATION_ERROR", 400, "Email, password, and code are required");
    }
    if (!isSixDigitCode(code)) {
      throw new AppError("VALIDATION_ERROR", 400, "Code must be 6 digits");
    }
    if (!isStrongEnoughPassword(password)) {
      throw new AppError(
        "VALIDATION_ERROR",
        400,
        "Password must be at least 10 chars and include letters + numbers"
      );
    }

    const normalizedEmail = email.toLowerCase();
    const existing = await query<{ id: string }>("select id from users where email = $1", [
      normalizedEmail
    ]);
    if ((existing.rowCount ?? 0) > 0) {
      throw new AppError("CONFLICT", 409, "Email already exists");
    }

    const verified = await consumeSignupVerificationCode({ email: normalizedEmail, code });
    if (!verified) {
      throw new AppError("CODE_INVALID", 400, "Invalid or expired verification code");
    }

    const role = isAdminEmail(normalizedEmail) ? "admin" : "user";

    const inserted = await query<{ id: string; email: string; role: string }>(
      "insert into users (email, password_hash, role, email_verified) values ($1, $2, $3, true) returning id, email, role",
      [normalizedEmail, hashPassword(password), role]
    );

    const token = await createSessionToken({
      userId: inserted.rows[0].id,
      email: inserted.rows[0].email,
      role: inserted.rows[0].role === "admin" ? "admin" : "user"
    });
    await setSessionCookie(token);

    return NextResponse.json({
      success: true,
      data: inserted.rows[0]
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
