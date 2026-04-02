import { randomUUID } from "crypto";

import { requireSessionUser } from "@/lib/auth";
import { createDebateFromStrategyBindings } from "@/lib/debates";
import { ensureDbReady, getPool, query } from "@/lib/db";
import { AppError } from "@/lib/http";
import {
  createWorkspaceDebateSchema,
  createWorkspaceSchema,
  filePathSchema,
  moveFileSchema,
  relativeFilePathSchema,
  upsertFileSchema,
  updateWorkspaceSchema
} from "@/lib/validation";

type WorkspaceRow = {
  id: string;
  owner_user_id: string;
  strategy_id: string;
  name: string;
  description: string | null;
  question: string;
  summary_ai_agent_id: string | null;
  default_max_turns: number;
  default_enable_shared_facts: boolean;
  created_at: string;
  updated_at: string;
};

type WorkspaceBindingRow = {
  id: string;
  workspace_id: string;
  source_strategy_role_id: string | null;
  role_name: string;
  role_order: number;
  ai_agent_id: string | null;
  display_name: string | null;
  created_at: string;
  updated_at: string;
};

type WorkspaceFileRow = {
  id: string;
  workspace_id: string;
  path: string;
  content: string;
  created_at: string;
  updated_at: string;
};

const DEFAULT_WORKSPACE_FILES = [
  { path: "debate/ideas/raw-idea-bank.md", content: "" },
  { path: "debate/ideas/selected-s-tier.md", content: "" },
  { path: "debate/ideas/selected-a-tier.md", content: "" },
  { path: "debate/ideas/rejected-or-merged.md", content: "" },
  { path: "debate/ideas/event-mappings.md", content: "" },
  { path: "debate/ideas/newly-invented-ideas.md", content: "" },
  { path: "debate/notes/project-brief.md", content: "" },
  { path: "debate/reference/private-materials.md", content: "" }
] as const;

function isMissingTableError(error: unknown, table: string) {
  if (typeof error !== "object" || error === null) return false;
  const anyError = error as { code?: unknown; message?: unknown };
  if (anyError.code !== "42P01") return false;
  const message = typeof anyError.message === "string" ? anyError.message : "";
  return message.toLowerCase().includes(table.toLowerCase());
}

