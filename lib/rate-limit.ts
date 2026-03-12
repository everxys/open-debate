import { query } from "@/lib/db";
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

  let result: { rows: Array<{ count: number }> };
  try {
    result = await query<{ count: number }>(
      `
        insert into rate_limit_counters (key, window_id, count)
        values ($1, $2, 1)
        on conflict (key, window_id)
        do update set count = rate_limit_counters.count + 1
        returning count
      `,
      [key, windowId]
    );
  } catch (error) {
    const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : null;
    if (code === "42P01") {
      console.warn("rate_limit_counters table missing; skipping rate limit");
      return;
    }
    throw error;
  }

  const count = result.rows[0]?.count ?? 1;
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
