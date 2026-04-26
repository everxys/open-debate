export function normalizeTimestampString(value: unknown) {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

export function normalizeNullableTimestampString(value: unknown) {
  if (value === null || value === undefined) return null;
  return normalizeTimestampString(value);
}
