import type { ColumnType, Generated } from "kysely";

type TimestampString = ColumnType<string, string, string>;
type NullableTimestampString = ColumnType<string | null, string | null | undefined, string | null>;

export type StrategyTable = {
  id: string;
  owner_user_id: string;
  name: string;
  description: string | null;
  is_shared: boolean;
  forked_from_strategy_id: string | null;
  created_at: TimestampString;
  updated_at: TimestampString;
};

export type StrategyRoleTable = {
  id: Generated<string>;
  strategy_id: string;
  name: string;
  system_prompt: string | null;
  role_order: number;
  created_at: TimestampString;
  updated_at: TimestampString;
};

export type StrategyFavoriteTable = {
  user_id: string;
  strategy_id: string;
  created_at: TimestampString;
};

export type StrategyRoleFileTable = {
  id: Generated<string>;
  strategy_role_id: string;
  path: string;
  content: string;
  created_at: TimestampString;
  updated_at: TimestampString;
};

export type StrategySharedFileTable = {
  id: Generated<string>;
  strategy_id: string;
  path: string;
  content: string;
  created_at: TimestampString;
  updated_at: TimestampString;
};

export type StrategyFileAccessRuleTable = {
  id: Generated<string>;
  strategy_id: string;
  strategy_role_id: string | null;
  scope: string;
  target_type: string;
  target_path: string;
  access_mode: string;
  phase_kind: string | null;
  created_at: TimestampString;
  updated_at: TimestampString;
};

export type WorkspaceTable = {
  id: string;
  owner_user_id: string;
  strategy_id: string;
  name: string;
  description: string | null;
  question: string;
  summary_ai_agent_id: string | null;
  default_max_turns: number;
  default_enable_shared_facts: boolean;
  created_at: TimestampString;
  updated_at: TimestampString;
};

export type WorkspaceRoleBindingTable = {
  id: string;
  workspace_id: string;
  source_strategy_role_id: string | null;
  role_name: string;
  role_order: number;
  ai_agent_id: string | null;
  display_name: string | null;
  created_at: TimestampString;
  updated_at: TimestampString;
};

export type WorkspaceFileTable = {
  id: string;
  workspace_id: string;
  path: string;
  content: string;
  created_at: TimestampString;
  updated_at: TimestampString;
};

export type AiAgentTable = {
  id: Generated<string>;
  user_id: string;
  name: string;
  provider: string;
  model: string;
  context_length: number | null;
  max_input_tokens: number | null;
  max_output_tokens: number | null;
  base_url: string;
  api_key_encrypted: string;
  api_key_masked: string;
  last_connectivity_check_status: string | null;
  last_connectivity_check_at: NullableTimestampString;
  last_connectivity_check_message: string | null;
  is_active: boolean;
  created_at: TimestampString;
  updated_at: TimestampString;
  deleted_at: NullableTimestampString;
};

export type AiAgentFileTable = {
  id: Generated<string>;
  ai_agent_id: string;
  path: string;
  content: string;
  created_at: TimestampString;
  updated_at: TimestampString;
};

export type EmailVerificationCodeTable = {
  id: Generated<string>;
  email: string;
  purpose: string;
  code_salt: string;
  code_hash: string;
  sent_to: string;
  ip: string | null;
  user_agent: string | null;
  expires_at: TimestampString;
  created_at: TimestampString;
  consumed_at: NullableTimestampString;
};

export type UserTable = {
  id: string;
  email: string;
  role: string;
};

export type RateLimitCounterTable = {
  key: string;
  window_id: number;
  count: number;
};

export type DebateSummaryJobTable = {
  id: string;
  debate_id: string;
  kind: string;
  status: string;
  job_key: string;
  turn_number: number | null;
  round_number: number | null;
  depends_on_keys: unknown;
  payload_json: unknown;
  priority: number;
  run_after: NullableTimestampString;
  attempt_count: number;
  last_error: string | null;
  next_retry_at: NullableTimestampString;
  locked_by: string | null;
  locked_at: NullableTimestampString;
  created_at: TimestampString;
  updated_at: TimestampString;
  completed_at: NullableTimestampString;
};

export type DebateSummaryWorkerTable = {
  id: string;
  mode: string;
  status: string;
  started_at: TimestampString;
  last_heartbeat_at: TimestampString;
  current_job_id: string | null;
  current_debate_id: string | null;
  current_job_key: string | null;
  claimed_count: number;
  completed_count: number;
  failed_count: number;
  updated_at: TimestampString;
};

