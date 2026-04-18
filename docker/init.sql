create extension if not exists pgcrypto;

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  password_hash text not null,
  role text not null default 'user',
  email_verified boolean not null default false,
  failed_login_attempts integer not null default 0,
  locked_until timestamptz null,
  last_failed_login_at timestamptz null,
  last_login_at timestamptz null,
  last_login_ip text null,
  created_at timestamptz not null default now()
);

-- Backfill / upgrade existing databases created before these columns existed.
alter table users add column if not exists role text not null default 'user';
alter table users add column if not exists email_verified boolean not null default false;
alter table users add column if not exists failed_login_attempts integer not null default 0;
alter table users add column if not exists locked_until timestamptz null;
alter table users add column if not exists last_failed_login_at timestamptz null;
alter table users add column if not exists last_login_at timestamptz null;
alter table users add column if not exists last_login_ip text null;

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

create table if not exists email_verification_codes (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  purpose text not null check (purpose in ('signup')),
  code_salt text not null,
  code_hash text not null,
  sent_to text not null,
  ip text null,
  user_agent text null,
  expires_at timestamptz not null,
  consumed_at timestamptz null,
  created_at timestamptz not null default now()
);

create index if not exists idx_email_verification_codes_email_created_at
  on email_verification_codes (email, created_at desc);
create index if not exists idx_email_verification_codes_expires_at
  on email_verification_codes (expires_at);

create table if not exists ai_agents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  name text not null,
  provider text not null check (provider in ('openai', 'anthropic')),
  model text not null,
  context_length integer null,
  max_input_tokens integer null,
  max_output_tokens integer null,
  base_url text not null,
  api_key_encrypted text not null,
  api_key_masked text not null,
  last_connectivity_check_status text null,
  last_connectivity_check_at timestamptz null,
  last_connectivity_check_message text null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table ai_agents add column if not exists context_length integer null;
alter table ai_agents add column if not exists max_input_tokens integer null;
alter table ai_agents add column if not exists max_output_tokens integer null;
alter table ai_agents add column if not exists last_connectivity_check_status text null;
alter table ai_agents add column if not exists last_connectivity_check_at timestamptz null;
alter table ai_agents add column if not exists last_connectivity_check_message text null;

create table if not exists debates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  source_workspace_id uuid null,
  question text not null,
  status text not null check (status in ('pending', 'running', 'paused', 'completed', 'stopped', 'failed')),
  max_turns integer not null default 10,
  current_turn integer not null default 0,
  token_budget integer null,
  token_used integer not null default 0,
  enable_shared_facts boolean not null default true,
  is_shared boolean not null default false,
  consensus_reached boolean not null default false,
  consensus_summary jsonb null,
  workflow_phase_kind text null,
  workflow_phase_title text null,
  workflow_phase_round integer null,
  runtime_notice_kind text null,
  runtime_notice_message text null,
  runtime_notice_at timestamptz null,
  last_error_code text null,
  last_error_message text null,
  started_at timestamptz null,
  finished_at timestamptz null,
  stopped_reason text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table debates add column if not exists workflow_phase_kind text null;
alter table debates add column if not exists workflow_phase_title text null;
alter table debates add column if not exists workflow_phase_round integer null;
alter table debates add column if not exists runtime_notice_kind text null;
alter table debates add column if not exists runtime_notice_message text null;
alter table debates add column if not exists runtime_notice_at timestamptz null;
alter table debates add column if not exists source_workspace_id uuid null;

create table if not exists debate_agents (
  id uuid primary key default gen_random_uuid(),
  debate_id uuid not null references debates(id) on delete cascade,
  ai_agent_id uuid not null references ai_agents(id) on delete restrict,
  display_name text not null,
  turn_order integer not null,
  turn_count integer not null default 0,
  created_at timestamptz not null default now(),
  unique (debate_id, turn_order)
);

