export type UserRole = "user" | "admin";

export function normalizeRole(value: unknown): UserRole {
  return value === "admin" ? "admin" : "user";
}

function splitCommaList(value: string) {
  return value
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

export function isAdminEmail(email: string) {
  const raw = process.env.ADMIN_EMAILS;
  if (!raw) return false;
  const set = new Set(splitCommaList(raw));
  return set.has(email.trim().toLowerCase());
}

