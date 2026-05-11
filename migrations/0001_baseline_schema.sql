create extension if not exists pgcrypto;
create extension if not exists pg_stat_statements;

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

create table if not exists user_feedback (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  category text not null default 'suggestion' check (category in ('suggestion', 'bug', 'question', 'other')),
  title text not null,
  message text not null,
  status text not null default 'new' check (status in ('new', 'reviewed', 'closed')),
  reviewed_by_user_id uuid null references users(id) on delete set null,
  reviewed_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table user_feedback drop column if exists page_path;
alter table user_feedback add column if not exists status text not null default 'new';
alter table user_feedback add column if not exists reviewed_by_user_id uuid null;
alter table user_feedback add column if not exists reviewed_at timestamptz null;

create index if not exists idx_user_feedback_created_at
  on user_feedback (created_at desc, id desc);
create index if not exists idx_user_feedback_user_created_at
  on user_feedback (user_id, created_at desc);
create index if not exists idx_user_feedback_status_created_at
  on user_feedback (status, created_at desc);

create table if not exists ai_agent_categories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz null
);

do $$
begin
  begin
    create unique index if not exists idx_ai_agent_categories_user_name_active
      on ai_agent_categories (user_id, lower(name))
      where deleted_at is null;
  exception when unique_violation then
    raise warning 'Skipped idx_ai_agent_categories_user_name_active because duplicate active category names exist.';
  end;
end $$;

create index if not exists idx_ai_agent_categories_user_updated_at
  on ai_agent_categories (user_id, updated_at desc);

create table if not exists ai_agents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  name text not null,
  category_id uuid null references ai_agent_categories(id) on delete set null,
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
  usage_control_mode text not null default 'none' check (usage_control_mode in ('none', 'coding_plan')),
  quota_profile_id uuid null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table ai_agents add column if not exists category_id uuid null;
alter table ai_agents add column if not exists context_length integer null;
alter table ai_agents add column if not exists max_input_tokens integer null;
alter table ai_agents add column if not exists max_output_tokens integer null;
alter table ai_agents add column if not exists last_connectivity_check_status text null;
alter table ai_agents add column if not exists last_connectivity_check_at timestamptz null;
alter table ai_agents add column if not exists last_connectivity_check_message text null;
alter table ai_agents add column if not exists usage_control_mode text not null default 'none';
alter table ai_agents add column if not exists quota_profile_id uuid null;
alter table ai_agents add column if not exists deleted_at timestamptz null;

create table if not exists ai_quota_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  name text not null,
  profile_type text not null default 'coding_plan' check (profile_type in ('coding_plan')),
  request_limit_5h integer not null,
  request_limit_week integer not null,
  request_limit_month integer not null,
  pacing_mode text not null check (pacing_mode in ('percent', 'absolute')),
  pacing_value integer not null,
  reset_timezone text not null default 'Asia/Shanghai',
  next_request_not_before_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz null
);

create index if not exists idx_ai_quota_profiles_user_id_updated_at
  on ai_quota_profiles (user_id, updated_at desc);

create table if not exists ai_quota_window_usage (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references ai_quota_profiles(id) on delete cascade,
  window_type text not null check (window_type in ('rolling_5h', 'week', 'month')),
  window_start_at timestamptz not null,
  window_end_at timestamptz not null,
  internal_request_count integer not null default 0,
  manual_adjustment_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (profile_id, window_type, window_start_at)
);

create index if not exists idx_ai_quota_window_usage_profile_type_end
  on ai_quota_window_usage (profile_id, window_type, window_end_at desc);

create table if not exists ai_quota_adjustments (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references ai_quota_profiles(id) on delete cascade,
  window_type text not null check (window_type in ('rolling_5h', 'week', 'month')),
  delta integer not null,
  note text null,
  created_at timestamptz not null default now()
);

create index if not exists idx_ai_quota_adjustments_profile_created_at
  on ai_quota_adjustments (profile_id, created_at desc);

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
  ignored_runtime_error_signature text null,
  ignored_runtime_error_at timestamptz null,
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
alter table debates add column if not exists enable_shared_facts boolean not null default true;
alter table debates add column if not exists is_shared boolean not null default false;
alter table debates add column if not exists consensus_reached boolean not null default false;
alter table debates add column if not exists consensus_summary jsonb null;
alter table debates add column if not exists last_error_code text null;
alter table debates add column if not exists last_error_message text null;
alter table debates add column if not exists ignored_runtime_error_signature text null;
alter table debates add column if not exists ignored_runtime_error_at timestamptz null;
alter table debates add column if not exists auto_recover_once_on_failed boolean not null default false;
alter table debates add column if not exists auto_recover_once_used_at timestamptz null;

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

