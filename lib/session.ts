import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";

import { isAdminEmail, normalizeRole, type UserRole } from "@/lib/roles";

const COOKIE_NAME = "open_debate_session";

function getSecret() {
  const value = process.env.SESSION_SECRET;
  if (!value) {
    throw new Error("Missing SESSION_SECRET");
  }
  return new TextEncoder().encode(value);
}

export type Session = { userId: string; email: string; role: UserRole };

export async function createSessionToken(payload: Session) {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(getSecret());
}

export async function readSession() {
  const cookieStore = await cookies();
  const token = cookieStore.get(COOKIE_NAME)?.value;
  if (!token) {
    return null;
  }

  return verifySessionToken(token);
}

export async function verifySessionToken(token: string) {
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

export async function setSessionCookie(token: string) {
  const cookieStore = await cookies();
  cookieStore.set(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 7
  });
}

export async function clearSessionCookie() {
  const cookieStore = await cookies();
  cookieStore.delete(COOKIE_NAME);
}
