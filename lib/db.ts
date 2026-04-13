import { Pool, type QueryResultRow } from "pg";
import { Kysely, PostgresDialect } from "kysely";

import type { OpenDebateDb } from "@/lib/db-schema";

/** Global pool singleton with schema readiness tracking */
const globalPool = globalThis as typeof globalThis & {
  openDebateDb?: Kysely<OpenDebateDb>;
  openDebatePool?: Pool;
  openDebateSchemaReady?: Promise<void>;
  openDebateRuntimeRecoveryScheduled?: boolean;
  openDebateSummaryWorkerScheduled?: boolean;
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

function scheduleSummaryJobWorker(reason = "db_ready") {
  if (typeof window !== "undefined") return;
  if (globalPool.openDebateSummaryWorkerScheduled) return;

  globalPool.openDebateSummaryWorkerScheduled = true;
  queueMicrotask(() => {
    void import("@/lib/summary-job-worker")
      .then(({ ensureSummaryJobWorkerStarted }) => ensureSummaryJobWorkerStarted(reason))
      .catch((error) => {
        globalPool.openDebateSummaryWorkerScheduled = false;
        console.error("summary job worker bootstrap failed", error);
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

/** Ensure DB schema is ready and return pool */
export async function ensureDbReady(): Promise<Pool> {
  const pool = getPool();
  if (!globalPool.openDebateSchemaReady) {
    globalPool.openDebateSchemaReady = ensureSchema(pool);
  }
  await globalPool.openDebateSchemaReady;
  scheduleDebateRuntimeRecovery();
  scheduleSummaryJobWorker();
  return pool;
}

export async function ensureDb() {
  await ensureDbReady();
  return getDb();
}

async function ensureSchema(pool: Pool) {
  // Keep this minimal: make new columns backward-compatible with existing volumes.
  async function hasTable(tableName: string) {
    const result = await pool.query<{ oid: string | null }>("select to_regclass($1) as oid", [`public.${tableName}`]);
    return Boolean(result.rows[0]?.oid);
  }

  async function alterTableIfExists(tableName: string, statement: string) {
    if (!(await hasTable(tableName))) return;
    await pool.query(statement);
  }

  async function createIndexIfTableExists(tableName: string, statement: string) {
    if (!(await hasTable(tableName))) return;
    await pool.query(statement);
  }

  await alterTableIfExists("users", "alter table users add column if not exists role text not null default 'user'");
  await alterTableIfExists(
    "debates",
    "alter table debates add column if not exists enable_shared_facts boolean not null default true"
  );
  await alterTableIfExists("ai_agents", "alter table ai_agents add column if not exists context_length int null");
  await alterTableIfExists("ai_agents", "alter table ai_agents add column if not exists max_input_tokens int null");
  await alterTableIfExists("ai_agents", "alter table ai_agents add column if not exists max_output_tokens int null");
  await alterTableIfExists("ai_agents", "alter table ai_agents add column if not exists deleted_at timestamptz null");
  await alterTableIfExists("debates", "alter table debates add column if not exists workflow_phase_kind text null");
  await alterTableIfExists("debates", "alter table debates add column if not exists workflow_phase_title text null");
  await alterTableIfExists("debates", "alter table debates add column if not exists workflow_phase_round int null");
  await alterTableIfExists("debates", "alter table debates add column if not exists runtime_notice_kind text null");
  await alterTableIfExists("debates", "alter table debates add column if not exists runtime_notice_message text null");
  await alterTableIfExists("debates", "alter table debates add column if not exists runtime_notice_at timestamptz null");
  await alterTableIfExists("debates", "alter table debates add column if not exists source_workspace_id uuid null");
  await createIndexIfTableExists(
    "debates",
    "create index if not exists idx_debates_source_workspace_id on debates(source_workspace_id)"
  );
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
  await pool.query(`
    create table if not exists workspaces (
      id uuid primary key,
      owner_user_id uuid not null,
      strategy_id uuid not null,
      name text not null,
      description text null,
      question text not null default '',
      summary_ai_agent_id uuid null,
      default_max_turns int not null default 10,
      default_enable_shared_facts boolean not null default true,
      created_at timestamptz not null,
      updated_at timestamptz not null
    )
  `);
  await pool.query("alter table workspaces add column if not exists default_max_turns int not null default 10");
  await pool.query("alter table workspaces add column if not exists default_enable_shared_facts boolean not null default true");
  await pool.query(`
    create table if not exists workspace_role_bindings (
      id uuid primary key,
      workspace_id uuid not null,
      source_strategy_role_id uuid null,
      role_name text not null,
      role_order int not null,
      ai_agent_id uuid null,
      display_name text null,
      created_at timestamptz not null,
      updated_at timestamptz not null,
      unique (workspace_id, role_order)
    )
  `);
  await pool.query(`
    create table if not exists workspace_files (
      id uuid primary key,
      workspace_id uuid not null,
      path text not null,
      content text not null default '',
      created_at timestamptz not null,
      updated_at timestamptz not null,
      unique (workspace_id, path)
    )
  `);
  await pool.query(`
    create table if not exists strategy_shared_files (
      id uuid primary key,
      strategy_id uuid not null,
      path text not null,
      content text not null default '',
      created_at timestamptz not null,
      updated_at timestamptz not null,
      unique (strategy_id, path)
    )
  `);
  await pool.query(`
    create table if not exists strategy_file_access_rules (
      id uuid primary key,
      strategy_id uuid not null,
      strategy_role_id uuid null,
      scope text not null,
      target_type text not null,
      target_path text not null,
      access_mode text not null,
      phase_kind text null,
      created_at timestamptz not null,
      updated_at timestamptz not null,
      unique (strategy_id, scope, strategy_role_id, target_type, target_path)
    )
  `);
  await pool.query("create index if not exists idx_workspaces_owner_user_id_updated_at on workspaces (owner_user_id, updated_at desc)");
  await pool.query("create index if not exists idx_workspaces_strategy_id_updated_at on workspaces (strategy_id, updated_at desc)");
  await pool.query("create index if not exists idx_workspace_role_bindings_workspace_id_role_order on workspace_role_bindings (workspace_id, role_order asc)");
  await pool.query("create index if not exists idx_workspace_files_workspace_id_updated_at on workspace_files (workspace_id, updated_at desc)");
  await pool.query("create index if not exists idx_strategy_shared_files_strategy_id_updated_at on strategy_shared_files (strategy_id, updated_at desc)");
  await pool.query("create index if not exists idx_strategy_file_access_rules_strategy_id_scope on strategy_file_access_rules (strategy_id, scope, updated_at desc)");
  await pool.query("create index if not exists idx_strategy_file_access_rules_role_id on strategy_file_access_rules (strategy_role_id, updated_at desc)");
  await pool.query("create index if not exists idx_debate_file_activity_logs_debate_id_created_at on debate_file_activity_logs (debate_id, created_at desc, id desc)");
  await pool.query("create index if not exists idx_debate_file_activity_logs_debate_id_action_created_at on debate_file_activity_logs (debate_id, action, created_at desc, id desc)");
  await pool.query("create index if not exists idx_debate_file_activity_logs_nav on debate_file_activity_logs (debate_id, debate_agent_id, round_number, turn_number, created_at desc, id desc)");
  await pool.query(`
    create table if not exists debate_summary_jobs (
      id uuid primary key,
      debate_id uuid not null,
      kind text not null,
      status text not null,
      job_key text not null,
      turn_number int null,
      round_number int null,
      depends_on_keys jsonb not null default '[]'::jsonb,
      payload_json jsonb not null default '{}'::jsonb,
      priority int not null default 100,
      run_after timestamptz null,
      attempt_count int not null default 0,
      last_error text null,
      next_retry_at timestamptz null,
      locked_by text null,
      locked_at timestamptz null,
      created_at timestamptz not null,
      updated_at timestamptz not null,
      completed_at timestamptz null,
      unique (debate_id, job_key)
    )
  `);
  await pool.query("alter table debate_summary_jobs add column if not exists priority int not null default 100");
  await pool.query("alter table debate_summary_jobs add column if not exists run_after timestamptz null");
  await pool.query("create index if not exists idx_debate_summary_jobs_status_retry on debate_summary_jobs (status, next_retry_at asc nulls first, updated_at asc)");
  await pool.query("create index if not exists idx_debate_summary_jobs_runnable on debate_summary_jobs (status, run_after asc nulls first, priority asc, updated_at asc)");
  await pool.query(`
    create index if not exists idx_debate_summary_jobs_active_runnable
      on debate_summary_jobs (status, priority asc, run_after asc nulls first, next_retry_at asc nulls first, updated_at asc)
      where status in ('queued', 'retry_wait', 'blocked', 'running')
  `);
  await pool.query(`
    create index if not exists idx_debate_summary_jobs_running_locked_at
      on debate_summary_jobs (locked_at asc)
      where status = 'running'
  `);
  await pool.query("create index if not exists idx_debate_summary_jobs_debate_status on debate_summary_jobs (debate_id, status, updated_at desc)");
  await pool.query("create index if not exists idx_debate_summary_jobs_kind_round_turn on debate_summary_jobs (debate_id, kind, round_number asc, turn_number asc)");
  await pool.query(`
    create table if not exists debate_summary_workers (
      id text primary key,
      mode text not null default 'embedded',
      status text not null default 'running',
      started_at timestamptz not null,
      last_heartbeat_at timestamptz not null,
      current_job_id uuid null,
      current_debate_id uuid null,
      current_job_key text null,
      claimed_count int not null default 0,
      completed_count int not null default 0,
      failed_count int not null default 0,
      updated_at timestamptz not null
    )
  `);
  await pool.query("create index if not exists idx_debate_summary_workers_last_heartbeat on debate_summary_workers (last_heartbeat_at desc)");
  await pool.query(`
    do $$
    begin
      if not exists (
        select 1 from pg_constraint where conname = 'debate_summary_jobs_debate_id_fkey'
      ) then
        alter table debate_summary_jobs
          add constraint debate_summary_jobs_debate_id_fkey
          foreign key (debate_id) references debates(id) on delete cascade;
      end if;
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
        select 1 from pg_constraint where conname = 'debate_summary_jobs_kind_check'
      ) then
        alter table debate_summary_jobs
          add constraint debate_summary_jobs_kind_check
          check (kind in ('turn_summary', 'round_summary', 'facts_board'));
      end if;
      if not exists (
        select 1 from pg_constraint where conname = 'debate_summary_jobs_status_check'
      ) then
        alter table debate_summary_jobs
          add constraint debate_summary_jobs_status_check
          check (status in ('queued', 'running', 'retry_wait', 'blocked', 'failed', 'completed', 'dead_letter'));
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
      if not exists (
        select 1 from pg_constraint where conname = 'debates_source_workspace_id_fkey'
      ) then
        alter table debates
          add constraint debates_source_workspace_id_fkey
          foreign key (source_workspace_id) references workspaces(id) on delete set null;
      end if;
      if not exists (
        select 1 from pg_constraint where conname = 'workspaces_owner_user_id_fkey'
      ) then
        alter table workspaces
          add constraint workspaces_owner_user_id_fkey
          foreign key (owner_user_id) references users(id) on delete cascade;
      end if;
      if not exists (
        select 1 from pg_constraint where conname = 'workspaces_strategy_id_fkey'
      ) then
        alter table workspaces
          add constraint workspaces_strategy_id_fkey
          foreign key (strategy_id) references strategies(id) on delete cascade;
      end if;
      if not exists (
        select 1 from pg_constraint where conname = 'workspaces_summary_ai_agent_id_fkey'
      ) then
        alter table workspaces
          add constraint workspaces_summary_ai_agent_id_fkey
          foreign key (summary_ai_agent_id) references ai_agents(id) on delete set null;
      end if;
      if not exists (
        select 1 from pg_constraint where conname = 'workspace_role_bindings_workspace_id_fkey'
      ) then
        alter table workspace_role_bindings
          add constraint workspace_role_bindings_workspace_id_fkey
          foreign key (workspace_id) references workspaces(id) on delete cascade;
      end if;
      if not exists (
        select 1 from pg_constraint where conname = 'workspace_role_bindings_source_strategy_role_id_fkey'
      ) then
        alter table workspace_role_bindings
          add constraint workspace_role_bindings_source_strategy_role_id_fkey
          foreign key (source_strategy_role_id) references strategy_roles(id) on delete set null;
      end if;
      if not exists (
        select 1 from pg_constraint where conname = 'workspace_role_bindings_ai_agent_id_fkey'
      ) then
        alter table workspace_role_bindings
          add constraint workspace_role_bindings_ai_agent_id_fkey
          foreign key (ai_agent_id) references ai_agents(id) on delete set null;
      end if;
      if not exists (
        select 1 from pg_constraint where conname = 'workspace_files_workspace_id_fkey'
      ) then
        alter table workspace_files
          add constraint workspace_files_workspace_id_fkey
          foreign key (workspace_id) references workspaces(id) on delete cascade;
      end if;
      if not exists (
        select 1 from pg_constraint where conname = 'strategy_shared_files_strategy_id_fkey'
      ) then
        alter table strategy_shared_files
          add constraint strategy_shared_files_strategy_id_fkey
          foreign key (strategy_id) references strategies(id) on delete cascade;
      end if;
      if not exists (
        select 1 from pg_constraint where conname = 'strategy_file_access_rules_strategy_id_fkey'
      ) then
        alter table strategy_file_access_rules
          add constraint strategy_file_access_rules_strategy_id_fkey
          foreign key (strategy_id) references strategies(id) on delete cascade;
      end if;
      if not exists (
        select 1 from pg_constraint where conname = 'strategy_file_access_rules_strategy_role_id_fkey'
      ) then
        alter table strategy_file_access_rules
          add constraint strategy_file_access_rules_strategy_role_id_fkey
          foreign key (strategy_role_id) references strategy_roles(id) on delete cascade;
      end if;
      if not exists (
        select 1 from pg_constraint where conname = 'strategy_file_access_rules_scope_check'
      ) then
        alter table strategy_file_access_rules
          add constraint strategy_file_access_rules_scope_check
          check (scope in ('shared', 'seat'));
      end if;
      if not exists (
        select 1 from pg_constraint where conname = 'strategy_file_access_rules_target_type_check'
      ) then
        alter table strategy_file_access_rules
          add constraint strategy_file_access_rules_target_type_check
          check (target_type in ('file', 'dir'));
      end if;
      if not exists (
        select 1 from pg_constraint where conname = 'strategy_file_access_rules_access_mode_check'
      ) then
        alter table strategy_file_access_rules
          add constraint strategy_file_access_rules_access_mode_check
          check (access_mode in ('always_read', 'read_when_needed', 'unlock_after_phase'));
      end if;
      if not exists (
        select 1 from pg_constraint where conname = 'strategy_file_access_rules_phase_kind_check'
      ) then
        alter table strategy_file_access_rules
          add constraint strategy_file_access_rules_phase_kind_check
          check (phase_kind is null or phase_kind in ('analysis', 'deliberation', 'finalization_vote', 'finalization'));
      end if;
      if not exists (
        select 1 from pg_constraint where conname = 'strategy_file_access_rules_scope_role_check'
      ) then
        alter table strategy_file_access_rules
          add constraint strategy_file_access_rules_scope_role_check
          check (
            (scope = 'shared' and strategy_role_id is null) or
            (scope = 'seat' and strategy_role_id is not null)
          );
      end if;
      if not exists (
        select 1 from pg_constraint where conname = 'strategy_file_access_rules_unlock_scope_check'
      ) then
        alter table strategy_file_access_rules
          add constraint strategy_file_access_rules_unlock_scope_check
          check (
            access_mode <> 'unlock_after_phase' or
            (scope = 'shared' and phase_kind is not null)
          );
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
    exception when undefined_table or duplicate_object then
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
