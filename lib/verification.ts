import { randomInt } from "node:crypto";

import { sql } from "kysely";

import { ensureDb } from "@/lib/db";
import { AppError } from "@/lib/http";
import { createServerLogger } from "@/lib/logger/server";
import { hashVerificationCode, verifyVerificationCode } from "@/lib/password";

const verificationLogger = createServerLogger("verification");

export function generateSixDigitCode() {
  const value = randomInt(0, 1_000_000);
  return String(value).padStart(6, "0");
}

export function isSixDigitCode(value: string) {
  return /^\d{6}$/.test(value.trim());
}

function isPgUndefinedTable(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "42P01"
  );
}

export async function createSignupVerificationCode(input: {
  email: string;
  ip: string | null;
  userAgent: string | null;
  expiresInMinutes?: number;
}) {
  const expiresInMinutes = input.expiresInMinutes ?? 10;
  const code = generateSixDigitCode();
  const hashed = hashVerificationCode(code, input.email);
  const email = input.email.trim().toLowerCase();

  try {
    const db = await ensureDb();
    await db
      .insertInto("email_verification_codes")
      .values({
        email,
        purpose: "signup",
        code_salt: hashed.salt,
        code_hash: hashed.hash,
        sent_to: email,
        ip: input.ip,
        user_agent: input.userAgent,
        expires_at: sql`now() + (${String(expiresInMinutes)} || ' minutes')::interval`,
        created_at: sql`now()`,
        consumed_at: null
      })
      .execute();
  } catch (error) {
    if (isPgUndefinedTable(error)) {
      verificationLogger.error("DB schema missing: email_verification_codes", { error });
      throw new AppError(
        "DB_MIGRATION_REQUIRED",
        500,
        "数据库缺少 email_verification_codes 表：请把 docker/init.sql 里相关建表语句执行到当前数据库（或重建数据库/volume）"
      );
    }
    throw error;
  }

  return { code, expiresInMinutes };
}

export async function consumeSignupVerificationCode(input: { email: string; code: string }) {
  const email = input.email.trim().toLowerCase();
  const code = input.code.trim();
  if (!isSixDigitCode(code)) return false;

  const db = await ensureDb();
  const candidates = await db
    .selectFrom("email_verification_codes")
    .select(["id", "code_salt", "code_hash"])
    .where("email", "=", email)
    .where("purpose", "=", "signup")
    .where("consumed_at", "is", null)
    .where(sql<boolean>`expires_at > now()`)
    .orderBy("created_at", "desc")
    .limit(5)
    .execute();

  for (const row of candidates) {
    const ok = verifyVerificationCode(code, email, { salt: row.code_salt, hash: row.code_hash });
    if (!ok) continue;

    const consumed = await db
      .updateTable("email_verification_codes")
      .set({ consumed_at: sql`now()` })
      .where("id", "=", row.id)
      .where("consumed_at", "is", null)
      .executeTakeFirst();

    return Number(consumed.numUpdatedRows ?? 0) === 1;
  }

  return false;
}

export async function checkSignupVerificationCode(input: { email: string; code: string }) {
  const email = input.email.trim().toLowerCase();
  const code = input.code.trim();
  if (!isSixDigitCode(code)) return false;

  const db = await ensureDb();
  const candidates = await db
    .selectFrom("email_verification_codes")
    .select(["code_salt", "code_hash"])
    .where("email", "=", email)
    .where("purpose", "=", "signup")
    .where("consumed_at", "is", null)
    .where(sql<boolean>`expires_at > now()`)
    .orderBy("created_at", "desc")
    .limit(5)
    .execute();

  return candidates.some((row) =>
    verifyVerificationCode(code, email, { salt: row.code_salt, hash: row.code_hash })
  );
}

export async function getSignupVerificationSendStatus(input: { email: string; ip: string | null }) {
  const email = input.email.trim().toLowerCase();

  const db = await ensureDb();
  const recentByEmail = await db
    .selectFrom("email_verification_codes")
    .select(sql<number>`count(*)::int`.as("count"))
    .where("email", "=", email)
    .where("purpose", "=", "signup")
    .where(sql<boolean>`created_at > now() - interval '60 seconds'`)
    .executeTakeFirstOrThrow();

  if (Number(recentByEmail.count ?? 0) >= 1) {
    return { ok: false, retryAfterSeconds: 60 };
  }

  if (input.ip) {
    const recentByIp = await db
      .selectFrom("email_verification_codes")
      .select(sql<number>`count(*)::int`.as("count"))
      .where("ip", "=", input.ip)
      .where("purpose", "=", "signup")
      .where(sql<boolean>`created_at > now() - interval '60 seconds'`)
      .executeTakeFirstOrThrow();
    if (Number(recentByIp.count ?? 0) >= 3) {
      return { ok: false, retryAfterSeconds: 60 };
    }
  }

  const hourly = await db
    .selectFrom("email_verification_codes")
    .select(sql<number>`count(*)::int`.as("count"))
    .where("email", "=", email)
    .where("purpose", "=", "signup")
    .where(sql<boolean>`created_at > now() - interval '1 hour'`)
    .executeTakeFirstOrThrow();
  if (Number(hourly.count ?? 0) >= 10) {
    return { ok: false, retryAfterSeconds: 3600 };
  }

  return { ok: true, retryAfterSeconds: 0 };
}
