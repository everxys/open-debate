import { Pool, type QueryResultRow } from "pg";
import { Kysely, PostgresDialect } from "kysely";

import type { OpenDebateDb } from "@/lib/db-schema";
import { assertMigrationsApplied } from "@/lib/core/db-migrations";
import { createServerLogger } from "@/lib/core/logger/server";

const dbLogger = createServerLogger("db");

/** Global pool singleton with migration readiness tracking */
const globalPool = globalThis as typeof globalThis & {
  openDebateDb?: Kysely<OpenDebateDb>;
  openDebatePool?: Pool;
  openDebateMigrationsReady?: Promise<void>;
  openDebateRuntimeRecoveryScheduled?: boolean;
  openDebateSummaryWorkerScheduled?: boolean;
};

type PgErrorLike = {
  code?: unknown;
  errno?: unknown;
  message?: unknown;
  cause?: unknown;
};

/** Schedule debate runtime recovery after DB is ready */
function scheduleDebateRuntimeRecovery(reason = "db_ready") {
  if (typeof window !== "undefined") return;
  if (globalPool.openDebateRuntimeRecoveryScheduled) return;

  globalPool.openDebateRuntimeRecoveryScheduled = true;
  queueMicrotask(() => {
    void import("@/lib/debate-runtime-recovery")
      .then(({ ensureDebateRuntimeRecoveryStarted }) => ensureDebateRuntimeRecoveryStarted(reason))
      .catch((error) => {
        globalPool.openDebateRuntimeRecoveryScheduled = false;
        dbLogger.error("debate runtime recovery bootstrap failed", { reason, error });
      });
  });
}

function scheduleSummaryJobWorker(reason = "db_ready") {
  if (typeof window !== "undefined") return;
  if (globalPool.openDebateSummaryWorkerScheduled) return;

  globalPool.openDebateSummaryWorkerScheduled = true;
  queueMicrotask(() => {
    void import("@/lib/summary-job-worker")
      .then(({ ensureSummaryJobWorkerStarted }) => ensureSummaryJobWorkerStarted(reason))
      .catch((error) => {
        globalPool.openDebateSummaryWorkerScheduled = false;
        dbLogger.error("summary job worker bootstrap failed", { reason, error });
      });
  });
}

/** Extract DB connection diagnostics from DATABASE_URL */
function getDbDiagnostics() {
  const raw = process.env.DATABASE_URL;
  if (!raw) return null;

  try {
    if (raw.startsWith("postgres://") || raw.startsWith("postgresql://")) {
      const url = new URL(raw);
      return {
        host: url.hostname,
        port: url.port ? Number(url.port) : 5432,
        database: url.pathname?.replace(/^\//, "") || null,
        hasPassword: Boolean(url.password),
        ssl: url.searchParams.get("sslmode") ?? null
      };
    }
  } catch {
    /* ignore */
  }

  return { host: null, port: null, database: null, hasPassword: null, ssl: null };
}

/** Truncate SQL for logging */
function truncateSql(sql: string, max = 500) {
  const normalized = sql.replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max)}...`;
}

/** Extract relevant PG error details for logging */
function getPgErrorDetails(error: unknown) {
  if (typeof error !== "object" || error === null) return null;
  const anyError = error as Record<string, unknown>;
  const allowedKeys = ["code", "message", "detail", "schema", "table", "column", "constraint", "where", "severity", "routine"] as const;
  const details: Record<string, unknown> = {};
  for (const key of allowedKeys) {
    if (key in anyError) details[key] = anyError[key];
  }
  return Object.keys(details).length > 0 ? details : null;
}

function flattenPgErrorCodes(error: unknown, into: Set<string>) {
  if (!error || typeof error !== "object") return;
  const pgError = error as PgErrorLike;
  for (const value of [pgError.code, pgError.errno]) {
    if (typeof value === "string" && value.trim()) into.add(value.trim());
  }
  if (pgError.cause) flattenPgErrorCodes(pgError.cause, into);
}

export function isRecoverablePoolError(error: unknown) {
  const codes = new Set<string>();
  flattenPgErrorCodes(error, codes);
  return (
    codes.has("ECONNRESET") ||
    codes.has("ECONNREFUSED") ||
    codes.has("57P01") ||
    codes.has("57P02") ||
    codes.has("57P03") ||
    codes.has("08001") ||
    codes.has("08006")
  );
}

function resetDbSingletons(pool?: Pool) {
  if (pool && globalPool.openDebatePool && globalPool.openDebatePool !== pool) return;
  globalPool.openDebateDb = undefined;
  globalPool.openDebateMigrationsReady = undefined;
  globalPool.openDebatePool = undefined;
}

function attachPoolErrorHandler(pool: Pool) {
  pool.on("error", (error) => {
    dbLogger.warn("open-debate pg pool emitted error", {
      recoverable: isRecoverablePoolError(error),
      details: getPgErrorDetails(error)
    });

    resetDbSingletons(pool);

    // Detach broken singletons immediately; let the pool finish closing in the background.
    void pool.end().catch(() => null);
  });
}

/** Get or create global pool singleton */
export function getPool(): Pool {
  if (!process.env.DATABASE_URL) throw new Error("Missing DATABASE_URL");
  if (!globalPool.openDebatePool) {
    globalPool.openDebatePool = new Pool({ connectionString: process.env.DATABASE_URL });
    attachPoolErrorHandler(globalPool.openDebatePool);
  }
  return globalPool.openDebatePool;
}

export function getDb(): Kysely<OpenDebateDb> {
  if (!globalPool.openDebateDb) {
    globalPool.openDebateDb = new Kysely<OpenDebateDb>({
      dialect: new PostgresDialect({
        pool: getPool()
      })
    });
  }
  return globalPool.openDebateDb;
}

/** Ensure DB migrations are applied and return pool */
export async function ensureDbReady(): Promise<Pool> {
  const pool = getPool();
  if (!globalPool.openDebateMigrationsReady) {
    globalPool.openDebateMigrationsReady = assertMigrationsApplied(pool).catch((error) => {
      if (isRecoverablePoolError(error)) {
        resetDbSingletons(pool);
      } else if (globalPool.openDebatePool === pool) {
        globalPool.openDebateMigrationsReady = undefined;
      }
      throw error;
    });
  }
  await globalPool.openDebateMigrationsReady;
  scheduleDebateRuntimeRecovery();
  scheduleSummaryJobWorker();
  return pool;
}

export async function ensureDb() {
  await ensureDbReady();
  return getDb();
}

export async function query<T extends QueryResultRow>(sql: string, params: unknown[] = []) {
  const pool = await ensureDbReady();

  try {
    return await pool.query<T>(sql, params);
  } catch (error) {
    const diagnostics = getDbDiagnostics();
    const details = getPgErrorDetails(error);
    dbLogger.error("DB query failed", {
      ...(details ?? null),
      db: diagnostics,
      sql: truncateSql(sql),
      paramCount: params.length,
      paramTypes: params.map((value) => (value === null ? "null" : typeof value))
    });
    throw error;
  }
}
