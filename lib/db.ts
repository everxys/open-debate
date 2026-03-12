import { Pool, type QueryResultRow } from "pg";

const globalPool = globalThis as typeof globalThis & {
  openDebatePool?: Pool;
};

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
    // ignore
  }

  return { host: null, port: null, database: null, hasPassword: null, ssl: null };
}

function truncateSql(sql: string, max = 500) {
  const normalized = sql.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max)}…`;
}

function getPgErrorDetails(error: unknown) {
  if (typeof error !== "object" || error === null) return null;
  const anyError = error as Record<string, unknown>;
  const allowedKeys = [
    "code",
    "message",
    "detail",
    "schema",
    "table",
    "column",
    "constraint",
    "where",
    "severity",
    "routine"
  ] as const;
  const details: Record<string, unknown> = {};
  for (const key of allowedKeys) {
    if (key in anyError) details[key] = anyError[key];
  }
  return Object.keys(details).length > 0 ? details : null;
}

export function getPool() {
  if (!process.env.DATABASE_URL) {
    throw new Error("Missing DATABASE_URL");
  }

  if (!globalPool.openDebatePool) {
    globalPool.openDebatePool = new Pool({
      connectionString: process.env.DATABASE_URL
    });
  }

  return globalPool.openDebatePool;
}

export async function query<T extends QueryResultRow>(sql: string, params: unknown[] = []) {
  try {
    return await getPool().query<T>(sql, params);
  } catch (error) {
    const diagnostics = getDbDiagnostics();
    const details = getPgErrorDetails(error);
    console.error("DB query failed", {
      ...(details ?? null),
      db: diagnostics,
      sql: truncateSql(sql),
      paramCount: params.length,
      paramTypes: params.map((value) => (value === null ? "null" : typeof value))
    });
    throw error;
  }
}
