import { sql } from "kysely";

import { ensureDb } from "@/lib/db";
import { AppError } from "@/lib/http";
import { getClientIp } from "@/lib/request";

type IpRateLimitConfig = {
  action: string;
  limit: number;
  windowSeconds: number;
};

export async function enforceIpRateLimit(request: Request, config: IpRateLimitConfig) {
  const ip = getClientIp(request) ?? "unknown";
  const nowSeconds = Math.floor(Date.now() / 1000);
  const windowId = Math.floor(nowSeconds / config.windowSeconds);
  const key = `${config.action}:ip:${ip}`;

  let count = 1;
  try {
    const db = await ensureDb();
    const result = await db
      .insertInto("rate_limit_counters")
      .values({
        key,
        window_id: windowId,
        count: 1
      })
      .onConflict((oc) =>
        oc.columns(["key", "window_id"]).doUpdateSet({
          count: sql`rate_limit_counters.count + 1`
        })
      )
      .returning("count")
      .executeTakeFirstOrThrow();
    count = Number(result.count ?? 1);
  } catch (error) {
    const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : null;
    if (code === "42P01") {
      console.warn("rate_limit_counters table missing; skipping rate limit");
      return;
    }
    throw error;
  }

  if (count <= config.limit) return;

  const resetAt = (windowId + 1) * config.windowSeconds;
  const retryAfter = Math.max(1, resetAt - nowSeconds);
  throw new AppError(
    "RATE_LIMITED",
    429,
    `Too many requests. Retry after ${retryAfter}s.`,
    { "Retry-After": String(retryAfter) }
  );
}
