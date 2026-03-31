import { Pool, type QueryResultRow } from "pg";

/** Global pool singleton with schema readiness tracking */
const globalPool = globalThis as typeof globalThis & {
  openDebatePool?: Pool;
  openDebateSchemaReady?: Promise<void>;
  openDebateRuntimeRecoveryScheduled?: boolean;
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
        console.error("debate runtime recovery bootstrap failed", error);
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
  } catch { /* ignore */ }

  return { host: null, port: null, database: null, hasPassword: null, ssl: null };
}

/** Truncate SQL for logging */
function truncateSql(sql: string, max = 500) {
  const normalized = sql.replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max)}…`;
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

/** Get or create global pool singleton */
export function getPool(): Pool {
  if (!process.env.DATABASE_URL) throw new Error("Missing DATABASE_URL");
  if (!globalPool.openDebatePool) {
    globalPool.openDebatePool = new Pool({ connectionString: process.env.DATABASE_URL });
  }
  return globalPool.openDebatePool;
}

/** Ensure DB schema is ready and return pool */
export async function ensureDbReady(): Promise<Pool> {
  const pool = getPool();
  if (!globalPool.openDebateSchemaReady) {
    globalPool.openDebateSchemaReady = ensureSchema(pool);
  }
  await globalPool.openDebateSchemaReady;
  scheduleDebateRuntimeRecovery();
  return pool;
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
  await pool.query("alter table debates add column if not exists workflow_phase_kind text null");
  await pool.query("alter table debates add column if not exists workflow_phase_title text null");
  await pool.query("alter table debates add column if not exists workflow_phase_round int null");
  await pool.query("alter table debates add column if not exists runtime_notice_kind text null");
  await pool.query("alter table debates add column if not exists runtime_notice_message text null");
  await pool.query("alter table debates add column if not exists runtime_notice_at timestamptz null");
  await pool.query(`
    do $$
    begin
      if exists (
        select 1 from information_schema.tables
         where table_schema = 'public' and table_name = 'debate_files'
      ) then
        alter table debate_files add column if not exists version int not null default 1;
      end if;
    end $$;
  `);
  await pool.query(`
    create table if not exists debate_file_versions (
      id uuid primary key,
      debate_id uuid not null,
      path text not null,
      version int not null,
      content text not null,
      mode text not null,
      reason text null,
      base_version int null,
      created_by_debate_agent_id uuid null,
      created_at timestamptz not null,
      unique (debate_id, path, version)
    )
  `);
  await pool.query("create index if not exists idx_debate_file_versions_debate_id_path_version on debate_file_versions (debate_id, path, version desc)");
  await pool.query(`
    create table if not exists debate_file_activity_logs (
      id uuid primary key,
      debate_id uuid not null,
      debate_agent_id uuid not null,
      turn_number int not null,
      round_number int not null,
      action text not null,
      scope text not null,
      path text not null,
      target_debate_agent_id uuid null,
      write_mode text null,
      before_version int null,
      after_version int null,
      before_content text null,
      after_content text null,
      target_heading text null,
      reason text null,
      created_at timestamptz not null
    )
  `);
  await pool.query("create index if not exists idx_debate_file_activity_logs_debate_id_created_at on debate_file_activity_logs (debate_id, created_at desc, id desc)");
  await pool.query("create index if not exists idx_debate_file_activity_logs_debate_id_action_created_at on debate_file_activity_logs (debate_id, action, created_at desc, id desc)");
  await pool.query(`
    do $$
    begin
      if not exists (
        select 1 from pg_constraint where conname = 'debate_file_versions_debate_id_fkey'
      ) then
        alter table debate_file_versions
          add constraint debate_file_versions_debate_id_fkey
          foreign key (debate_id) references debates(id) on delete cascade;
      end if;
      if not exists (
        select 1 from pg_constraint where conname = 'debate_file_versions_created_by_debate_agent_id_fkey'
      ) then
        alter table debate_file_versions
          add constraint debate_file_versions_created_by_debate_agent_id_fkey
          foreign key (created_by_debate_agent_id) references debate_agents(id) on delete set null;
      end if;
      if not exists (
        select 1 from pg_constraint where conname = 'debate_file_activity_logs_debate_id_fkey'
      ) then
        alter table debate_file_activity_logs
          add constraint debate_file_activity_logs_debate_id_fkey
          foreign key (debate_id) references debates(id) on delete cascade;
      end if;
      if not exists (
        select 1 from pg_constraint where conname = 'debate_file_activity_logs_debate_agent_id_fkey'
      ) then
        alter table debate_file_activity_logs
          add constraint debate_file_activity_logs_debate_agent_id_fkey
          foreign key (debate_agent_id) references debate_agents(id) on delete cascade;
      end if;
      if not exists (
        select 1 from pg_constraint where conname = 'debate_file_activity_logs_target_debate_agent_id_fkey'
      ) then
        alter table debate_file_activity_logs
          add constraint debate_file_activity_logs_target_debate_agent_id_fkey
          foreign key (target_debate_agent_id) references debate_agents(id) on delete set null;
      end if;
      if not exists (
        select 1 from pg_constraint where conname = 'debate_file_activity_logs_action_check'
      ) then
        alter table debate_file_activity_logs
          add constraint debate_file_activity_logs_action_check
          check (action in ('read', 'write', 'search', 'list', 'stat'));
      end if;
      if not exists (
        select 1 from pg_constraint where conname = 'debate_file_activity_logs_scope_check'
      ) then
        alter table debate_file_activity_logs
          add constraint debate_file_activity_logs_scope_check
          check (scope in ('debate', 'agent'));
      end if;
    exception when undefined_table then
      null;
    when duplicate_object then
      null;
    end $$;
  `);
  await pool.query(`
    do $$
    begin
      if exists (
        select 1 from pg_constraint where conname = 'debate_file_activity_logs_action_check'
      ) then
        alter table debate_file_activity_logs
          drop constraint debate_file_activity_logs_action_check;
      end if;
      alter table debate_file_activity_logs
        add constraint debate_file_activity_logs_action_check
        check (action in ('read', 'write', 'search', 'list', 'stat'));
    exception when undefined_table then
      null;
    when duplicate_object then
      null;
    end $$;
  `);
  await pool.query(`
    do $$
    begin
      if exists (
        select 1 from information_schema.tables
         where table_schema = 'public' and table_name = 'debate_files'
      ) then
        insert into debate_file_versions (
          id,
          debate_id,
          path,
          version,
          content,
          mode,
          reason,
          base_version,
          created_by_debate_agent_id,
          created_at
        )
        select
          gen_random_uuid(),
          f.debate_id,
          f.path,
          1,
          f.content,
          'backfill',
          'schema backfill',
          null,
          null,
          coalesce(f.updated_at, f.created_at, now())
        from debate_files f
        where f.path like 'final/%'
          and not exists (
            select 1
              from debate_file_versions v
             where v.debate_id = f.debate_id
               and v.path = f.path
               and v.version = 1
          );
      end if;
    end $$;
  `);
  await pool.query(`
    create table if not exists retrieval_configs (
      id uuid primary key,
      user_id uuid not null unique,
      provider text not null,
      name text not null,
      model text not null,
      dimensions int null,
      base_url text not null,
      api_key_encrypted text not null,
      api_key_masked text not null,
      is_active boolean not null default true,
      created_at timestamptz not null,
      updated_at timestamptz not null
    )
  `);
  await pool.query(`
    create table if not exists debate_context_chunks (
      id uuid primary key,
      debate_id uuid not null,
      debate_agent_id uuid null,
      chunk_key text not null,
      source_type text not null,
      source_path text null,
      turn_number_start int null,
      turn_number_end int null,
      round_number int null,
      phase_kind text null,
      segment_tag text null,
      content text not null,
      content_hash text not null,
      created_at timestamptz not null,
      updated_at timestamptz not null,
      unique (debate_id, chunk_key)
    )
  `);
  await pool.query(`
    create table if not exists debate_context_embeddings (
      id uuid primary key,
      debate_id uuid not null,
      chunk_id uuid not null unique,
      model text not null,
      dimensions int null,
      embedding_json jsonb not null,
      created_at timestamptz not null,
      updated_at timestamptz not null
    )
  `);
  await pool.query("create index if not exists idx_debate_context_chunks_debate_id on debate_context_chunks (debate_id)");
  await pool.query("create index if not exists idx_debate_context_chunks_source_type on debate_context_chunks (source_type)");
  await pool.query("create index if not exists idx_debate_context_embeddings_debate_id on debate_context_embeddings (debate_id)");
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
  const pool = await ensureDbReady();

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