export type DebateTable = {
  id: Generated<string>;
  user_id: string;
  source_workspace_id: string | null;
  question: string;
  status: string;
  max_turns: number;
  current_turn: number;
  token_budget: number | null;
  token_used: number;
  enable_shared_facts: boolean;
  is_shared: boolean;
  consensus_reached: boolean;
  consensus_summary: unknown | null;
  workflow_phase_kind: string | null;
  workflow_phase_title: string | null;
  workflow_phase_round: number | null;
  runtime_notice_kind: string | null;
  runtime_notice_message: string | null;
  runtime_notice_at: NullableTimestampString;
  last_error_code: string | null;
  last_error_message: string | null;
  ignored_runtime_error_signature: string | null;
  ignored_runtime_error_at: NullableTimestampString;
  started_at: NullableTimestampString;
  finished_at: NullableTimestampString;
  stopped_reason: string | null;
  created_at: TimestampString;
  updated_at: TimestampString;
};

export type DebateAgentTable = {
  id: Generated<string>;
  debate_id: string;
  ai_agent_id: string;
  display_name: string;
  turn_order: number;
  turn_count: number;
  created_at: TimestampString;
};

export type DebateAgentFileTable = {
  id: Generated<string>;
  debate_agent_id: string;
  path: string;
  content: string;
  created_at: TimestampString;
  updated_at: TimestampString;
};

export type DebateFileTable = {
  id: Generated<string>;
  debate_id: string;
  path: string;
  content: string;
  created_at: TimestampString;
  updated_at: TimestampString;
  version: Generated<number>;
};

export type DebateTurnTable = {
  id: string;
  debate_id: string;
  ai_agent_id: string;
  debate_agent_id: string;
  seat_number: number;
  turn_number: number;
  content: string;
  structured_output: unknown | null;
  parse_status: string;
  token_used: number;
  response_time_ms: number | null;
  retry_count: number;
  error_code: string | null;
  created_at: TimestampString;
};

export type DebateAgentOverrideTable = {
  debate_agent_id: string;
  system_prompt: string | null;
  created_at: TimestampString;
  updated_at: TimestampString;
};

export type RetrievalConfigTable = {
  id: string;
  user_id: string;
  provider: string;
  name: string;
  model: string;
  dimensions: number | null;
  base_url: string;
  api_key_encrypted: string;
  api_key_masked: string;
  is_active: boolean;
  created_at: TimestampString;
  updated_at: TimestampString;
};

export type DebateContextChunkTable = {
  id: string;
  debate_id: string;
  debate_agent_id: string | null;
  chunk_key: string;
  source_type: string;
  source_path: string | null;
  turn_number_start: number | null;
  turn_number_end: number | null;
  round_number: number | null;
  phase_kind: string | null;
  segment_tag: string | null;
  content: string;
  content_hash: string;
  created_at: TimestampString;
  updated_at: TimestampString;
};

export type DebateContextEmbeddingTable = {
  id: string;
  debate_id: string;
  chunk_id: string;
  model: string;
  dimensions: number | null;
  embedding_json: unknown;
  created_at: TimestampString;
  updated_at: TimestampString;
};

export type OpenDebateDb = {
  ai_agents: AiAgentTable;
  ai_agent_files: AiAgentFileTable;
  debate_agent_files: DebateAgentFileTable;
  debate_agent_overrides: DebateAgentOverrideTable;
  debate_agents: DebateAgentTable;
  debate_context_chunks: DebateContextChunkTable;
  debate_context_embeddings: DebateContextEmbeddingTable;
  debate_files: DebateFileTable;
  debate_summary_jobs: DebateSummaryJobTable;
  debate_summary_workers: DebateSummaryWorkerTable;
  debate_turns: DebateTurnTable;
  debates: DebateTable;
  email_verification_codes: EmailVerificationCodeTable;
  rate_limit_counters: RateLimitCounterTable;
  retrieval_configs: RetrievalConfigTable;
  strategies: StrategyTable;
  strategy_favorites: StrategyFavoriteTable;
  strategy_file_access_rules: StrategyFileAccessRuleTable;
  strategy_role_files: StrategyRoleFileTable;
  strategy_shared_files: StrategySharedFileTable;
  strategy_roles: StrategyRoleTable;
  users: UserTable;
  workspace_files: WorkspaceFileTable;
  workspace_role_bindings: WorkspaceRoleBindingTable;
  workspaces: WorkspaceTable;
};
