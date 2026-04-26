import {
  formatLogPrefix,
  joinLogScope,
  mergeLogFields,
  resolveConsoleMethod,
  resolveMinLogLevel,
  sanitizeLogFields,
  stringifyLogFields,
  type LogFields,
  type LogLevel,
  type Logger,
  shouldLogLevel
} from "@/lib/logger/shared";

const CLIENT_MIN_LOG_LEVEL = resolveMinLogLevel(
  process.env.NEXT_PUBLIC_OPEN_DEBATE_LOG_LEVEL,
  process.env.NODE_ENV === "development" ? "debug" : "info"
);

export function createBrowserLogger(scope: string, baseFields?: LogFields): Logger {
  function log(level: LogLevel, message: string, fields?: LogFields) {
    if (!shouldLogLevel(level, CLIENT_MIN_LOG_LEVEL)) return;
    const prefix = formatLogPrefix(level, scope, message);
    const consoleMethod = resolveConsoleMethod(level);
    const sanitizedFields = sanitizeLogFields(mergeLogFields(baseFields, fields));

    if (sanitizedFields && Object.keys(sanitizedFields).length > 0) {
      const serializedFields = stringifyLogFields(sanitizedFields);
      console[consoleMethod](serializedFields ? `${prefix} ${serializedFields}` : prefix, sanitizedFields);
    } else {
      console[consoleMethod](prefix);
    }
  }

  return {
    child(scopeSuffix: string, fields?: LogFields) {
      return createBrowserLogger(joinLogScope(scope, scopeSuffix), mergeLogFields(baseFields, fields));
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
