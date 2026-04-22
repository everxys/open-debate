import { randomUUID } from "crypto";
import { sql } from "kysely";

import { requireSessionUser } from "@/lib/auth";
import { createDebateFromStrategyBindings } from "@/lib/debates";
import { ensureDb } from "@/lib/db";
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

async function loadVisibleStrategyWithRoles(strategyId: string, userId: string) {
  const db = await ensureDb();
  const strategy = await db
    .selectFrom("strategies")
    .select(["id", "name", "description", "is_shared"])
    .where("id", "=", strategyId)
    .where((eb) =>
      eb.or([
        eb("owner_user_id", "=", userId),
        eb("is_shared", "=", true)
      ])
    )
    .executeTakeFirst();
  if (!strategy) {
    throw new AppError("NOT_FOUND", 404, "Strategy not found");
  }
  const roles = await db
    .selectFrom("strategy_roles")
    .select(["id", "name", "role_order"])
    .where("strategy_id", "=", strategyId)
    .orderBy("role_order", "asc")
    .execute();
  if (roles.length < 2) {
    throw new AppError("VALIDATION_ERROR", 400, "Strategy must have at least 2 roles");
  }
  return {
    id: String(strategy.id),
    name: String(strategy.name),
    description: strategy.description ?? null,
    isShared: Boolean(strategy.is_shared),
    roles: roles.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      roleOrder: Number(row.role_order)
    }))
  };
}

async function getOwnedWorkspaceRow(id: string, userId: string) {
  const db = await ensureDb();
  const result = await db
    .selectFrom("workspaces")
    .selectAll()
    .where("id", "=", id)
    .where("owner_user_id", "=", userId)
    .executeTakeFirst();
  if (!result) {
    throw new AppError("NOT_FOUND", 404, "Workspace not found");
  }
  return result;
}

async function getOwnedWorkspaceForFileAccess(workspaceId: string, userId: string) {
  return await getOwnedWorkspaceRow(workspaceId, userId);
}

