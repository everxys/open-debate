import { redirect } from "next/navigation";

import { query } from "@/lib/db";
import { readSession } from "@/lib/session";

export async function requireUser() {
  const session = await readSession();
  if (!session) {
    redirect("/login");
  }

  const result = await query<{ id: string; email: string }>(
    "select id, email from users where id = $1",
    [session.userId]
  );

  if ((result.rowCount ?? 0) !== 1) {
    redirect("/login");
  }

  return result.rows[0];
}

export async function getOptionalUser() {
  const session = await readSession();
  if (!session) {
    return null;
  }

  const result = await query<{ id: string; email: string }>(
    "select id, email from users where id = $1",
    [session.userId]
  );

  return result.rows[0] ?? null;
}
