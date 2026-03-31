import { redirect } from "next/navigation";

import { AppError } from "@/lib/http";
import { query } from "@/lib/db";
import { readSession } from "@/lib/session";
import { isAdminEmail, normalizeRole, type UserRole } from "@/lib/roles";

export type AppUser = { id: string; email: string; role: UserRole };

/** Resolve effective user role (admin via DB role or email whitelist) */
function resolveUserRole(dbRole: string, email: string): UserRole {
  const base = normalizeRole(dbRole);
  return base === "admin" || isAdminEmail(email) ? "admin" : "user";
}

/** Fetch user from DB by session, return null if not found */
async function fetchUserBySession(session: { userId: string } | null): Promise<AppUser | null> {
  if (!session) return null;

  const result = await query<{ id: string; email: string; role: string }>(
    "select id, email, role from users where id = $1",
    [session.userId]
  );

  const row = result.rows[0];
  if (!row) return null;

  return { ...row, role: resolveUserRole(row.role, row.email) };
}

/** Require authenticated user, redirect to login if missing */
export async function requireUser(): Promise<AppUser> {
  const session = await readSession();
  const user = await fetchUserBySession(session);
  if (!user) redirect("/login");
  return user;
}

/** Get optional user without redirect */
export async function getOptionalUser(): Promise<AppUser | null> {
  const session = await readSession();
  return fetchUserBySession(session);
}

/** Require admin role, redirect to home if not admin */
export async function requireAdmin() {
  const user = await requireUser();
  if (user.role !== "admin") redirect("/");
  return user;
}

/** Require authenticated session, throw AppError if missing */
export async function requireSessionUser() {
  const session = await readSession();
  if (!session) {
    throw new AppError("AUTH_REQUIRED", 401, "Authentication required");
  }
  return session;
}