alter table debate_agents add column if not exists display_name text null;

update debate_agents
   set display_name = concat('Seat-', turn_order)
 where display_name is null;

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

alter table debate_turns add column if not exists debate_agent_id uuid null;
alter table debate_turns add column if not exists seat_number integer null;

create index if not exists idx_ai_agents_user_id on ai_agents(user_id);
create index if not exists idx_ai_agents_user_active_created_at
  on ai_agents(user_id, created_at desc)
  where deleted_at is null;
create index if not exists idx_ai_agents_user_category_active
  on ai_agents(user_id, category_id)
  where deleted_at is null;
create index if not exists idx_debates_user_created_at on debates(user_id, created_at desc);
create index if not exists idx_debates_running_updated_at
  on debates(updated_at asc, created_at asc)
  where status = 'running';
create index if not exists idx_debates_source_workspace_id on debates(source_workspace_id);
create index if not exists idx_debates_is_shared_updated_at on debates(is_shared, updated_at desc);
do $$
begin
  begin
    create unique index if not exists idx_debate_turns_debate_id_turn_number_unique on debate_turns(debate_id, turn_number);
  exception when unique_violation then
    raise warning 'Skipped idx_debate_turns_debate_id_turn_number_unique because duplicate turns exist.';
  end;
end $$;
create index if not exists idx_debate_agents_ai_agent_id on debate_agents(ai_agent_id);
create index if not exists idx_debate_turns_ai_agent_id on debate_turns(ai_agent_id);
create index if not exists idx_debate_turns_debate_agent_id on debate_turns(debate_agent_id);
create index if not exists idx_ai_agents_quota_profile_id on ai_agents(quota_profile_id);
create index if not exists idx_ai_agents_category_id on ai_agents(category_id);

create table if not exists debate_turn_mutations (
  id uuid primary key default gen_random_uuid(),
  debate_id uuid not null references debates(id) on delete cascade,
  debate_agent_id uuid not null references debate_agents(id) on delete cascade,
  turn_number integer not null,
  round_number integer not null,
  mutation_kind text not null check (mutation_kind in ('write_replace', 'write_append', 'write_section', 'vote_cast')),
  target_path text not null,
  sequence_number integer not null,
  status text not null default 'pending' check (status in ('pending', 'committed', 'rolled_back')),
  before_exists boolean not null default false,
  before_content text null,
  before_version integer null,
  before_updated_at timestamptz null,
  before_created_at timestamptz null,
  after_exists boolean not null default false,
  after_content text null,
  after_version integer null,
  after_updated_at timestamptz null,
  action_payload_json jsonb null,
  result_json jsonb null,
  created_at timestamptz not null default now(),
  committed_at timestamptz null,
  rolled_back_at timestamptz null
);

create index if not exists idx_debate_turn_mutations_debate_turn_status
  on debate_turn_mutations (debate_id, turn_number, status, sequence_number asc);

create table if not exists debate_resume_jobs (
  id uuid primary key default gen_random_uuid(),
  debate_id uuid not null references debates(id) on delete cascade,
  profile_id uuid not null references ai_quota_profiles(id) on delete cascade,
  resume_at timestamptz not null,
  reason text not null default 'quota_wait',
  status text not null default 'pending' check (status in ('pending', 'running', 'completed', 'failed')),
  locked_by text null,
  locked_at timestamptz null,
  last_error text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz null
);

create index if not exists idx_debate_resume_jobs_status_resume_at
  on debate_resume_jobs (status, resume_at asc, updated_at asc);

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
create index if not exists idx_ai_agent_files_agent_id_path_prefix
  on ai_agent_files (ai_agent_id, path text_pattern_ops);

create table if not exists playground_tool_checklists (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  agent_id uuid not null references ai_agents(id) on delete cascade,
  tool_name text not null check (tool_name in (
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
  )),
  status text not null default 'idle' check (status in ('idle', 'running', 'passed', 'failed')),
  current_stage text null check (current_stage in (
    'queued',
    'requesting_model',
    'receiving_model_output',
    'executing_tools',
    'sandbox_changed',
    'validating_result',
    'passed',
    'failed'
  )),
  stage_started_at timestamptz null,
  stage_index integer null,
  stage_history jsonb null,
  last_progress_message text null,
  last_run_at timestamptz null,
  last_passed_at timestamptz null,
  last_error_message text null,
  last_run_trace jsonb null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, agent_id, tool_name)
);

