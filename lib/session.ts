import { cookies } from "next/headers";

export {
  SESSION_COOKIE_NAME,
  createSessionToken,
  verifySessionToken,
  type Session
} from "@/lib/session-core";

import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/session-core";

const SESSION_COOKIE_MAX_AGE = 60 * 60 * 24 * 7; // 7 days

/** Read and verify session from cookie, return null if invalid or missing */
export async function readSession() {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  return token ? verifySessionToken(token) : null;
}

/** Set session cookie with secure settings */
export async function setSessionCookie(token: string) {
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_COOKIE_MAX_AGE
  });
}

/** Clear session cookie */
export async function clearSessionCookie() {
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE_NAME);
}
