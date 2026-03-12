import { randomInt } from "node:crypto";

import { query } from "@/lib/db";
import { hashVerificationCode, verifyVerificationCode } from "@/lib/password";

export function generateSixDigitCode() {
  const value = randomInt(0, 1_000_000);
  return String(value).padStart(6, "0");
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

  await query(
    `
      insert into email_verification_codes
        (email, purpose, code_salt, code_hash, sent_to, ip, user_agent, expires_at)
      values
        ($1, 'signup', $2, $3, $1, $4, $5, now() + ($6 || ' minutes')::interval)
    `,
    [input.email.trim().toLowerCase(), hashed.salt, hashed.hash, input.ip, input.userAgent, String(expiresInMinutes)]
  );

  return { code, expiresInMinutes };
}

export async function consumeSignupVerificationCode(input: { email: string; code: string }) {
  const email = input.email.trim().toLowerCase();
  const code = input.code.trim();

  const candidates = await query<{
    id: string;
    code_salt: string;
    code_hash: string;
  }>(
    `
      select id, code_salt, code_hash
      from email_verification_codes
      where email = $1
        and purpose = 'signup'
        and consumed_at is null
        and expires_at > now()
      order by created_at desc
      limit 5
    `,
    [email]
  );

  for (const row of candidates.rows) {
    const ok = verifyVerificationCode(code, email, { salt: row.code_salt, hash: row.code_hash });
    if (!ok) continue;

    const consumed = await query(
      `
        update email_verification_codes
        set consumed_at = now()
        where id = $1 and consumed_at is null
      `,
      [row.id]
    );

    return (consumed.rowCount ?? 0) === 1;
  }

  return false;
}

export async function checkSignupVerificationCode(input: { email: string; code: string }) {
  const email = input.email.trim().toLowerCase();
  const code = input.code.trim();

  const candidates = await query<{
    code_salt: string;
    code_hash: string;
  }>(
    `
      select code_salt, code_hash
      from email_verification_codes
      where email = $1
        and purpose = 'signup'
        and consumed_at is null
        and expires_at > now()
      order by created_at desc
      limit 5
    `,
    [email]
  );

  return candidates.rows.some((row) =>
    verifyVerificationCode(code, email, { salt: row.code_salt, hash: row.code_hash })
  );
}

export async function getSignupVerificationSendStatus(input: { email: string; ip: string | null }) {
  const email = input.email.trim().toLowerCase();

  const recentByEmail = await query<{ count: string }>(
    `
      select count(*)::text as count
      from email_verification_codes
      where email = $1
        and purpose = 'signup'
        and created_at > now() - interval '60 seconds'
    `,
    [email]
  );

  if (Number(recentByEmail.rows[0]?.count ?? "0") >= 1) {
    return { ok: false, retryAfterSeconds: 60 };
  }

  if (input.ip) {
    const recentByIp = await query<{ count: string }>(
      `
        select count(*)::text as count
        from email_verification_codes
        where ip = $1
          and purpose = 'signup'
          and created_at > now() - interval '60 seconds'
      `,
      [input.ip]
    );
    if (Number(recentByIp.rows[0]?.count ?? "0") >= 3) {
      return { ok: false, retryAfterSeconds: 60 };
    }
  }

  const hourly = await query<{ count: string }>(
    `
      select count(*)::text as count
      from email_verification_codes
      where email = $1
        and purpose = 'signup'
        and created_at > now() - interval '1 hour'
    `,
    [email]
  );
  if (Number(hourly.rows[0]?.count ?? "0") >= 10) {
    return { ok: false, retryAfterSeconds: 3600 };
  }

  return { ok: true, retryAfterSeconds: 0 };
}
