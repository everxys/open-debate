import { Pool, type QueryResultRow } from "pg";

const globalPool = globalThis as typeof globalThis & {
  openDebatePool?: Pool;
  openDebateSchemaReady?: Promise<void>;
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

async function ensureSchema(pool: Pool) {
  // Keep this minimal: make new columns backward-compatible with existing volumes.
  await pool.query("alter table users add column if not exists role text not null default 'user'");
  await pool.query(
    "alter table debates add column if not exists enable_shared_facts boolean not null default true"
  );
  await pool.query("alter table ai_agents add column if not exists context_length int null");
  await pool.query("alter table ai_agents add column if not exists max_input_tokens int null");
  await pool.query("alter table ai_agents add column if not exists max_output_tokens int null");
  await pool.query("alter table ai_agents add column if not exists deleted_at timestamptz null");
  // Per-seat identity (cannot rely on ai_agents.name because same config can be reused).
  await pool.query("alter table debate_agents add column if not exists display_name text null");
  await pool.query(`
    update debate_agents
       set display_name = concat('Seat-', turn_order)
     where display_name is null
  `);
  // Keep nullable for backward-compatibility: older rows can stay null.
  await pool.query("alter table debate_turns add column if not exists debate_agent_id uuid null");
  await pool.query("alter table debate_turns add column if not exists seat_number int null");
  // Allow reusing the same AI config for multiple seats within one debate.
  await pool.query(`
    do $$
    begin
      if exists (
        select 1 from pg_constraint where conname = 'debate_agents_debate_id_ai_agent_id_key'
      ) then
        alter table debate_agents drop constraint debate_agents_debate_id_ai_agent_id_key;
      end if;
    exception when undefined_table then
      null;
    end $$;
  `);
  await pool.query(`
    do $$
    begin
      if not exists (
        select 1 from pg_constraint where conname = 'users_role_check'
      ) then
        alter table users add constraint users_role_check check (role in ('user', 'admin'));
      end if;
    exception when duplicate_object then
      null;
    end $$;
  `);
}

export async function query<T extends QueryResultRow>(sql: string, params: unknown[] = []) {
  const pool = getPool();
  if (!globalPool.openDebateSchemaReady) {
    globalPool.openDebateSchemaReady = ensureSchema(pool);
  }
  await globalPool.openDebateSchemaReady;

  try {
    return await pool.query<T>(sql, params);
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