alter table playground_tool_checklists add column if not exists current_stage text null;
alter table playground_tool_checklists add column if not exists stage_started_at timestamptz null;
alter table playground_tool_checklists add column if not exists stage_index integer null;
alter table playground_tool_checklists add column if not exists stage_history jsonb null;
alter table playground_tool_checklists add column if not exists last_progress_message text null;

create index if not exists idx_playground_tool_checklists_user_agent_updated_at
  on playground_tool_checklists (user_id, agent_id, updated_at desc);
create index if not exists idx_playground_tool_checklists_agent_id
  on playground_tool_checklists (agent_id);

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
alter table strategies add column if not exists is_shared boolean not null default false;

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
create index if not exists idx_strategy_role_files_role_id_path_prefix
  on strategy_role_files (strategy_role_id, path text_pattern_ops);
create index if not exists idx_strategy_role_files_role_id_lower_path
  on strategy_role_files (strategy_role_id, lower(path) text_pattern_ops);

create table if not exists strategy_shared_files (
  id uuid primary key default gen_random_uuid(),
  strategy_id uuid not null references strategies(id) on delete cascade,
  path text not null,
  content text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (strategy_id, path)
);

create index if not exists idx_strategy_shared_files_strategy_id_updated_at
  on strategy_shared_files (strategy_id, updated_at desc);
create index if not exists idx_strategy_shared_files_strategy_id_path_prefix
  on strategy_shared_files (strategy_id, path text_pattern_ops);

create table if not exists strategy_file_access_rules (
  id uuid primary key default gen_random_uuid(),
  strategy_id uuid not null references strategies(id) on delete cascade,
  strategy_role_id uuid null references strategy_roles(id) on delete cascade,
  scope text not null check (scope in ('shared', 'seat')),
  target_type text not null check (target_type in ('file', 'dir')),
  target_path text not null,
  access_mode text not null check (access_mode in ('always_read', 'read_when_needed', 'unlock_after_phase')),
  phase_kind text null check (phase_kind is null or phase_kind in ('analysis', 'deliberation', 'finalization_vote', 'finalization')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (strategy_id, scope, strategy_role_id, target_type, target_path),
  check (scope = 'seat' or strategy_role_id is null),
  check (scope = 'shared' or strategy_role_id is not null),
  check (access_mode <> 'unlock_after_phase' or (scope = 'shared' and phase_kind is not null))
);

create index if not exists idx_strategy_file_access_rules_strategy_id_scope
  on strategy_file_access_rules (strategy_id, scope, updated_at desc);
create index if not exists idx_strategy_file_access_rules_role_id
  on strategy_file_access_rules (strategy_role_id, updated_at desc);

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
alter table workspaces add column if not exists question text not null default '';
alter table workspaces add column if not exists summary_ai_agent_id uuid null;

create index if not exists idx_workspaces_owner_user_id_updated_at
  on workspaces (owner_user_id, updated_at desc);
create index if not exists idx_workspaces_strategy_id_updated_at
  on workspaces (strategy_id, updated_at desc);
create index if not exists idx_workspaces_summary_ai_agent_id
  on workspaces (summary_ai_agent_id)
  where summary_ai_agent_id is not null;

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

alter table workspace_role_bindings add column if not exists source_strategy_role_id uuid null;
alter table workspace_role_bindings add column if not exists ai_agent_id uuid null;
alter table workspace_role_bindings add column if not exists display_name text null;

create index if not exists idx_workspace_role_bindings_ai_agent_id
  on workspace_role_bindings (ai_agent_id)
  where ai_agent_id is not null;
create index if not exists idx_workspace_role_bindings_source_strategy_role_id
  on workspace_role_bindings (source_strategy_role_id)
  where source_strategy_role_id is not null;

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
create index if not exists idx_workspace_files_workspace_id_path_prefix
  on workspace_files (workspace_id, path text_pattern_ops);

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
create index if not exists idx_debate_agent_files_agent_id_path_prefix
  on debate_agent_files (debate_agent_id, path text_pattern_ops);

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

alter table debate_files add column if not exists version int not null default 1;

create index if not exists idx_debate_files_debate_id_updated_at
  on debate_files (debate_id, updated_at desc);
create index if not exists idx_debate_files_debate_id_path_prefix
  on debate_files (debate_id, path text_pattern_ops);

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
  priority integer not null default 100,
  run_after timestamptz null,
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

alter table debate_summary_jobs add column if not exists priority integer not null default 100;
alter table debate_summary_jobs add column if not exists run_after timestamptz null;

create index if not exists idx_debate_summary_jobs_status_retry
  on debate_summary_jobs (status, next_retry_at asc nulls first, updated_at asc);
create index if not exists idx_debate_summary_jobs_runnable
  on debate_summary_jobs (status, run_after asc nulls first, priority asc, updated_at asc);
create index if not exists idx_debate_summary_jobs_active_runnable
  on debate_summary_jobs (status, priority asc, run_after asc nulls first, next_retry_at asc nulls first, updated_at asc)
  where status in ('queued', 'retry_wait', 'blocked', 'running');
create index if not exists idx_debate_summary_jobs_running_locked_at
  on debate_summary_jobs (locked_at asc)
  where status = 'running';
create index if not exists idx_debate_summary_jobs_debate_status
  on debate_summary_jobs (debate_id, status, updated_at desc);
create index if not exists idx_debate_summary_jobs_kind_round_turn
  on debate_summary_jobs (debate_id, kind, round_number asc, turn_number asc);

create table if not exists debate_summary_workers (
  id text primary key,
  mode text not null default 'embedded',
  status text not null default 'running',
  started_at timestamptz not null default now(),
  last_heartbeat_at timestamptz not null default now(),
  current_job_id uuid null,
  current_debate_id uuid null references debates(id) on delete set null,
  current_job_key text null,
  claimed_count integer not null default 0,
  completed_count integer not null default 0,
  failed_count integer not null default 0,
  updated_at timestamptz not null default now()
);

create index if not exists idx_debate_summary_workers_last_heartbeat
  on debate_summary_workers (last_heartbeat_at desc);

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
  activity_bucket text generated always as (
    case
      when action = 'write' and reason like 'summarizer:%' then 'summarizer_write'
      when action = 'write' then 'write'
      else 'read'
    end
  ) stored,
  created_at timestamptz not null default now()
);