function normalizeWorkspaceRow(row: WorkspaceRow) {
  return {
    id: String(row.id),
    ownerUserId: String(row.owner_user_id),
    strategyId: String(row.strategy_id),
    name: String(row.name),
    description: row.description ?? null,
    question: String(row.question ?? ""),
    summaryAgentId: row.summary_ai_agent_id ?? null,
    defaultMaxTurns: Number(row.default_max_turns ?? 10),
    defaultEnableSharedFacts: Boolean(row.default_enable_shared_facts ?? true),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function normalizeWorkspaceBindingRow(row: WorkspaceBindingRow) {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    sourceStrategyRoleId: row.source_strategy_role_id ?? null,
    roleName: String(row.role_name),
    roleOrder: Number(row.role_order),
    agentId: row.ai_agent_id ?? null,
    displayName: row.display_name ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function normalizeWorkspaceFileRow(row: WorkspaceFileRow) {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    path: String(row.path),
    content: String(row.content ?? ""),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

async function getTransactionClient() {
  const pool = await ensureDbReady();
  return await pool.connect();
}

async function safeRollback(client: { query: (sql: string) => Promise<unknown> }) {
  try {
    await client.query("rollback");
  } catch {
  }
}

async function loadVisibleStrategyWithRoles(strategyId: string, userId: string) {
  const strategyResult = await query<{ id: string; name: string; description: string | null; is_shared: boolean }>(
    "select id, name, description, is_shared from strategies where id = $1 and (owner_user_id = $2 or is_shared = true)",
    [strategyId, userId]
  );
  if ((strategyResult.rowCount ?? 0) !== 1) {
    throw new AppError("NOT_FOUND", 404, "Strategy not found");
  }
  const rolesResult = await query<{ id: string; name: string; role_order: number }>(
    "select id, name, role_order from strategy_roles where strategy_id = $1 order by role_order asc",
    [strategyId]
  );
  if ((rolesResult.rowCount ?? 0) < 2) {
    throw new AppError("VALIDATION_ERROR", 400, "Strategy must have at least 2 roles");
  }
  return {
    id: String(strategyResult.rows[0].id),
    name: String(strategyResult.rows[0].name),
    description: strategyResult.rows[0].description ?? null,
    isShared: Boolean(strategyResult.rows[0].is_shared),
    roles: rolesResult.rows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      roleOrder: Number(row.role_order)
    }))
  };
}

async function getOwnedWorkspaceRow(id: string, userId: string) {
  const result = await query<WorkspaceRow>(
    "select * from workspaces where id = $1 and owner_user_id = $2",
    [id, userId]
  );
  if ((result.rowCount ?? 0) !== 1) {
    throw new AppError("NOT_FOUND", 404, "Workspace not found");
  }
  return result.rows[0];
}

async function getOwnedWorkspaceForFileAccess(workspaceId: string, userId: string) {
  return await getOwnedWorkspaceRow(workspaceId, userId);
}

export async function listWorkspaces() {
  const session = await requireSessionUser();
  try {
    const result = await query<
      WorkspaceRow & {
        strategy_name: string;
        debate_count: number;
      }
    >(
      `
        select w.*,
               s.name as strategy_name,
               (
                 select count(*)::int
                   from debates d
                  where d.source_workspace_id = w.id
               ) as debate_count
          from workspaces w
          join strategies s on s.id = w.strategy_id
         where w.owner_user_id = $1
         order by w.updated_at desc
      `,
      [session.userId]
    );
    return result.rows.map((row) => ({
      ...normalizeWorkspaceRow(row),
      strategyName: String(row.strategy_name),
      debateCount: Number(row.debate_count ?? 0)
    }));
  } catch (error) {
    if (isMissingTableError(error, "workspaces")) {
      throw new AppError("MIGRATION_REQUIRED", 500, "Missing workspaces tables");
    }
    throw error;
  }
}

export async function createWorkspace(input: unknown) {
  const session = await requireSessionUser();
  const data = createWorkspaceSchema.parse(input);
  const strategy = await loadVisibleStrategyWithRoles(data.strategyId, session.userId);
  const now = new Date().toISOString();
  const client = await getTransactionClient();
  const workspaceId = randomUUID();
  try {
    await client.query("begin");
    await client.query(
      `
        insert into workspaces (
          id, owner_user_id, strategy_id, name, description, question, summary_ai_agent_id,
          default_max_turns, default_enable_shared_facts, created_at, updated_at
        )
        values ($1,$2,$3,$4,$5,'',null,10,true,$6,$6)
      `,
      [workspaceId, session.userId, strategy.id, data.name, data.description ?? null, now]
    );
    for (const role of strategy.roles) {
      await client.query(
        `
          insert into workspace_role_bindings (
            id, workspace_id, source_strategy_role_id, role_name, role_order, ai_agent_id, display_name, created_at, updated_at
          ) values ($1,$2,$3,$4,$5,null,null,$6,$6)
        `,
        [randomUUID(), workspaceId, role.id, role.name, role.roleOrder, now]
      );
    }
    for (const file of DEFAULT_WORKSPACE_FILES) {
      await client.query(
        `
          insert into workspace_files (id, workspace_id, path, content, created_at, updated_at)
          values ($1,$2,$3,$4,$5,$5)
        `,
        [randomUUID(), workspaceId, file.path, file.content, now]
      );
    }
    await client.query("commit");
  } catch (error) {
    await safeRollback(client);
    if (isMissingTableError(error, "workspaces") || isMissingTableError(error, "workspace_role_bindings") || isMissingTableError(error, "workspace_files")) {
      throw new AppError("MIGRATION_REQUIRED", 500, "Missing workspaces tables");
    }
    throw error;
  } finally {
    client.release();
  }
  return getWorkspaceDetail(workspaceId);
}

export async function getWorkspaceDetail(id: string) {
  const session = await requireSessionUser();
  try {
    const workspaceRow = await getOwnedWorkspaceRow(id, session.userId);
    const [strategyResult, bindingsResult, filesResult] = await Promise.all([
      query<{ id: string; name: string; description: string | null }>(
        "select id, name, description from strategies where id = $1 limit 1",
        [workspaceRow.strategy_id]
      ),
      query<WorkspaceBindingRow>(
        "select * from workspace_role_bindings where workspace_id = $1 order by role_order asc, created_at asc",
        [id]
      ),
      query<WorkspaceFileRow>(
        "select * from workspace_files where workspace_id = $1 order by path asc",
        [id]
      )
    ]);
    const usedAgentIds = bindingsResult.rows
      .map((row) => row.ai_agent_id)
      .filter((item): item is string => Boolean(item));
    const allAgentIds = Array.from(
      new Set([
        ...usedAgentIds,
        ...(workspaceRow.summary_ai_agent_id ? [String(workspaceRow.summary_ai_agent_id)] : [])
      ])
    );
    const agentsResult =
      allAgentIds.length > 0
        ? await query<{ id: string; name: string; provider: string; model: string }>(
            "select id, name, provider, model from ai_agents where user_id = $1 and id = any($2::uuid[])",
            [session.userId, allAgentIds]
          )
        : { rows: [], rowCount: 0 };
    const agentsById = new Map(
      agentsResult.rows.map((row) => [
        String(row.id),
        { id: String(row.id), name: String(row.name), provider: String(row.provider), model: String(row.model) }
      ])
    );

    return {
      ...normalizeWorkspaceRow(workspaceRow),
      strategy:
        (strategyResult.rowCount ?? 0) === 1
          ? {
              id: String(strategyResult.rows[0].id),
              name: String(strategyResult.rows[0].name),
              description: strategyResult.rows[0].description ?? null
            }
          : null,
      bindings: bindingsResult.rows.map((row) => ({
        ...normalizeWorkspaceBindingRow(row),
        agent: row.ai_agent_id ? agentsById.get(String(row.ai_agent_id)) ?? null : null
      })),
      files: filesResult.rows.map((row) => normalizeWorkspaceFileRow(row)),
      summaryAgent:
        workspaceRow.summary_ai_agent_id ? agentsById.get(String(workspaceRow.summary_ai_agent_id)) ?? null : null
    };
  } catch (error) {
    if (isMissingTableError(error, "workspaces") || isMissingTableError(error, "workspace_role_bindings") || isMissingTableError(error, "workspace_files")) {
      throw new AppError("MIGRATION_REQUIRED", 500, "Missing workspaces tables");
    }
    throw error;
  }
}

export async function updateWorkspace(id: string, input: unknown) {
  const session = await requireSessionUser();
  const data = updateWorkspaceSchema.parse(input);
  const workspace = await getOwnedWorkspaceRow(id, session.userId);
  const strategy = await loadVisibleStrategyWithRoles(String(workspace.strategy_id), session.userId);
  const now = new Date().toISOString();

  const bindingRoleIds = data.bindings
    .map((binding) => binding.sourceStrategyRoleId)
    .filter((value): value is string => Boolean(value));
  const strategyRoleIdSet = new Set(strategy.roles.map((role) => role.id));
  if (bindingRoleIds.some((roleId) => !strategyRoleIdSet.has(roleId))) {
    throw new AppError("VALIDATION_ERROR", 400, "Workspace bindings contain invalid strategy roles");
  }

  const uniqueAgentIds = Array.from(
    new Set(
      [
        ...data.bindings.map((binding) => binding.agentId).filter((item): item is string => Boolean(item)),
        ...(data.summaryAgentId ? [data.summaryAgentId] : [])
      ].filter(Boolean)
    )
  );
  if (uniqueAgentIds.length > 0) {
    const agentsResult = await query<{ id: string }>(
      "select id from ai_agents where user_id = $1 and deleted_at is null and id = any($2::uuid[])",
      [session.userId, uniqueAgentIds]
    );
    if ((agentsResult.rowCount ?? 0) !== uniqueAgentIds.length) {
      throw new AppError("VALIDATION_ERROR", 400, "Workspace contains invalid AI bindings");
    }
  }

  const nextFiles = (data.files ?? []).map((file) => ({
    path: relativeFilePathSchema.parse(file.path),
    content: String(file.content ?? "")
  }));

  const client = await getTransactionClient();
  try {
    await client.query("begin");
    await client.query(
      `
        update workspaces
           set name = $3,
               description = $4,
               question = $5,
               summary_ai_agent_id = $6,
               default_max_turns = $7,
               default_enable_shared_facts = $8,
               updated_at = $9
         where id = $1 and owner_user_id = $2
      `,
      [
        id,
        session.userId,
        data.name,
        data.description ?? null,
        data.question,
        data.summaryAgentId ?? null,
        data.defaultMaxTurns,
        data.defaultEnableSharedFacts ?? true,
        now
      ]
    );

    await client.query("delete from workspace_role_bindings where workspace_id = $1", [id]);
    for (const binding of data.bindings.slice().sort((a, b) => a.roleOrder - b.roleOrder)) {
      await client.query(
        `
          insert into workspace_role_bindings (
            id, workspace_id, source_strategy_role_id, role_name, role_order, ai_agent_id, display_name, created_at, updated_at
          ) values ($1,$2,$3,$4,$5,$6,$7,$8,$8)
        `,
        [
          binding.id ?? randomUUID(),
          id,
          binding.sourceStrategyRoleId ?? null,
          binding.roleName,
          binding.roleOrder,
          binding.agentId ?? null,
          binding.displayName ?? null,
          now
        ]
      );
    }

    if (data.files) {
      await client.query("delete from workspace_files where workspace_id = $1", [id]);
      for (const file of nextFiles) {
        await client.query(
          `
            insert into workspace_files (id, workspace_id, path, content, created_at, updated_at)
            values ($1,$2,$3,$4,$5,$5)
          `,
          [randomUUID(), id, file.path, file.content, now]
        );
      }
    }
    await client.query("commit");
  } catch (error) {
    await safeRollback(client);
    throw error;
  } finally {
    client.release();
  }
  return getWorkspaceDetail(id);
}

export async function listWorkspaceFiles(id: string) {
  const session = await requireSessionUser();
  await getOwnedWorkspaceForFileAccess(id, session.userId);
  const result = await query<WorkspaceFileRow>(
    "select id, workspace_id, path, content, created_at, updated_at from workspace_files where workspace_id = $1 order by path asc",
    [id]
  );
  return result.rows.map((row) => {
    const file = normalizeWorkspaceFileRow(row);
    return {
      id: file.id,
      path: file.path,
      createdAt: file.createdAt,
      updatedAt: file.updatedAt
    };
  });
}

export async function getWorkspaceFile(id: string, path: string) {
  const session = await requireSessionUser();
  await getOwnedWorkspaceForFileAccess(id, session.userId);
  const normalizedPath = relativeFilePathSchema.parse(path);
  const result = await query<WorkspaceFileRow>(
    "select id, workspace_id, path, content, created_at, updated_at from workspace_files where workspace_id = $1 and path = $2 limit 1",
    [id, normalizedPath]
  );
  if ((result.rowCount ?? 0) !== 1) {
    throw new AppError("NOT_FOUND", 404, "Workspace file not found");
  }
  return normalizeWorkspaceFileRow(result.rows[0]);
}

export async function upsertWorkspaceFile(id: string, input: unknown) {
  const session = await requireSessionUser();
  await getOwnedWorkspaceForFileAccess(id, session.userId);
  const data = upsertFileSchema.parse(input);
  const normalizedPath = relativeFilePathSchema.parse(data.path);
  const now = new Date().toISOString();
  const existing = await query<WorkspaceFileRow>(
    "select * from workspace_files where workspace_id = $1 and path = $2 limit 1",
    [id, normalizedPath]
  );
  if ((existing.rowCount ?? 0) === 1) {
    const updated = await query<WorkspaceFileRow>(
      `
        update workspace_files
           set content = $3,
               updated_at = $4
         where workspace_id = $1 and path = $2
        returning *
      `,
      [id, normalizedPath, data.content, now]
    );
    return normalizeWorkspaceFileRow(updated.rows[0]);
  }

  const inserted = await query<WorkspaceFileRow>(
    `
      insert into workspace_files (id, workspace_id, path, content, created_at, updated_at)
      values ($1,$2,$3,$4,$5,$5)
      returning *
    `,
    [randomUUID(), id, normalizedPath, data.content, now]
  );
  return normalizeWorkspaceFileRow(inserted.rows[0]);
}

export async function deleteWorkspaceFile(id: string, input: unknown) {
  const session = await requireSessionUser();
  await getOwnedWorkspaceForFileAccess(id, session.userId);
  const data = filePathSchema.parse(input);
  const normalizedPath = relativeFilePathSchema.parse(data.path);
  const result = await query(
    "delete from workspace_files where workspace_id = $1 and path = $2",
    [id, normalizedPath]
  );
  if ((result.rowCount ?? 0) === 0) {
    throw new AppError("NOT_FOUND", 404, "Workspace file not found");
  }
  return { deleted: 1 };
}

export async function deleteWorkspaceFilesByPrefix(id: string, prefix: string) {
  const session = await requireSessionUser();
  await getOwnedWorkspaceForFileAccess(id, session.userId);
  const normalizedPrefix = relativeFilePathSchema.parse(prefix).replace(/\/+$/, "");
  const result = await query(
    "delete from workspace_files where workspace_id = $1 and path like $2",
    [id, `${normalizedPrefix}/%`]
  );
  return { deleted: Number(result.rowCount ?? 0) };
}

export async function moveWorkspaceFile(id: string, input: unknown) {
  const session = await requireSessionUser();
  await getOwnedWorkspaceForFileAccess(id, session.userId);
  const data = moveFileSchema.parse(input);
  const fromPath = relativeFilePathSchema.parse(data.fromPath);
  const toPath = relativeFilePathSchema.parse(data.toPath);
  if (fromPath === toPath) {
    return await getWorkspaceFile(id, fromPath);
  }

  const existingTo = await query<{ id: string }>(
    "select id from workspace_files where workspace_id = $1 and path = $2 limit 1",
    [id, toPath]
  );
  if ((existingTo.rowCount ?? 0) > 0) {
    throw new AppError("CONFLICT", 409, "Target workspace file already exists");
  }

  const now = new Date().toISOString();
  const result = await query<WorkspaceFileRow>(
    `
      update workspace_files
         set path = $3,
             updated_at = $4
       where workspace_id = $1 and path = $2
      returning *
    `,
    [id, fromPath, toPath, now]
  );
  if ((result.rowCount ?? 0) !== 1) {
    throw new AppError("NOT_FOUND", 404, "Workspace file not found");
  }
  return normalizeWorkspaceFileRow(result.rows[0]);
}

export async function createDebateFromWorkspace(id: string, input: unknown) {
  const session = await requireSessionUser();
  const data = createWorkspaceDebateSchema.parse(input);
  const detail = await getWorkspaceDetail(id);
  const activeBindings = detail.bindings.filter((binding) => binding.agentId && binding.sourceStrategyRoleId);
  if (activeBindings.length < 2) {
    throw new AppError("VALIDATION_ERROR", 400, "Workspace needs at least 2 bound AI seats before creating a debate");
  }
  const question = detail.question.trim();
  if (question.length < 10) {
    throw new AppError("VALIDATION_ERROR", 400, "Workspace question must be at least 10 characters");
  }
  return createDebateFromStrategyBindings(session.userId, {
    question,
    maxTurns: data.maxTurns ?? detail.defaultMaxTurns,
    enableSharedFacts: data.enableSharedFacts ?? detail.defaultEnableSharedFacts,
    strategyId: detail.strategyId,
    bindings: activeBindings.map((binding) => ({
      roleId: binding.sourceStrategyRoleId!,
      agentId: binding.agentId!,
      displayName: binding.displayName ?? undefined
    })),
    summaryAgentId: detail.summaryAgentId ?? null,
    sourceWorkspaceId: detail.id,
    workspaceFiles: detail.files.map((file) => ({ path: file.path, content: file.content }))
  });
}
