create extension if not exists pgcrypto;

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  password_hash text not null,
  email_verified boolean not null default false,
  failed_login_attempts integer not null default 0,
  locked_until timestamptz null,
  last_failed_login_at timestamptz null,
  last_login_at timestamptz null,
  last_login_ip text null,
  created_at timestamptz not null default now()
);

-- Backfill / upgrade existing databases created before these columns existed.
alter table users add column if not exists email_verified boolean not null default false;
alter table users add column if not exists failed_login_attempts integer not null default 0;
alter table users add column if not exists locked_until timestamptz null;
alter table users add column if not exists last_failed_login_at timestamptz null;
alter table users add column if not exists last_login_at timestamptz null;
alter table users add column if not exists last_login_ip text null;

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
  base_url text not null,
  api_key_encrypted text not null,
  api_key_masked text not null,
  system_prompt text null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists debates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  question text not null,
  status text not null check (status in ('pending', 'running', 'paused', 'completed', 'stopped', 'failed')),
  max_turns integer not null default 10,
  current_turn integer not null default 0,
  token_budget integer null,
  token_used integer not null default 0,
  consensus_reached boolean not null default false,
  consensus_summary jsonb null,
  last_error_code text null,
  last_error_message text null,
  started_at timestamptz null,
  finished_at timestamptz null,
  stopped_reason text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists debate_agents (
  id uuid primary key default gen_random_uuid(),
  debate_id uuid not null references debates(id) on delete cascade,
  ai_agent_id uuid not null references ai_agents(id) on delete restrict,
  turn_order integer not null,
  turn_count integer not null default 0,
  created_at timestamptz not null default now(),
  unique (debate_id, ai_agent_id),
  unique (debate_id, turn_order)
);

create table if not exists debate_turns (
  id uuid primary key default gen_random_uuid(),
  debate_id uuid not null references debates(id) on delete cascade,
  ai_agent_id uuid not null references ai_agents(id) on delete restrict,
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