export async function listWorkspaces() {
  const session = await requireSessionUser();
  try {
    const db = await ensureDb();
    const rows = await db
      .selectFrom("workspaces as w")
      .innerJoin("strategies as s", "s.id", "w.strategy_id")
      .selectAll("w")
      .select([
        "s.name as strategy_name",
        sql<number>`(
          select count(*)::int
            from debates d
           where d.source_workspace_id = w.id
        )`.as("debate_count")
      ])
      .where("w.owner_user_id", "=", session.userId)
      .orderBy("w.updated_at", "desc")
      .execute();
    return rows.map((row) => ({
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
  const workspaceId = randomUUID();
  try {
    const db = await ensureDb();
    await db.transaction().execute(async (trx) => {
      await trx
        .insertInto("workspaces")
        .values({
          id: workspaceId,
          owner_user_id: session.userId,
          strategy_id: strategy.id,
          name: data.name,
          description: data.description ?? null,
          question: "",
          summary_ai_agent_id: null,
          default_max_turns: 10,
          default_enable_shared_facts: true,
          created_at: now,
          updated_at: now
        })
        .execute();

      for (const role of strategy.roles) {
        await trx
          .insertInto("workspace_role_bindings")
          .values({
            id: randomUUID(),
            workspace_id: workspaceId,
            source_strategy_role_id: role.id,
            role_name: role.name,
            role_order: role.roleOrder,
            ai_agent_id: null,
            display_name: null,
            created_at: now,
            updated_at: now
          })
          .execute();
      }

    });
  } catch (error) {
    if (isMissingTableError(error, "workspaces") || isMissingTableError(error, "workspace_role_bindings") || isMissingTableError(error, "workspace_files")) {
      throw new AppError("MIGRATION_REQUIRED", 500, "Missing workspaces tables");
    }
    throw error;
  }
  return getWorkspaceDetail(workspaceId);
}

export async function getWorkspaceDetail(id: string) {
  const session = await requireSessionUser();
  try {
    const workspaceRow = await getOwnedWorkspaceRow(id, session.userId);
    const db = await ensureDb();
    const [strategyResult, bindingsResult, filesResult] = await Promise.all([
      db
        .selectFrom("strategies")
        .select(["id", "name", "description"])
        .where("id", "=", workspaceRow.strategy_id)
        .limit(1)
        .executeTakeFirst(),
      db
        .selectFrom("workspace_role_bindings")
        .selectAll()
        .where("workspace_id", "=", id)
        .orderBy("role_order", "asc")
        .orderBy("created_at", "asc")
        .execute(),
      db
        .selectFrom("workspace_files")
        .selectAll()
        .where("workspace_id", "=", id)
        .orderBy("path", "asc")
        .execute()
    ]);
    const usedAgentIds = bindingsResult
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
        ? await db
            .selectFrom("ai_agents")
            .select(["id", "name", "provider", "model"])
            .where("user_id", "=", session.userId)
            .where("id", "in", allAgentIds)
            .execute()
        : [];
    const agentsById = new Map(
      agentsResult.map((row) => [
        String(row.id),
        { id: String(row.id), name: String(row.name), provider: String(row.provider), model: String(row.model) }
      ])
    );

    return {
      ...normalizeWorkspaceRow(workspaceRow),
      strategy:
        strategyResult
          ? {
              id: String(strategyResult.id),
              name: String(strategyResult.name),
              description: strategyResult.description ?? null
            }
          : null,
      bindings: bindingsResult.map((row) => ({
        ...normalizeWorkspaceBindingRow(row),
        agent: row.ai_agent_id ? agentsById.get(String(row.ai_agent_id)) ?? null : null
      })),
      files: filesResult.map((row) => normalizeWorkspaceFileRow(row)),
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
    const db = await ensureDb();
    const agentsResult = await db
      .selectFrom("ai_agents")
      .select("id")
      .where("user_id", "=", session.userId)
      .where("deleted_at", "is", null)
      .where("id", "in", uniqueAgentIds)
      .execute();
    if (agentsResult.length !== uniqueAgentIds.length) {
      throw new AppError("VALIDATION_ERROR", 400, "Workspace contains invalid AI bindings");
    }
  }

  const nextFiles = (data.files ?? []).map((file) => ({
    path: relativeFilePathSchema.parse(file.path),
    content: String(file.content ?? "")
  }));

  try {
    const db = await ensureDb();
    await db.transaction().execute(async (trx) => {
      await trx
        .updateTable("workspaces")
        .set({
          name: data.name,
          description: data.description ?? null,
          question: data.question,
          summary_ai_agent_id: data.summaryAgentId ?? null,
          default_max_turns: data.defaultMaxTurns,
          default_enable_shared_facts: data.defaultEnableSharedFacts ?? true,
          updated_at: now
        })
        .where("id", "=", id)
        .where("owner_user_id", "=", session.userId)
        .execute();

      await trx.deleteFrom("workspace_role_bindings").where("workspace_id", "=", id).execute();
      for (const binding of data.bindings.slice().sort((a, b) => a.roleOrder - b.roleOrder)) {
        await trx
          .insertInto("workspace_role_bindings")
          .values({
            id: binding.id ?? randomUUID(),
            workspace_id: id,
            source_strategy_role_id: binding.sourceStrategyRoleId ?? null,
            role_name: binding.roleName,
            role_order: binding.roleOrder,
            ai_agent_id: binding.agentId ?? null,
            display_name: binding.displayName ?? null,
            created_at: now,
            updated_at: now
          })
          .execute();
      }

      if (data.files) {
        await trx.deleteFrom("workspace_files").where("workspace_id", "=", id).execute();
        for (const file of nextFiles) {
          await trx
            .insertInto("workspace_files")
            .values({
              id: randomUUID(),
              workspace_id: id,
              path: file.path,
              content: file.content,
              created_at: now,
              updated_at: now
            })
            .execute();
        }
      }
    });
  } catch (error) {
    throw error;
  }
  return getWorkspaceDetail(id);
}

export async function listWorkspaceFiles(id: string) {
  const session = await requireSessionUser();
  await getOwnedWorkspaceForFileAccess(id, session.userId);
  const db = await ensureDb();
  const result = await db
    .selectFrom("workspace_files")
    .select(["id", "workspace_id", "path", "content", "created_at", "updated_at"])
    .where("workspace_id", "=", id)
    .orderBy("path", "asc")
    .execute();
  return result.map((row) => {
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
  const db = await ensureDb();
  const result = await db
    .selectFrom("workspace_files")
    .select(["id", "workspace_id", "path", "content", "created_at", "updated_at"])
    .where("workspace_id", "=", id)
    .where("path", "=", normalizedPath)
    .limit(1)
    .executeTakeFirst();
  if (!result) {
    throw new AppError("NOT_FOUND", 404, "Workspace file not found");
  }
  return normalizeWorkspaceFileRow(result);
}

export async function upsertWorkspaceFile(id: string, input: unknown) {
  const session = await requireSessionUser();
  await getOwnedWorkspaceForFileAccess(id, session.userId);
  const data = upsertFileSchema.parse(input);
  const normalizedPath = relativeFilePathSchema.parse(data.path);
  const now = new Date().toISOString();
  const db = await ensureDb();
  const existing = await db
    .selectFrom("workspace_files")
    .selectAll()
    .where("workspace_id", "=", id)
    .where("path", "=", normalizedPath)
    .limit(1)
    .executeTakeFirst();
  if (existing) {
    const updated = await db
      .updateTable("workspace_files")
      .set({
        content: data.content,
        updated_at: now
      })
      .where("workspace_id", "=", id)
      .where("path", "=", normalizedPath)
      .returningAll()
      .executeTakeFirstOrThrow();
    return normalizeWorkspaceFileRow(updated);
  }

  const inserted = await db
    .insertInto("workspace_files")
    .values({
      id: randomUUID(),
      workspace_id: id,
      path: normalizedPath,
      content: data.content,
      created_at: now,
      updated_at: now
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return normalizeWorkspaceFileRow(inserted);
}

export async function deleteWorkspaceFile(id: string, input: unknown) {
  const session = await requireSessionUser();
  await getOwnedWorkspaceForFileAccess(id, session.userId);
  const data = filePathSchema.parse(input);
  const normalizedPath = relativeFilePathSchema.parse(data.path);
  const db = await ensureDb();
  const result = await db
    .deleteFrom("workspace_files")
    .where("workspace_id", "=", id)
    .where("path", "=", normalizedPath)
    .executeTakeFirst();
  if (Number(result.numDeletedRows ?? 0) === 0) {
    throw new AppError("NOT_FOUND", 404, "Workspace file not found");
  }
  return { deleted: 1 };
}

export async function deleteWorkspaceFilesByPrefix(id: string, prefix: string) {
  const session = await requireSessionUser();
  await getOwnedWorkspaceForFileAccess(id, session.userId);
  const normalizedPrefix = relativeFilePathSchema.parse(prefix).replace(/\/+$/, "");
  const db = await ensureDb();
  const result = await db
    .deleteFrom("workspace_files")
    .where("workspace_id", "=", id)
    .where("path", "like", `${normalizedPrefix}/%`)
    .executeTakeFirst();
  return { deleted: Number(result.numDeletedRows ?? 0) };
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

  const db = await ensureDb();
  const existingTo = await db
    .selectFrom("workspace_files")
    .select("id")
    .where("workspace_id", "=", id)
    .where("path", "=", toPath)
    .limit(1)
    .executeTakeFirst();
  if (existingTo) {
    throw new AppError("CONFLICT", 409, "Target workspace file already exists");
  }

  const now = new Date().toISOString();
  const result = await db
    .updateTable("workspace_files")
    .set({
      path: toPath,
      updated_at: now
    })
    .where("workspace_id", "=", id)
    .where("path", "=", fromPath)
    .returningAll()
    .executeTakeFirst();
  if (!result) {
    throw new AppError("NOT_FOUND", 404, "Workspace file not found");
  }
  return normalizeWorkspaceFileRow(result);
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
