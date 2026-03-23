import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

type ServerLogLevel = "info" | "warn" | "error";

function getLogFilePath(now: Date) {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return path.join(process.cwd(), "log", `node-runtime-${year}-${month}-${day}.log`);
}

function safeJson(value: unknown) {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ note: "Failed to serialize log meta" });
  }
}

export async function appendServerLog(level: ServerLogLevel, message: string, meta?: Record<string, unknown>) {
  const now = new Date();
  const filePath = getLogFilePath(now);
  const line = `${now.toISOString()} [${level.toUpperCase()}] ${message}${meta ? ` ${safeJson(meta)}` : ""}\n`;
  await mkdir(path.dirname(filePath), { recursive: true });
  await appendFile(filePath, line, "utf8");
}
