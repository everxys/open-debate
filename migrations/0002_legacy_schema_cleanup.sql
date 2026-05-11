drop index if exists idx_debates_user_id;
drop index if exists idx_debate_agents_debate_id;
drop index if exists idx_debate_turns_debate_id;
drop index if exists idx_strategy_roles_strategy_id_role_order;
drop index if exists idx_workspace_role_bindings_workspace_id_role_order;
drop index if exists idx_debate_context_chunks_debate_id;

do $$
begin
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
exception when undefined_table or duplicate_object then
  null;
end $$;

do $$
begin
  alter table debate_file_activity_logs
    drop constraint if exists debate_file_activity_logs_action_check;

  alter table debate_file_activity_logs
    add constraint debate_file_activity_logs_action_check
    check (action in ('read', 'write', 'search', 'list', 'stat'));
exception when undefined_table or duplicate_object then
  null;
end $$;

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
exception when undefined_table or duplicate_object then
  null;
end $$;

do $$
begin
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
exception when undefined_table or duplicate_object then
  null;
end $$;

do $$
begin
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
exception when undefined_table or duplicate_object then
  null;
end $$;

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
           select 1 from debate_agents a where a.id = c.debate_agent_id
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
exception when undefined_table or undefined_column or duplicate_object then
  null;
end $$;

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
