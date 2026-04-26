export function getPgErrorCode(error: unknown) {
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

export function truncateErrorMessage(message: string, maxChars = 1_500) {
  if (message.length <= maxChars) return message;
  return `${message.slice(0, maxChars - 1)}…`;
}

export function trimToChars(value: string, maxChars?: number | null) {
  if (maxChars === undefined || maxChars === null) return value;
  if (!Number.isFinite(maxChars) || maxChars <= 0) return value;
  if (value.length <= maxChars) return value;
  return value.slice(0, Math.floor(maxChars));
}

export function splitJsonLines(raw: string) {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function safeParseJsonLine(line: string) {
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function appendWithTrim(current: string, appended: string, maxChars?: number | null) {
  const next = (current ? `${current}\n` : "") + appended;
  if (maxChars === undefined || maxChars === null) return next;
  if (!Number.isFinite(maxChars) || maxChars <= 0) return next;
  if (next.length <= maxChars) return next;
  return next.slice(Math.max(0, next.length - maxChars));
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