alter table debate_file_activity_logs add column if not exists target_debate_agent_id uuid null;
alter table debate_file_activity_logs add column if not exists write_mode text null;
alter table debate_file_activity_logs add column if not exists before_version int null;
alter table debate_file_activity_logs add column if not exists after_version int null;
alter table debate_file_activity_logs add column if not exists before_content text null;
alter table debate_file_activity_logs add column if not exists after_content text null;
alter table debate_file_activity_logs add column if not exists target_heading text null;
alter table debate_file_activity_logs add column if not exists reason text null;
alter table debate_file_activity_logs
  add column if not exists activity_bucket text generated always as (
    case
      when action = 'write' and reason like 'summarizer:%' then 'summarizer_write'
      when action = 'write' then 'write'
      else 'read'
    end
  ) stored;

create index if not exists idx_debate_file_activity_logs_debate_id_created_at
  on debate_file_activity_logs (debate_id, created_at desc, id desc);

create index if not exists idx_debate_file_activity_logs_debate_id_action_created_at
  on debate_file_activity_logs (debate_id, action, created_at desc, id desc);
create index if not exists idx_debate_file_activity_logs_debate_bucket
  on debate_file_activity_logs (debate_id, activity_bucket);
create index if not exists idx_debate_file_activity_logs_nav
  on debate_file_activity_logs (debate_id, debate_agent_id, round_number, turn_number, created_at desc, id desc);
create index if not exists idx_debate_file_activity_logs_file_latest
  on debate_file_activity_logs (debate_id, scope, path, target_debate_agent_id, created_at desc, id desc);
create index if not exists idx_debate_file_activity_logs_debate_agent_id
  on debate_file_activity_logs (debate_agent_id);
create index if not exists idx_debate_file_activity_logs_target_debate_agent_id
  on debate_file_activity_logs (target_debate_agent_id)
  where target_debate_agent_id is not null;
create index if not exists idx_debate_file_versions_created_by_debate_agent_id
  on debate_file_versions (created_by_debate_agent_id)
  where created_by_debate_agent_id is not null;
