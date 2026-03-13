import { NextResponse } from "next/server";

import { query } from "@/lib/db";

export async function GET() {
  const startedAt = Date.now();
  let dbOk = false;
  let dbLatencyMs: number | null = null;

  try {
    const t0 = Date.now();
    await query("select 1");
    dbLatencyMs = Date.now() - t0;
    dbOk = true;
  } catch {
    dbOk = false;
  }

  const ok = dbOk;

  return NextResponse.json({
    status: ok ? "healthy" : "unhealthy",
    timestamp: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    checks: {
      database: { ok: dbOk, latencyMs: dbLatencyMs }
    }
  });
}

