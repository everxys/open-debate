import { SignJWT, jwtVerify } from "jose";

import { isAdminEmail, normalizeRole, type UserRole } from "@/lib/roles";

export const SESSION_COOKIE_NAME = "open_debate_session";

export type Session = { userId: string; email: string; role: UserRole };

function getSecret() {
  const value = process.env.SESSION_SECRET;
  if (!value) {
    throw new Error("Missing SESSION_SECRET");
  }
  return new TextEncoder().encode(value);
}

export async function createSessionToken(payload: Session) {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(getSecret());
}

export async function verifySessionToken(token: string): Promise<Session | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret());
    const email = String(payload.email);
    const base = normalizeRole(payload.role);
    const role = base === "admin" || isAdminEmail(email) ? "admin" : "user";
    return {
      userId: String(payload.userId),
      email,
      role
    };
  } catch {
    return null;
  }
}

