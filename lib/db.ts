import { Pool, type QueryResultRow } from "pg";
import { Kysely, PostgresDialect } from "kysely";

import type { OpenDebateDb } from "@/lib/db-schema";
import { createServerLogger } from "@/lib/logger/server";

const dbLogger = createServerLogger("db");

/** Global pool singleton with schema readiness tracking */
const globalPool = globalThis as typeof globalThis & {
  openDebateDb?: Kysely<OpenDebateDb>;
  openDebatePool?: Pool;
  openDebateSchemaReady?: Promise<void>;
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
  globalPool.openDebateSchemaReady = undefined;
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

/** Ensure DB schema is ready and return pool */
export async function ensureDbReady(): Promise<Pool> {
  const pool = getPool();
  if (!globalPool.openDebateSchemaReady) {
    globalPool.openDebateSchemaReady = ensureSchema(pool).catch((error) => {
      if (isRecoverablePoolError(error)) {
        resetDbSingletons(pool);
      } else if (globalPool.openDebatePool === pool) {
        globalPool.openDebateSchemaReady = undefined;
      }
      throw error;
    });
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

export async function ensureDebateAutoRecoverColumns() {
  const pool = await ensureDbReady();
  await pool.query("alter table debates add column if not exists auto_recover_once_on_failed boolean not null default false");
  await pool.query("alter table debates add column if not exists auto_recover_once_used_at timestamptz null");
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

  async function createUniqueIndexIfClean(tableName: string, statement: string, duplicateMessage: string) {
    if (!(await hasTable(tableName))) return;
    try {
      await pool.query(statement);
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        dbLogger.warn(duplicateMessage, { tableName });
        return;
      }
      throw error;
    }
  }

  await alterTableIfExists("users", "alter table users add column if not exists role text not null default 'user'");
  await alterTableIfExists(
    "debates",
    "alter table debates add column if not exists enable_shared_facts boolean not null default true"
  );
  await alterTableIfExists("ai_agents", "alter table ai_agents add column if not exists context_length int null");
  await alterTableIfExists("ai_agents", "alter table ai_agents add column if not exists max_input_tokens int null");
  await alterTableIfExists("ai_agents", "alter table ai_agents add column if not exists max_output_tokens int null");
  await alterTableIfExists("ai_agents", "alter table ai_agents add column if not exists last_connectivity_check_status text null");
  await alterTableIfExists("ai_agents", "alter table ai_agents add column if not exists last_connectivity_check_at timestamptz null");
  await alterTableIfExists("ai_agents", "alter table ai_agents add column if not exists last_connectivity_check_message text null");
  await alterTableIfExists("ai_agents", "alter table ai_agents add column if not exists usage_control_mode text not null default 'none'");
  await alterTableIfExists("ai_agents", "alter table ai_agents add column if not exists quota_profile_id uuid null");
  await alterTableIfExists("ai_agents", "alter table ai_agents add column if not exists deleted_at timestamptz null");
  await pool.query(`
    create table if not exists ai_agent_categories (
      id uuid primary key,
      user_id uuid not null,
      name text not null,
      created_at timestamptz not null,
      updated_at timestamptz not null,
      deleted_at timestamptz null
    )
  `);
  await alterTableIfExists("ai_agents", "alter table ai_agents add column if not exists category_id uuid null");
  await createUniqueIndexIfClean(
    "ai_agent_categories",
    "create unique index if not exists idx_ai_agent_categories_user_name_active on ai_agent_categories (user_id, lower(name)) where deleted_at is null",
    "Skipped unique ai_agent_categories(user_id, lower(name)) index because duplicate active category names need manual cleanup."
  );
  await pool.query("create index if not exists idx_ai_agent_categories_user_updated_at on ai_agent_categories (user_id, updated_at desc)");
  await createIndexIfTableExists("ai_agents", "create index if not exists idx_ai_agents_user_id on ai_agents(user_id)");
  await createIndexIfTableExists(
    "ai_agents",
    "create index if not exists idx_ai_agents_user_active_created_at on ai_agents(user_id, created_at desc) where deleted_at is null"
  );
  await createIndexIfTableExists(
    "ai_agents",
    "create index if not exists idx_ai_agents_user_category_active on ai_agents(user_id, category_id) where deleted_at is null"
  );
  await createIndexIfTableExists("ai_agents", "create index if not exists idx_ai_agents_category_id on ai_agents(category_id)");
  await pool.query(`
    create table if not exists ai_quota_profiles (
      id uuid primary key,
      user_id uuid not null,
      name text not null,
      profile_type text not null,
      request_limit_5h int not null,
      request_limit_week int not null,
      request_limit_month int not null,
      pacing_mode text not null,
      pacing_value int not null,
      reset_timezone text not null default 'Asia/Shanghai',
      next_request_not_before_at timestamptz null,
      created_at timestamptz not null,
      updated_at timestamptz not null,
      deleted_at timestamptz null
    )
  `);
  await pool.query(`
    create table if not exists ai_quota_window_usage (
      id uuid primary key,
      profile_id uuid not null,
      window_type text not null,
      window_start_at timestamptz not null,
      window_end_at timestamptz not null,
      internal_request_count int not null default 0,
      manual_adjustment_count int not null default 0,
      created_at timestamptz not null,
      updated_at timestamptz not null,
      unique (profile_id, window_type, window_start_at)
    )
  `);
  await pool.query(`
    create table if not exists ai_quota_adjustments (
      id uuid primary key,
      profile_id uuid not null,
      window_type text not null,
      delta int not null,
      note text null,
      created_at timestamptz not null
    )
  `);
  await pool.query("create index if not exists idx_ai_quota_profiles_user_id_updated_at on ai_quota_profiles (user_id, updated_at desc)");
  await pool.query("create index if not exists idx_ai_quota_window_usage_profile_type_end on ai_quota_window_usage (profile_id, window_type, window_end_at desc)");
  await pool.query("create index if not exists idx_ai_quota_adjustments_profile_created_at on ai_quota_adjustments (profile_id, created_at desc)");
  await createIndexIfTableExists("ai_agents", "create index if not exists idx_ai_agents_quota_profile_id on ai_agents(quota_profile_id)");
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
  await createIndexIfTableExists(
    "debates",
    "create index if not exists idx_debates_user_created_at on debates(user_id, created_at desc)"
  );
  await createIndexIfTableExists(
    "debates",
    "create index if not exists idx_debates_running_updated_at on debates(updated_at asc, created_at asc) where status = 'running'"
  );
  await createIndexIfTableExists("debate_agents", "create index if not exists idx_debate_agents_ai_agent_id on debate_agents(ai_agent_id)");
  await createUniqueIndexIfClean(
    "debate_turns",
    "create unique index if not exists idx_debate_turns_debate_id_turn_number_unique on debate_turns(debate_id, turn_number)",
    "Skipped unique debate_turns(debate_id, turn_number) index because existing duplicate turns need manual cleanup."
  );
  await createIndexIfTableExists("debate_turns", "create index if not exists idx_debate_turns_ai_agent_id on debate_turns(ai_agent_id)");
  await createIndexIfTableExists("debate_turns", "create index if not exists idx_debate_turns_debate_agent_id on debate_turns(debate_agent_id)");
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
  await createIndexIfTableExists(
    "debate_files",
    "create index if not exists idx_debate_files_debate_id_path_prefix on debate_files(debate_id, path text_pattern_ops)"
  );
  await createIndexIfTableExists(
    "debate_agent_files",
    "create index if not exists idx_debate_agent_files_agent_id_path_prefix on debate_agent_files(debate_agent_id, path text_pattern_ops)"
  );
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
      activity_bucket text generated always as (
        case
          when action = 'write' and reason like 'summarizer:%' then 'summarizer_write'
          when action = 'write' then 'write'
          else 'read'
        end
      ) stored,
      created_at timestamptz not null
    )
  `);
  await alterTableIfExists(
    "debate_file_activity_logs",
    `
      alter table debate_file_activity_logs
      add column if not exists activity_bucket text generated always as (
        case
          when action = 'write' and reason like 'summarizer:%' then 'summarizer_write'
          when action = 'write' then 'write'
          else 'read'
        end
      ) stored
    `
  );
  await pool.query(`
    create table if not exists debate_turn_mutations (
      id uuid primary key,
      debate_id uuid not null,
      debate_agent_id uuid not null,
      turn_number int not null,
      round_number int not null,
      mutation_kind text not null,
      target_path text not null,
      sequence_number int not null,
      status text not null default 'pending',
      before_exists boolean not null default false,
      before_content text null,
      before_version int null,
      before_updated_at timestamptz null,
      before_created_at timestamptz null,
      after_exists boolean not null default false,
      after_content text null,
      after_version int null,
      after_updated_at timestamptz null,
      action_payload_json jsonb null,
      result_json jsonb null,
      created_at timestamptz not null,
      committed_at timestamptz null,
      rolled_back_at timestamptz null
    )
  `);
  await createIndexIfTableExists(
    "debate_turn_mutations",
    "create index if not exists idx_debate_turn_mutations_debate_turn_status on debate_turn_mutations (debate_id, turn_number, status, sequence_number asc)"
  );
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
  await pool.query(`
    create table if not exists playground_tool_checklists (
      id uuid primary key,
      user_id uuid not null,
      agent_id uuid not null,
      tool_name text not null check (
        tool_name in (
          'agent_files_list',
          'agent_files_read',
          'agent_files_search',
          'debate_files_read',
          'debate_files_stat',
          'debate_files_write',
          'debate_vote_open',
          'debate_vote_cast',
          'debate_vote_close',
          'harness_read',
          'harness_write',
          'harness_vote_cast'
        )
      ),
      status text not null check (status in ('idle', 'running', 'passed', 'failed')),
      current_stage text null check (
        current_stage is null or
        current_stage in (
          'queued',
          'requesting_model',
          'receiving_model_output',
          'executing_tools',
          'sandbox_changed',
          'validating_result',
          'passed',
          'failed'
        )
      ),
      stage_started_at timestamptz null,
      stage_index int null,
      stage_history jsonb null,
      last_progress_message text null,
      last_run_at timestamptz null,
      last_passed_at timestamptz null,
      last_error_message text null,
      last_run_trace jsonb null,
      created_at timestamptz not null,
      updated_at timestamptz not null,
      unique (user_id, agent_id, tool_name)
    )
  `);
  await alterTableIfExists("playground_tool_checklists", "alter table playground_tool_checklists add column if not exists current_stage text null");
  await alterTableIfExists("playground_tool_checklists", "alter table playground_tool_checklists add column if not exists stage_started_at timestamptz null");
  await alterTableIfExists("playground_tool_checklists", "alter table playground_tool_checklists add column if not exists stage_index int null");
  await alterTableIfExists("playground_tool_checklists", "alter table playground_tool_checklists add column if not exists stage_history jsonb null");
  await alterTableIfExists("playground_tool_checklists", "alter table playground_tool_checklists add column if not exists last_progress_message text null");
  await pool.query("create index if not exists idx_workspaces_owner_user_id_updated_at on workspaces (owner_user_id, updated_at desc)");
  await pool.query("create index if not exists idx_workspaces_strategy_id_updated_at on workspaces (strategy_id, updated_at desc)");
  await pool.query("create index if not exists idx_workspaces_summary_ai_agent_id on workspaces (summary_ai_agent_id) where summary_ai_agent_id is not null");
  await pool.query("create index if not exists idx_workspace_role_bindings_ai_agent_id on workspace_role_bindings (ai_agent_id) where ai_agent_id is not null");
  await pool.query("create index if not exists idx_workspace_role_bindings_source_strategy_role_id on workspace_role_bindings (source_strategy_role_id) where source_strategy_role_id is not null");
  await pool.query("create index if not exists idx_workspace_files_workspace_id_updated_at on workspace_files (workspace_id, updated_at desc)");
  await pool.query("create index if not exists idx_workspace_files_workspace_id_path_prefix on workspace_files (workspace_id, path text_pattern_ops)");
  await pool.query("create index if not exists idx_strategy_shared_files_strategy_id_updated_at on strategy_shared_files (strategy_id, updated_at desc)");
  await pool.query("create index if not exists idx_strategy_shared_files_strategy_id_path_prefix on strategy_shared_files (strategy_id, path text_pattern_ops)");
  await createIndexIfTableExists(
    "strategy_role_files",
    "create index if not exists idx_strategy_role_files_role_id_path_prefix on strategy_role_files(strategy_role_id, path text_pattern_ops)"
  );
  await createIndexIfTableExists(
    "strategy_role_files",
    "create index if not exists idx_strategy_role_files_role_id_lower_path on strategy_role_files(strategy_role_id, lower(path) text_pattern_ops)"
  );
  await createIndexIfTableExists(
    "ai_agent_files",
    "create index if not exists idx_ai_agent_files_agent_id_path_prefix on ai_agent_files(ai_agent_id, path text_pattern_ops)"
  );
  await pool.query("create index if not exists idx_strategy_file_access_rules_strategy_id_scope on strategy_file_access_rules (strategy_id, scope, updated_at desc)");
  await pool.query("create index if not exists idx_strategy_file_access_rules_role_id on strategy_file_access_rules (strategy_role_id, updated_at desc)");
  await pool.query("create index if not exists idx_playground_tool_checklists_user_agent_updated_at on playground_tool_checklists (user_id, agent_id, updated_at desc)");
  await pool.query("create index if not exists idx_playground_tool_checklists_agent_id on playground_tool_checklists (agent_id)");
  await pool.query("create index if not exists idx_debate_file_activity_logs_debate_id_created_at on debate_file_activity_logs (debate_id, created_at desc, id desc)");
  await pool.query("create index if not exists idx_debate_file_activity_logs_debate_id_action_created_at on debate_file_activity_logs (debate_id, action, created_at desc, id desc)");
  await pool.query("create index if not exists idx_debate_file_activity_logs_debate_bucket on debate_file_activity_logs (debate_id, activity_bucket)");
  await pool.query("create index if not exists idx_debate_file_activity_logs_nav on debate_file_activity_logs (debate_id, debate_agent_id, round_number, turn_number, created_at desc, id desc)");
  await pool.query("create index if not exists idx_debate_file_activity_logs_file_latest on debate_file_activity_logs (debate_id, scope, path, target_debate_agent_id, created_at desc, id desc)");
  await pool.query("create index if not exists idx_debate_file_activity_logs_debate_agent_id on debate_file_activity_logs (debate_agent_id)");
  await pool.query("create index if not exists idx_debate_file_activity_logs_target_debate_agent_id on debate_file_activity_logs (target_debate_agent_id) where target_debate_agent_id is not null");
  await createIndexIfTableExists(
    "debate_file_versions",
    "create index if not exists idx_debate_file_versions_created_by_debate_agent_id on debate_file_versions (created_by_debate_agent_id) where created_by_debate_agent_id is not null"
  );
  await pool.query("drop index if exists idx_debates_user_id");
  await pool.query("drop index if exists idx_debate_agents_debate_id");
  await pool.query("drop index if exists idx_debate_turns_debate_id");
  await pool.query("drop index if exists idx_strategy_roles_strategy_id_role_order");
  await pool.query("drop index if exists idx_workspace_role_bindings_workspace_id_role_order");
  await pool.query("drop index if exists idx_debate_context_chunks_debate_id");
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
    create table if not exists debate_resume_jobs (
      id uuid primary key,
      debate_id uuid not null,
      profile_id uuid not null,
      resume_at timestamptz not null,
      reason text not null default 'quota_wait',
      status text not null default 'pending',
      locked_by text null,
      locked_at timestamptz null,
      last_error text null,
      created_at timestamptz not null,
      updated_at timestamptz not null,
      completed_at timestamptz null
    )
  `);
  await pool.query("create index if not exists idx_debate_resume_jobs_status_resume_at on debate_resume_jobs (status, resume_at asc, updated_at asc)");
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
      if not exists (
        select 1 from pg_constraint where conname = 'playground_tool_checklists_user_id_fkey'
      ) then
        alter table playground_tool_checklists
          add constraint playground_tool_checklists_user_id_fkey
          foreign key (user_id) references users(id) on delete cascade;
      end if;
      if not exists (
        select 1 from pg_constraint where conname = 'playground_tool_checklists_agent_id_fkey'
      ) then
        alter table playground_tool_checklists
          add constraint playground_tool_checklists_agent_id_fkey
          foreign key (agent_id) references ai_agents(id) on delete cascade;
      end if;
      if not exists (
        select 1 from pg_constraint where conname = 'playground_tool_checklists_status_check'
      ) then
        alter table playground_tool_checklists
          add constraint playground_tool_checklists_status_check
          check (status in ('idle', 'running', 'passed', 'failed'));
      end if;
      alter table playground_tool_checklists
        drop constraint if exists playground_tool_checklists_tool_name_check;
      alter table playground_tool_checklists
        add constraint playground_tool_checklists_tool_name_check
        check (
          tool_name in (
            'agent_files_list',
            'agent_files_read',
            'agent_files_search',
            'debate_files_read',
            'debate_files_stat',
            'debate_files_write',
            'debate_vote_open',
            'debate_vote_cast',
            'debate_vote_close',
            'harness_read',
            'harness_write',
            'harness_vote_cast'
          )
        );
      if not exists (
        select 1 from pg_constraint where conname = 'playground_tool_checklists_current_stage_check'
      ) then
        alter table playground_tool_checklists
          add constraint playground_tool_checklists_current_stage_check
          check (
            current_stage is null or
            current_stage in (
              'queued',
              'requesting_model',
              'receiving_model_output',
              'executing_tools',
              'sandbox_changed',
              'validating_result',
              'passed',
              'failed'
            )
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
      if to_regclass('public.debate_context_embeddings') is not null
         and to_regclass('public.debate_context_chunks') is not null then
        execute '
          delete from debate_context_embeddings e
           where not exists (
             select 1 from debate_context_chunks c where c.id = e.chunk_id
           )
        ';
      end if;

      if to_regclass('public.debate_context_embeddings') is not null then
        execute '
          delete from debate_context_embeddings e
           where not exists (
             select 1 from debates d where d.id = e.debate_id
           )
        ';
      end if;

      if to_regclass('public.debate_context_chunks') is not null then
        execute '
          delete from debate_context_chunks c
           where not exists (
             select 1 from debates d where d.id = c.debate_id
           )
        ';
        execute '
          update debate_context_chunks c
             set debate_agent_id = null
           where c.debate_agent_id is not null
             and not exists (
               select 1 from debate_agents da where da.id = c.debate_agent_id
             )
        ';

        if not exists (
          select 1 from pg_constraint where conname = 'debate_context_chunks_debate_id_fkey'
        ) then
          execute '
            alter table debate_context_chunks
              add constraint debate_context_chunks_debate_id_fkey
              foreign key (debate_id) references debates(id) on delete cascade
          ';
        end if;
        if not exists (
          select 1 from pg_constraint where conname = 'debate_context_chunks_debate_agent_id_fkey'
        ) then
          execute '
            alter table debate_context_chunks
              add constraint debate_context_chunks_debate_agent_id_fkey
              foreign key (debate_agent_id) references debate_agents(id) on delete set null
          ';
        end if;

        execute 'create index if not exists idx_debate_context_chunks_debate_updated_at on debate_context_chunks (debate_id, updated_at desc)';
        execute 'create index if not exists idx_debate_context_chunks_source_type on debate_context_chunks (source_type)';
      end if;

      if to_regclass('public.debate_context_embeddings') is not null
         and to_regclass('public.debate_context_chunks') is not null then
        if not exists (
          select 1 from pg_constraint where conname = 'debate_context_embeddings_chunk_id_fkey'
        ) then
          execute '
            alter table debate_context_embeddings
              add constraint debate_context_embeddings_chunk_id_fkey
              foreign key (chunk_id) references debate_context_chunks(id) on delete cascade
          ';
        end if;
        if not exists (
          select 1 from pg_constraint where conname = 'debate_context_embeddings_debate_id_fkey'
        ) then
          execute '
            alter table debate_context_embeddings
              add constraint debate_context_embeddings_debate_id_fkey
              foreign key (debate_id) references debates(id) on delete cascade
          ';
        end if;
      end if;

      if to_regclass('public.retrieval_configs') is not null then
        execute '
          delete from retrieval_configs r
           where not exists (
             select 1 from users u where u.id = r.user_id
           )
        ';
        if not exists (
          select 1 from pg_constraint where conname = 'retrieval_configs_user_id_fkey'
        ) then
          execute '
            alter table retrieval_configs
              add constraint retrieval_configs_user_id_fkey
              foreign key (user_id) references users(id) on delete cascade
          ';
        end if;
      end if;
    exception when undefined_table or duplicate_object then
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
  // Per-seat identity (cannot rely on ai_agents.name because same config can be reused).
  await pool.query("alter table debate_agents add column if not exists display_name text null");
  await pool.query("alter table debates add column if not exists auto_recover_once_on_failed boolean not null default false");
  await pool.query("alter table debates add column if not exists auto_recover_once_used_at timestamptz null");
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
