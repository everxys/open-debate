export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

export type Logger = {
  child(scopeSuffix: string, fields?: LogFields): Logger;
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
};

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

const MAX_LOG_DEPTH = 6;

export function resolveMinLogLevel(raw: string | null | undefined, fallback: LogLevel): LogLevel {
  const normalized = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (normalized === "debug" || normalized === "info" || normalized === "warn" || normalized === "error") {
    return normalized;
  }
  return fallback;
}

export function shouldLogLevel(level: LogLevel, minLevel: LogLevel) {
  return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[minLevel];
}

export function joinLogScope(parentScope: string, scopeSuffix: string) {
  const normalizedSuffix = scopeSuffix.trim().replace(/^\.+/, "").replace(/\.+$/, "");
  if (!normalizedSuffix) return parentScope;
  return parentScope ? `${parentScope}.${normalizedSuffix}` : normalizedSuffix;
}

export function mergeLogFields(baseFields?: LogFields, nextFields?: LogFields) {
  if (baseFields && nextFields) return { ...baseFields, ...nextFields };
  return nextFields ?? baseFields;
}

export function formatLogPrefix(level: LogLevel, scope: string, message: string) {
  return `[open-debate][${level.toUpperCase()}][${scope}] ${message}`;
}

export function resolveConsoleMethod(level: LogLevel): "debug" | "info" | "warn" | "error" {
  if (level === "debug") return "debug";
  if (level === "info") return "info";
  if (level === "warn") return "warn";
  return "error";
}

export function sanitizeLogFields(fields?: LogFields) {
  if (!fields) return undefined;
  const seen = new WeakSet<object>();
  seen.add(fields);
  const sanitized: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    sanitized[key] = isErrorFieldName(key)
      ? normalizeError(value, seen, 1)
      : sanitizeLogValue(value, seen, 1);
  }
  return sanitized as LogFields;
}

export function stringifyLogFields(fields?: LogFields) {
  if (!fields || Object.keys(fields).length <= 0) return "";
  const serialized = safeJsonStringify(fields);
  return serialized && serialized !== "{}" ? serialized : "";
}

export function normalizeError(error: unknown, seen = new WeakSet<object>(), depth = 0) {
  if (error instanceof Error) {
    return sanitizeLogValue(error, seen, depth) as Record<string, unknown>;
  }
  if (isErrorLikeObject(error)) {
    return sanitizeErrorLikeValue(error as object, seen, depth);
  }
  return {
    message:
      typeof error === "string"
        ? error
        : safeJsonStringify(error) ?? String(error),
    raw: sanitizeLogValue(error, seen, depth)
  };
}

function safeJsonStringify(value: unknown) {
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function sanitizeErrorValue(error: Error, seen: WeakSet<object>, depth: number) {
  if (seen.has(error)) return { message: error.message, note: "[Circular Error]" };
  seen.add(error);

  const details: Record<string, unknown> = {
    name: error.name,
    message: error.message,
    stack: error.stack ?? null
  };

  const errorWithExtras = error as Error & { code?: unknown; cause?: unknown };
  if (typeof errorWithExtras.code === "string" && errorWithExtras.code.trim()) {
    details.code = errorWithExtras.code.trim();
  }
  if (errorWithExtras.cause !== undefined) {
    details.cause = sanitizeLogValue(errorWithExtras.cause, seen, depth + 1);
  }

  for (const [key, value] of Object.entries(error)) {
    if (key === "cause" || key === "code") continue;
    if (key in details) continue;
    details[key] = sanitizeLogValue(value, seen, depth + 1);
  }

  return details;
}

function isErrorFieldName(key: string) {
  const normalized = key.trim().toLowerCase();
  return normalized === "error" || normalized === "err" || normalized.endsWith("error") || normalized.endsWith("exception");
}

function readStringProperty(value: object, key: string) {
  try {
    const raw = (value as Record<string, unknown>)[key];
    return typeof raw === "string" && raw.trim() ? raw : null;
  } catch {
    return null;
  }
}

function isErrorLikeObject(value: unknown) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  if (value instanceof Date || value instanceof URL) return false;
  const constructorName = (value as { constructor?: { name?: string } }).constructor?.name ?? "Object";
  return (
    constructorName === "DOMException" ||
    constructorName.endsWith("Error") ||
    readStringProperty(value, "message") !== null ||
    readStringProperty(value, "stack") !== null
  );
}

function sanitizeErrorLikeValue(error: object, seen: WeakSet<object>, depth: number) {
  if (seen.has(error)) return { message: readStringProperty(error, "message") ?? "[Circular Error]" };
  seen.add(error);

  const constructorName = (error as { constructor?: { name?: string } }).constructor?.name ?? "Object";
  const details: Record<string, unknown> = {};
  const name = readStringProperty(error, "name");
  const message = readStringProperty(error, "message");
  const stack = readStringProperty(error, "stack");

  if (name) details.name = name;
  else if (constructorName !== "Object") details.name = constructorName;
  details.message = message ?? safeJsonStringify(error) ?? String(error);
  if (stack) details.stack = stack;

  const errorWithExtras = error as { code?: unknown; cause?: unknown; status?: unknown; statusCode?: unknown };
  for (const key of ["code", "status", "statusCode"] as const) {
    if (errorWithExtras[key] !== undefined) {
      details[key] = sanitizeLogValue(errorWithExtras[key], seen, depth + 1);
    }
  }
  if (errorWithExtras.cause !== undefined) {
    details.cause = sanitizeLogValue(errorWithExtras.cause, seen, depth + 1);
  }

  for (const [key, value] of Object.entries(error)) {
    if (key in details || key === "cause") continue;
    details[key] = sanitizeLogValue(value, seen, depth + 1);
  }
  return details;
}

export function sanitizeLogValue(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof URL) return value.toString();
  if (value instanceof Error) return sanitizeErrorValue(value, seen, depth);
  if (isErrorLikeObject(value)) return sanitizeErrorLikeValue(value as object, seen, depth);

  if (Array.isArray(value)) {
    if (depth >= MAX_LOG_DEPTH) return `[Array(${value.length})]`;
    return value.map((item) => sanitizeLogValue(item, seen, depth + 1));
  }

  if (typeof value === "object") {
    if (seen.has(value as object)) return "[Circular]";
    if (depth >= MAX_LOG_DEPTH) {
      const constructorName =
        (value as { constructor?: { name?: string } }).constructor?.name ?? "Object";
      return `[${constructorName}]`;
    }

    seen.add(value as object);

    const constructorName =
      (value as { constructor?: { name?: string } }).constructor?.name ?? "Object";
    const entries = Object.entries(value as Record<string, unknown>);

    if (entries.length <= 0 && constructorName !== "Object") {
      return `[${constructorName}]`;
    }

    const normalized: Record<string, unknown> = {};
    for (const [key, child] of entries) {
      normalized[key] = sanitizeLogValue(child, seen, depth + 1);
    }
    return normalized;
  }

  return String(value);
}
