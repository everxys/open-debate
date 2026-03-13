import { redirect } from "next/navigation";

import { query } from "@/lib/db";
import { readSession } from "@/lib/session";
import { isAdminEmail, normalizeRole, type UserRole } from "@/lib/roles";

export type AppUser = { id: string; email: string; role: UserRole };

export async function requireUser(): Promise<AppUser> {
  const session = await readSession();
  if (!session) {
    redirect("/login");
  }

  const result = await query<{ id: string; email: string; role: string }>(
    "select id, email, role from users where id = $1",
    [session.userId]
  );

  if ((result.rowCount ?? 0) !== 1) {
    redirect("/login");
  }

  const row = result.rows[0];
  const base = normalizeRole(row.role);
  const role = base === "admin" || isAdminEmail(row.email) ? "admin" : "user";
  return { ...row, role };
}

export async function getOptionalUser(): Promise<AppUser | null> {
  const session = await readSession();
  if (!session) {
    return null;
  }

  const result = await query<{ id: string; email: string; role: string }>(
    "select id, email, role from users where id = $1",
    [session.userId]
  );

  const row = result.rows[0];
  if (!row) return null;
  const base = normalizeRole(row.role);
  const role = base === "admin" || isAdminEmail(row.email) ? "admin" : "user";
  return { ...row, role };
}

export async function requireAdmin() {
  const user = await requireUser();
  if (user.role !== "admin") {
    redirect("/");
  }
  return user;
}