create table if not exists debate_turns (
  id uuid primary key default gen_random_uuid(),
  debate_id uuid not null references debates(id) on delete cascade,
  ai_agent_id uuid not null references ai_agents(id) on delete restrict,
  debate_agent_id uuid not null references debate_agents(id) on delete restrict,
  seat_number integer not null,
  turn_number integer not null,
  content text not null,
  structured_output jsonb null,
  parse_status text not null default 'ok' check (parse_status in ('ok', 'fallback')),
  token_used integer not null default 0,
  response_time_ms integer null,
  retry_count integer not null default 0,
  error_code text null,
  created_at timestamptz not null default now()
);

create index if not exists idx_ai_agents_user_id on ai_agents(user_id);
create index if not exists idx_debates_user_id on debates(user_id);
create index if not exists idx_debates_source_workspace_id on debates(source_workspace_id);
create index if not exists idx_debates_is_shared_updated_at on debates(is_shared, updated_at desc);
create index if not exists idx_debate_agents_debate_id on debate_agents(debate_id);
create index if not exists idx_debate_turns_debate_id on debate_turns(debate_id);

create table if not exists rate_limit_counters (
  key text not null,
  window_id bigint not null,
  count integer not null,
  created_at timestamptz not null default now(),
  primary key (key, window_id)
);

create index if not exists idx_rate_limit_counters_created_at
  on rate_limit_counters (created_at desc);

create table if not exists ai_agent_files (
  id uuid primary key default gen_random_uuid(),
  ai_agent_id uuid not null references ai_agents(id) on delete cascade,
  path text not null,
  content text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (ai_agent_id, path)
);

create index if not exists idx_ai_agent_files_agent_id_updated_at
  on ai_agent_files (ai_agent_id, updated_at desc);

create table if not exists strategies (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references users(id) on delete cascade,
  name text not null,
  description text null,
  is_shared boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table strategies
  add column if not exists forked_from_strategy_id uuid null references strategies(id) on delete set null;

create index if not exists idx_strategies_owner_user_id_updated_at
  on strategies (owner_user_id, updated_at desc);
create index if not exists idx_strategies_is_shared_updated_at
  on strategies (is_shared, updated_at desc);
create index if not exists idx_strategies_forked_from_strategy_id
  on strategies (forked_from_strategy_id);

create table if not exists strategy_favorites (
  user_id uuid not null references users(id) on delete cascade,
  strategy_id uuid not null references strategies(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, strategy_id)
);

create index if not exists idx_strategy_favorites_strategy_id_created_at
  on strategy_favorites (strategy_id, created_at desc);

create table if not exists strategy_roles (
  id uuid primary key default gen_random_uuid(),
  strategy_id uuid not null references strategies(id) on delete cascade,
  name text not null,
  system_prompt text null,
  role_order integer not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (strategy_id, role_order)
);

create index if not exists idx_strategy_roles_strategy_id_role_order
  on strategy_roles (strategy_id, role_order);

create table if not exists strategy_role_files (
  id uuid primary key default gen_random_uuid(),
  strategy_role_id uuid not null references strategy_roles(id) on delete cascade,
  path text not null,
  content text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (strategy_role_id, path)
);

create index if not exists idx_strategy_role_files_role_id_updated_at
  on strategy_role_files (strategy_role_id, updated_at desc);

create table if not exists workspaces (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references users(id) on delete cascade,
  strategy_id uuid not null references strategies(id) on delete cascade,
  name text not null,
  description text null,
  question text not null default '',
  summary_ai_agent_id uuid null references ai_agents(id) on delete set null,
  default_max_turns integer not null default 10,
  default_enable_shared_facts boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table workspaces add column if not exists default_max_turns integer not null default 10;
alter table workspaces add column if not exists default_enable_shared_facts boolean not null default true;

create index if not exists idx_workspaces_owner_user_id_updated_at
  on workspaces (owner_user_id, updated_at desc);
create index if not exists idx_workspaces_strategy_id_updated_at
  on workspaces (strategy_id, updated_at desc);

create table if not exists workspace_role_bindings (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  source_strategy_role_id uuid null references strategy_roles(id) on delete set null,
  role_name text not null,
  role_order integer not null,
  ai_agent_id uuid null references ai_agents(id) on delete set null,
  display_name text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, role_order)
);

create index if not exists idx_workspace_role_bindings_workspace_id_role_order
  on workspace_role_bindings (workspace_id, role_order asc);

create table if not exists workspace_files (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  path text not null,
  content text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, path)
);

