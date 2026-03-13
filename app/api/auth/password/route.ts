import { NextResponse } from "next/server";

import { query } from "@/lib/db";
import { AppError, toErrorResponse } from "@/lib/http";
import { hashPassword, verifyPassword } from "@/lib/password";
import { isStrongEnoughPassword } from "@/lib/password-policy";
import { getClientIp } from "@/lib/request";
import { enforceIpRateLimit } from "@/lib/rate-limit";
import { readSession } from "@/lib/session";

export async function PATCH(request: Request) {
  try {
    await enforceIpRateLimit(request, { action: "auth_change_password", limit: 20, windowSeconds: 600 });

    const session = await readSession();
    if (!session) {
      throw new AppError("AUTH_REQUIRED", 401, "Authentication required");
    }

    const { currentPassword, newPassword } = (await request.json()) as {
      currentPassword?: string;
      newPassword?: string;
    };

    if (!currentPassword || !newPassword) {
      throw new AppError("VALIDATION_ERROR", 400, "currentPassword and newPassword are required");
    }
    if (!isStrongEnoughPassword(newPassword)) {
      throw new AppError(
        "VALIDATION_ERROR",
        400,
        "Password must be at least 10 chars and include letters + numbers"
      );
    }
    if (newPassword === currentPassword) {
      throw new AppError("VALIDATION_ERROR", 400, "New password must be different");
    }

    const ip = getClientIp(request);
    const result = await query<{ password_hash: string }>("select password_hash from users where id = $1", [
      session.userId
    ]);
    if ((result.rowCount ?? 0) !== 1) {
      throw new AppError("AUTH_REQUIRED", 401, "Authentication required");
    }

    const ok = verifyPassword(currentPassword, result.rows[0].password_hash);
    if (!ok) {
      throw new AppError("AUTH_INVALID", 401, "Current password is incorrect");
    }

    await query(
      `
        update users
        set password_hash = $2,
            failed_login_attempts = 0,
            locked_until = null,
            last_login_at = coalesce(last_login_at, now()),
            last_login_ip = coalesce(last_login_ip, $3)
        where id = $1
      `,
      [session.userId, hashPassword(newPassword), ip]
    );

    return NextResponse.json({ success: true, data: null });
  } catch (error) {
    return toErrorResponse(error);
  }
}

