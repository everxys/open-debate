import { appendServerLog } from "@/lib/core/logger/server-log";
import {
  formatLogPrefix,
  joinLogScope,
  mergeLogFields,
  resolveConsoleMethod,
  resolveMinLogLevel,
  sanitizeLogFields,
  type LogFields,
  type LogLevel,
  type Logger,
  shouldLogLevel
} from "@/lib/core/logger/shared";

const SERVER_MIN_LOG_LEVEL = resolveMinLogLevel(
  process.env.OPEN_DEBATE_LOG_LEVEL,
  process.env.NODE_ENV === "development" ? "debug" : "info"
);

export async function writeServerLog(
  level: LogLevel,
  scope: string,
  message: string,
  fields?: LogFields
) {
  if (!shouldLogLevel(level, SERVER_MIN_LOG_LEVEL)) return;

  const prefix = formatLogPrefix(level, scope, message);
  const consoleMethod = resolveConsoleMethod(level);
  const sanitizedFields = sanitizeLogFields(fields);

  if (sanitizedFields && Object.keys(sanitizedFields).length > 0) {
    console[consoleMethod](prefix, sanitizedFields);
  } else {
    console[consoleMethod](prefix);
  }

  try {
    await appendServerLog(level, `[${scope}] ${message}`, sanitizedFields);
  } catch (error) {
    const fallbackPrefix = formatLogPrefix("error", "logger", "failed to persist server log");
    console.error(fallbackPrefix, {
      scope,
      message,
      persistError: sanitizeLogFields({ error })?.error ?? String(error)
    });
  }
}

export function createServerLogger(scope: string, baseFields?: LogFields): Logger {
  function log(level: LogLevel, message: string, fields?: LogFields) {
    void writeServerLog(level, scope, message, mergeLogFields(baseFields, fields));
  }

  return {
    child(scopeSuffix: string, fields?: LogFields) {
      return createServerLogger(joinLogScope(scope, scopeSuffix), mergeLogFields(baseFields, fields));
    },
    debug(message: string, fields?: LogFields) {
      log("debug", message, fields);
    },
    info(message: string, fields?: LogFields) {
      log("info", message, fields);
    },
    warn(message: string, fields?: LogFields) {
      log("warn", message, fields);
    },
    error(message: string, fields?: LogFields) {
      log("error", message, fields);
    }
  };
}