create index if not exists idx_workspace_files_workspace_id_updated_at
  on workspace_files (workspace_id, updated_at desc);

create table if not exists debate_agent_overrides (
  debate_agent_id uuid primary key references debate_agents(id) on delete cascade,
  system_prompt text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists debate_agent_files (
  id uuid primary key default gen_random_uuid(),
  debate_agent_id uuid not null references debate_agents(id) on delete cascade,
  path text not null,
  content text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (debate_agent_id, path)
);

create index if not exists idx_debate_agent_files_agent_id_updated_at
  on debate_agent_files (debate_agent_id, updated_at desc);

create table if not exists debate_files (
  id uuid primary key default gen_random_uuid(),
  debate_id uuid not null references debates(id) on delete cascade,
  path text not null,
  content text not null default '',
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (debate_id, path)
);

create index if not exists idx_debate_files_debate_id_updated_at
  on debate_files (debate_id, updated_at desc);

create table if not exists debate_summary_jobs (
  id uuid primary key default gen_random_uuid(),
  debate_id uuid not null references debates(id) on delete cascade,
  kind text not null check (kind in ('turn_summary', 'round_summary', 'facts_board')),
  status text not null check (status in ('queued', 'running', 'retry_wait', 'blocked', 'failed', 'completed', 'dead_letter')),
  job_key text not null,
  turn_number integer null,
  round_number integer null,
  depends_on_keys jsonb not null default '[]'::jsonb,
  payload_json jsonb not null default '{}'::jsonb,
  attempt_count integer not null default 0,
  last_error text null,
  next_retry_at timestamptz null,
  locked_by text null,
  locked_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz null,
  unique (debate_id, job_key)
);

create index if not exists idx_debate_summary_jobs_status_retry
  on debate_summary_jobs (status, next_retry_at asc nulls first, updated_at asc);
create index if not exists idx_debate_summary_jobs_debate_status
  on debate_summary_jobs (debate_id, status, updated_at desc);
create index if not exists idx_debate_summary_jobs_kind_round_turn
  on debate_summary_jobs (debate_id, kind, round_number asc, turn_number asc);

create table if not exists debate_file_versions (
  id uuid primary key default gen_random_uuid(),
  debate_id uuid not null references debates(id) on delete cascade,
  path text not null,
  version int not null,
  content text not null default '',
  mode text not null,
  reason text null,
  base_version int null,
  created_by_debate_agent_id uuid null references debate_agents(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (debate_id, path, version)
);

create index if not exists idx_debate_file_versions_debate_id_path_version
  on debate_file_versions (debate_id, path, version desc);

create table if not exists debate_file_activity_logs (
  id uuid primary key default gen_random_uuid(),
  debate_id uuid not null references debates(id) on delete cascade,
  debate_agent_id uuid not null references debate_agents(id) on delete cascade,
  turn_number int not null,
  round_number int not null,
  action text not null check (action in ('read', 'write', 'search', 'list', 'stat')),
  scope text not null check (scope in ('debate', 'agent')),
  path text not null,
  target_debate_agent_id uuid null references debate_agents(id) on delete set null,
  write_mode text null,
  before_version int null,
  after_version int null,
  before_content text null,
  after_content text null,
  target_heading text null,
  reason text null,
  created_at timestamptz not null default now()
);

create index if not exists idx_debate_file_activity_logs_debate_id_created_at
  on debate_file_activity_logs (debate_id, created_at desc, id desc);

create index if not exists idx_debate_file_activity_logs_debate_id_action_created_at
  on debate_file_activity_logs (debate_id, action, created_at desc, id desc);
