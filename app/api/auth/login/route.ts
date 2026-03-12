import { NextResponse } from "next/server";

import { query } from "@/lib/db";
import { AppError, toErrorResponse } from "@/lib/http";
import { verifyPassword } from "@/lib/password";
import { createSessionToken, setSessionCookie } from "@/lib/session";
import { getClientIp } from "@/lib/request";

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

export async function POST(request: Request) {
  try {
    const { email, password } = (await request.json()) as {
      email?: string;
      password?: string;
    };

    if (!email || !password) {
      throw new AppError("VALIDATION_ERROR", 400, "Email and password are required");
    }

    const ip = getClientIp(request);

    const result = await query<{
      id: string;
      email: string;
      password_hash: string;
      email_verified: boolean;
      failed_login_attempts: number;
      locked_until: string | null;
    }>(
      "select id, email, password_hash, email_verified, failed_login_attempts, locked_until from users where email = $1",
      [email.toLowerCase()]
    );

    if ((result.rowCount ?? 0) !== 1) {
      // Dummy verify to keep timing closer to a real user lookup.
      const dummySalt = "00000000000000000000000000000000";
      const dummyHash = "0".repeat(128);
      verifyPassword(password, `${dummySalt}:${dummyHash}`);
      throw new AppError("AUTH_INVALID", 401, "Invalid email or password");
    }

    const user = result.rows[0];

    if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
      throw new AppError("AUTH_LOCKED", 423, "Too many failed attempts. Try again later.");
    }

    const ok = verifyPassword(password, user.password_hash);
    if (!ok) {
      const updated = await query<{ failed_login_attempts: number; locked_until: string | null }>(
        `
          update users
          set
            failed_login_attempts = failed_login_attempts + 1,
            last_failed_login_at = now(),
            locked_until = case
              when (failed_login_attempts + 1) >= $2 then now() + ($3 || ' minutes')::interval
              else locked_until
            end
          where id = $1
          returning failed_login_attempts, locked_until
        `,
        [user.id, MAX_FAILED_ATTEMPTS, String(LOCK_MINUTES)]
      );

      const lockedNow =
        updated.rows[0]?.locked_until && new Date(updated.rows[0].locked_until).getTime() > Date.now();
      if (lockedNow) {
        throw new AppError("AUTH_LOCKED", 423, "Too many failed attempts. Try again later.");
      }

      throw new AppError("AUTH_INVALID", 401, "Invalid email or password");
    }

    if (!user.email_verified) {
      throw new AppError("AUTH_NOT_VERIFIED", 403, "Email is not verified");
    }

    await query(
      `
        update users
        set failed_login_attempts = 0,
            locked_until = null,
            last_login_at = now(),
            last_login_ip = $2
        where id = $1
      `,
      [user.id, ip]
    );

    const token = await createSessionToken({
      userId: user.id,
      email: user.email
    });
    await setSessionCookie(token);

    return NextResponse.json({
      success: true,
      data: {
        id: user.id,
        email: user.email
      }
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
