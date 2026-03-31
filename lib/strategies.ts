import { randomUUID } from "crypto";

import { getPool, query } from "@/lib/db";
import { AppError } from "@/lib/http";
import { readSession } from "@/lib/session";
import {
  agentFileDeleteSchema,
  agentFileMoveSchema,
  agentFileUpsertSchema,
  createStrategySchema,
  updateStrategySchema,
  updateStrategyWorkflowConfigSchema,
  updateStrategyWorkflowPhasePromptsSchema
} from "@/lib/validation";
import {
  createDefaultDebateWorkflowConfig,
  normalizeDebateWorkflow,
  toCanonicalWorkflowConfig,
  type DebateWorkflowConfig
} from "@/lib/workflow";

// === DB row types ===

type StrategyRow = {
  id: string;
  owner_user_id: string;
  name: string;
  description: string | null;
  is_shared: boolean;
  forked_from_strategy_id?: string | null;
  created_at: string;
  updated_at: string;
};

type StrategyRoleRow = {
  id: string;
  strategy_id: string;
  name: string;
  system_prompt: string | null;
  role_order: number;
  created_at: string;
  updated_at: string;
};

// === Normalizers ===

function normalizeStrategyRow(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    ownerUserId: String(row.owner_user_id),
    name: String(row.name),
    description: (row.description as string | null) ?? null,
    isShared: Boolean(row.is_shared),
    forkedFromStrategyId: (row.forked_from_strategy_id as string | null | undefined) ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function normalizeStrategyRoleRow(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    strategyId: String(row.strategy_id),
    name: String(row.name),
    systemPrompt: (row.system_prompt as string | null) ?? null,
    roleOrder: Number(row.role_order),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

// === Error helpers ===

function isMissingTableError(error: unknown, table: string) {
  if (typeof error !== "object" || error === null) return false;
  const anyError = error as { code?: unknown; message?: unknown };
  if (anyError.code !== "42P01") return false;
  const message = typeof anyError.message === "string" ? anyError.message : "";
  return message.toLowerCase().includes(table.toLowerCase());
}

function isMissingColumnError(error: unknown, column: string) {
  if (typeof error !== "object" || error === null) return false;
  const anyError = error as { code?: unknown; message?: unknown };
  if (anyError.code !== "42703") return false;
  const message = typeof anyError.message === "string" ? anyError.message : "";
  return message.toLowerCase().includes(column.toLowerCase());
}

// === Auth helper ===

/** Require authenticated session, throw if missing */
async function requireSessionUser() {
  const session = await readSession();
  if (!session) throw new AppError("AUTH_REQUIRED", 401, "Authentication required");
  return session;
}

// === View helpers ===

function toListItem(row: ReturnType<typeof normalizeStrategyRow>, roleCount: number) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    isShared: row.isShared,
    forkedFromStrategyId: row.forkedFromStrategyId,
    roleCount,
    updatedAt: row.updatedAt,
    createdAt: row.createdAt
  };
}

export async function listStrategies(scope: "mine" | "shared") {
  const session = await requireSessionUser();

  try {
    if (scope === "shared") {
      try {
        const result = await query<Record<string, unknown>>(
          `
            select s.*,
                   coalesce(r.role_count, 0)::int as role_count,
                   coalesce(f.favorite_count, 0)::int as favorite_count,
                   coalesce(k.fork_count, 0)::int as fork_count,
                   exists(
                     select 1
                       from strategy_favorites sf
                      where sf.strategy_id = s.id and sf.user_id = $1
                   ) as is_favorited
              from strategies s
              left join (
                select strategy_id, count(1)::int as role_count
                  from strategy_roles
                 group by strategy_id
              ) r on r.strategy_id = s.id
              left join (
                select strategy_id, count(1)::int as favorite_count
                  from strategy_favorites
                 group by strategy_id
              ) f on f.strategy_id = s.id
              left join (
                select forked_from_strategy_id as strategy_id, count(1)::int as fork_count
                  from strategies
                 where forked_from_strategy_id is not null
                 group by forked_from_strategy_id
              ) k on k.strategy_id = s.id
             where s.is_shared = true
             order by s.updated_at desc
             limit 200
          `,
          [session.userId]
        );
        return result.rows.map((row) => ({
          ...toListItem(normalizeStrategyRow(row), Number(row.role_count ?? 0)),
          isFavorited: Boolean(row.is_favorited),
          favoriteCount: Number(row.favorite_count ?? 0),
          forkCount: Number(row.fork_count ?? 0)
        }));
      } catch (error) {
        if (
          isMissingTableError(error, "strategy_favorites") ||
          isMissingColumnError(error, "forked_from_strategy_id")
        ) {
          const result = await query<Record<string, unknown>>(
            `
              select s.*,
                     coalesce(r.role_count, 0)::int as role_count
                from strategies s
                left join (
                  select strategy_id, count(1)::int as role_count
                    from strategy_roles
                   group by strategy_id
                ) r on r.strategy_id = s.id
               where s.is_shared = true
               order by s.updated_at desc
               limit 200
            `
          );
          return result.rows.map((row) =>
            toListItem(normalizeStrategyRow(row), Number(row.role_count ?? 0))
          );
        }
        throw error;
      }
    }

    const result = await query<Record<string, unknown>>(
      `
        select s.*,
               coalesce(r.role_count, 0)::int as role_count
          from strategies s
          left join (
            select strategy_id, count(1)::int as role_count
              from strategy_roles
             group by strategy_id
          ) r on r.strategy_id = s.id
         where s.owner_user_id = $1
         order by s.updated_at desc
         limit 200
      `,
      [session.userId]
    );
    return result.rows.map((row) =>
      toListItem(normalizeStrategyRow(row), Number(row.role_count ?? 0))
    );
  } catch (error) {
    if (
      isMissingTableError(error, "strategies") ||
      isMissingTableError(error, "strategy_roles")
    ) {
      throw new AppError("MIGRATION_REQUIRED", 500, "Missing strategies tables");
    }
    throw error;
  }
}

async function getStrategyRowById(id: string) {
  const session = await requireSessionUser();
  try {
    const result = await query<Record<string, unknown>>(
      "select * from strategies where id = $1 and (owner_user_id = $2 or is_shared = true)",
      [id, session.userId]
    );
    if ((result.rowCount ?? 0) !== 1) {
      throw new AppError("NOT_FOUND", 404, "Strategy not found");
    }
    const strategy = normalizeStrategyRow(result.rows[0]);
    return { strategy, canEdit: strategy.ownerUserId === session.userId };
  } catch (error) {
    if (isMissingTableError(error, "strategies")) {
      throw new AppError("MIGRATION_REQUIRED", 500, "Missing strategies tables");
    }
    throw error;
  }
}

export async function getStrategyDetail(id: string) {
  const { strategy, canEdit } = await getStrategyRowById(id);

  try {
    let favoriteCount = 0;
    let forkCount = 0;
    let isFavorited = false;
    if (strategy.isShared) {
      const session = await requireSessionUser();
      try {
        const [favoriteCountRes, isFavRes, forkCountRes] = await Promise.all([
          query<{ count: number }>(
            "select count(1)::int as count from strategy_favorites where strategy_id = $1",
            [strategy.id]
          ),
          query<{ ok: boolean }>(
            "select exists(select 1 from strategy_favorites where strategy_id = $1 and user_id = $2) as ok",
            [strategy.id, session.userId]
          ),
          query<{ count: number }>(
            "select count(1)::int as count from strategies where forked_from_strategy_id = $1",
            [strategy.id]
          )
        ]);
        favoriteCount = favoriteCountRes.rows[0]?.count ?? 0;
        isFavorited = Boolean(isFavRes.rows[0]?.ok);
        forkCount = forkCountRes.rows[0]?.count ?? 0;
      } catch (error) {
        if (
          isMissingTableError(error, "strategy_favorites") ||
          isMissingColumnError(error, "forked_from_strategy_id")
        ) {
          favoriteCount = 0;
          isFavorited = false;
          forkCount = 0;
        } else {
          throw error;
        }
      }
    }

    const roleRows = await query<Record<string, unknown>>(
      "select * from strategy_roles where strategy_id = $1 order by role_order asc",
      [strategy.id]
    );
    const roles = roleRows.rows.map((row) => normalizeStrategyRoleRow(row));

    const roleIds = roles.map((role) => role.id);
    let files: Array<{
      roleId: string;
      path: string;
      content: string;
      createdAt: string;
      updatedAt: string;
    }> = [];

    if (roleIds.length > 0) {
      const fileRows = await query<Record<string, unknown>>(
        `
          select strategy_role_id, path, content, created_at, updated_at
            from strategy_role_files
           where strategy_role_id = any($1::uuid[])
           order by strategy_role_id asc, path asc
        `,
        [roleIds]
      );
      files = fileRows.rows.map((row) => ({
        roleId: String(row.strategy_role_id),
        path: String(row.path),
        content: String(row.content ?? ""),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at)
      }));
    }

    const filesByRoleId = new Map<string, Array<{ path: string; content: string }>>();
    for (const file of files) {
      const list = filesByRoleId.get(file.roleId) ?? [];
      list.push({ path: file.path, content: file.content });
      filesByRoleId.set(file.roleId, list);
    }

    return {
      ...strategy,
      canEdit,
      isFavorited,
      favoriteCount,
      forkCount,
      roles: roles.map((role) => ({
        id: role.id,
        name: role.name,
        systemPrompt: role.systemPrompt,
        roleOrder: role.roleOrder,
        files: filesByRoleId.get(role.id) ?? []
      }))
    };
  } catch (error) {
    if (
      isMissingTableError(error, "strategy_roles") ||
      isMissingTableError(error, "strategy_role_files")
    ) {
      throw new AppError("MIGRATION_REQUIRED", 500, "Missing strategies tables");
    }
    throw error;
  }
}

export async function favoriteStrategy(id: string) {
  const session = await requireSessionUser();
  try {
    const visible = await query<{ id: string }>(
      "select id from strategies where id = $1 and is_shared = true",
      [id]
    );
    if ((visible.rowCount ?? 0) !== 1) {
      throw new AppError("NOT_FOUND", 404, "Strategy not found");
    }
    await query(
      `insert into strategy_favorites (user_id, strategy_id, created_at)
       values ($1,$2,now())
       on conflict (user_id, strategy_id) do nothing`,
      [session.userId, id]
    );
    return { id, isFavorited: true };
  } catch (error) {
    if (isMissingTableError(error, "strategy_favorites")) {
      throw new AppError("MIGRATION_REQUIRED", 500, "Missing strategy_favorites table");
    }
    throw error;
  }
}

export async function unfavoriteStrategy(id: string) {
  const session = await requireSessionUser();
  try {
    await query("delete from strategy_favorites where user_id = $1 and strategy_id = $2", [
      session.userId,
      id
    ]);
    return { id, isFavorited: false };
  } catch (error) {
    if (isMissingTableError(error, "strategy_favorites")) {
      throw new AppError("MIGRATION_REQUIRED", 500, "Missing strategy_favorites table");
    }
    throw error;
  }
}

export async function forkStrategy(id: string) {
  const session = await requireSessionUser();
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("begin");

    const sourceRes = await client.query<StrategyRow>(
      "select * from strategies where id = $1 and is_shared = true",
      [id]
    );
    if ((sourceRes.rowCount ?? 0) !== 1) {
      throw new AppError("NOT_FOUND", 404, "Strategy not found");
    }
    const source = normalizeStrategyRow(sourceRes.rows[0] as unknown as Record<string, unknown>);

    const now = new Date().toISOString();
    const forkId = randomUUID();
    const forkName = `${source.name}（Fork）`;
    await client.query(
      `insert into strategies (id, owner_user_id, name, description, is_shared, forked_from_strategy_id, created_at, updated_at)
       values ($1,$2,$3,$4,false,$5,$6,$6)`,
      [forkId, session.userId, forkName, source.description, source.id, now]
    );

    const rolesRes = await client.query<StrategyRoleRow>(
      "select * from strategy_roles where strategy_id = $1 order by role_order asc",
      [source.id]
    );

    const roleIdMap = new Map<string, string>();
    for (const role of rolesRes.rows) {
      const newRoleId = randomUUID();
      roleIdMap.set(role.id, newRoleId);
      await client.query(
        `insert into strategy_roles (id, strategy_id, name, system_prompt, role_order, created_at, updated_at)
         values ($1,$2,$3,$4,$5,$6,$6)`,
        [newRoleId, forkId, role.name, role.system_prompt, role.role_order, now]
      );
    }

    const sourceRoleIds = rolesRes.rows.map((r) => r.id);
    if (sourceRoleIds.length > 0) {
      const filesRes = await client.query<{ strategy_role_id: string; path: string; content: string }>(
        "select strategy_role_id, path, content from strategy_role_files where strategy_role_id = any($1::uuid[]) order by strategy_role_id asc, path asc",
        [sourceRoleIds]
      );
      for (const file of filesRes.rows) {
        const newRoleId = roleIdMap.get(file.strategy_role_id);
        if (!newRoleId) continue;
        await client.query(
          `insert into strategy_role_files (id, strategy_role_id, path, content, created_at, updated_at)
           values ($1,$2,$3,$4,$5,$5)`,
          [randomUUID(), newRoleId, file.path, file.content ?? "", now]
        );
      }
    }

    await client.query("commit");
    return { id: forkId };
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
    }
    if (
      error instanceof AppError ||
      isMissingTableError(error, "strategies") ||
      isMissingTableError(error, "strategy_roles") ||
      isMissingTableError(error, "strategy_role_files") ||
      isMissingColumnError(error, "forked_from_strategy_id")
    ) {
      if (isMissingColumnError(error, "forked_from_strategy_id")) {
        throw new AppError("MIGRATION_REQUIRED", 500, "Missing strategies.forked_from_strategy_id column");
      }
      if (isMissingTableError(error, "strategies") || isMissingTableError(error, "strategy_roles")) {
        throw new AppError("MIGRATION_REQUIRED", 500, "Missing strategies tables");
      }
      throw error;
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function createStrategy(input: unknown) {
  const data = createStrategySchema.parse(input);
  const session = await requireSessionUser();

  const now = new Date().toISOString();
  const strategyId = randomUUID();

  const client = await getTransactionClient();
  try {
    await client.query("begin");

    await client.query(
      `
        insert into strategies (id, owner_user_id, name, description, is_shared, created_at, updated_at)
        values ($1,$2,$3,$4,$5,$6,$6)
      `,
      [strategyId, session.userId, data.name, data.description ?? null, data.isShared, now]
    );

    for (let index = 0; index < data.roles.length; index += 1) {
      const role = data.roles[index];
      const roleId = randomUUID();
      await client.query(
        `
          insert into strategy_roles (id, strategy_id, name, system_prompt, role_order, created_at, updated_at)
          values ($1,$2,$3,$4,$5,$6,$6)
        `,
        [
          roleId,
          strategyId,
          role.name,
          role.systemPrompt ?? null,
          index + 1,
          now
        ]
      );

      for (const file of role.files ?? []) {
        await client.query(
          `
            insert into strategy_role_files (id, strategy_role_id, path, content, created_at, updated_at)
            values ($1,$2,$3,$4,$5,$5)
          `,
          [randomUUID(), roleId, file.path, file.content ?? "", now]
        );
      }
    }

    await client.query("commit");
  } catch (error) {
    await safeRollback(client);
    if (
      isMissingTableError(error, "strategies") ||
      isMissingTableError(error, "strategy_roles") ||
      isMissingTableError(error, "strategy_role_files")
    ) {
      throw new AppError("MIGRATION_REQUIRED", 500, "Missing strategies tables");
    }
    throw error;
  } finally {
    client.release();
  }

  return getStrategyDetail(strategyId);
}

export async function updateStrategy(id: string, input: unknown) {
  const data = updateStrategySchema.parse(input);
  const session = await requireSessionUser();

  const now = new Date().toISOString();

  const client = await getTransactionClient();
  try {
    await client.query("begin");

    const existing = await client.query<StrategyRow>(
      "select * from strategies where id = $1 and owner_user_id = $2",
      [id, session.userId]
    );
    if ((existing.rowCount ?? 0) !== 1) {
      throw new AppError("NOT_FOUND", 404, "Strategy not found");
    }

    await client.query(
      `
        update strategies
           set name = $3,
               description = $4,
               is_shared = $5,
               updated_at = $6
         where id = $1 and owner_user_id = $2
      `,
      [id, session.userId, data.name, data.description ?? null, data.isShared, now]
    );

    const existingRoles = await client.query<StrategyRoleRow>(
      "select * from strategy_roles where strategy_id = $1",
      [id]
    );
    const existingRoleIds = new Set(existingRoles.rows.map((row) => String(row.id)));

    const desired: Array<{
      id: string;
      name: string;
      systemPrompt: string | null;
      roleOrder: number;
      isNew: boolean;
    }> = data.roles.map((role, index) => {
      const roleId = role.id && existingRoleIds.has(role.id) ? role.id : randomUUID();
      const isNew = !(role.id && existingRoleIds.has(role.id));
      return {
        id: roleId,
        name: role.name,
        systemPrompt: role.systemPrompt ?? null,
        roleOrder: index + 1,
        isNew
      };
    });

    const desiredIds = new Set(desired.map((item) => item.id));
    for (const roleId of existingRoleIds) {
      if (!desiredIds.has(roleId)) {
        await client.query("delete from strategy_roles where id = $1 and strategy_id = $2", [
          roleId,
          id
        ]);
      }
    }

    for (const role of desired) {
      if (role.isNew) {
        await client.query(
          `
            insert into strategy_roles (id, strategy_id, name, system_prompt, role_order, created_at, updated_at)
            values ($1,$2,$3,$4,$5,$6,$6)
          `,
          [role.id, id, role.name, role.systemPrompt, role.roleOrder, now]
        );
      } else {
        await client.query(
          `
            update strategy_roles
               set name = $3,
                   system_prompt = $4,
                   role_order = $5,
                   updated_at = $6
             where id = $1 and strategy_id = $2
          `,
          [role.id, id, role.name, role.systemPrompt, role.roleOrder, now]
        );
      }
    }

    await client.query("commit");
  } catch (error) {
    await safeRollback(client);
    if (
      isMissingTableError(error, "strategies") ||
      isMissingTableError(error, "strategy_roles") ||
      isMissingTableError(error, "strategy_role_files")
    ) {
      throw new AppError("MIGRATION_REQUIRED", 500, "Missing strategies tables");
    }
    throw error;
  } finally {
    client.release();
  }

  return getStrategyDetail(id);
}

export async function deleteStrategy(id: string) {
  const session = await requireSessionUser();
  try {
    const result = await query(
      "delete from strategies where id = $1 and owner_user_id = $2",
      [id, session.userId]
    );
    if ((result.rowCount ?? 0) !== 1) {
      throw new AppError("NOT_FOUND", 404, "Strategy not found");
    }
    return null;
  } catch (error) {
    if (isMissingTableError(error, "strategies")) {
      throw new AppError("MIGRATION_REQUIRED", 500, "Missing strategies tables");
    }
    throw error;
  }
}

export async function duplicateStrategyRole(strategyId: string, roleId: string) {
  const session = await requireSessionUser();
  const client = await getTransactionClient();
  const now = new Date().toISOString();

  try {
    await client.query("begin");

    const strategyResult = await client.query<{ id: string }>(
      "select id from strategies where id = $1 and owner_user_id = $2",
      [strategyId, session.userId]
    );
    if ((strategyResult.rowCount ?? 0) !== 1) {
      throw new AppError("NOT_FOUND", 404, "Strategy not found");
    }

    const roleResult = await client.query<{ name: string; system_prompt: string | null }>(
      "select name, system_prompt from strategy_roles where id = $1 and strategy_id = $2",
      [roleId, strategyId]
    );
    if ((roleResult.rowCount ?? 0) !== 1) {
      throw new AppError("NOT_FOUND", 404, "Strategy role not found");
    }

    const nextOrderResult = await client.query<{ next: number }>(
      "select (coalesce(max(role_order), 0) + 1)::int as next from strategy_roles where strategy_id = $1",
      [strategyId]
    );
    const nextOrder = nextOrderResult.rows[0]?.next ?? 1;

    const newRoleId = randomUUID();
    const newName = roleResult.rows[0].name;

    await client.query(
      `insert into strategy_roles (id, strategy_id, name, system_prompt, role_order, created_at, updated_at)
       values ($1,$2,$3,$4,$5,$6,$6)`,
      [newRoleId, strategyId, newName, roleResult.rows[0].system_prompt ?? null, nextOrder, now]
    );

    await client.query(
      `
        insert into strategy_role_files (id, strategy_role_id, path, content, created_at, updated_at)
        select gen_random_uuid(), $2, path, content, $3, $3
          from strategy_role_files
         where strategy_role_id = $1
         order by path asc
      `,
      [roleId, newRoleId, now]
    );

    await client.query("commit");
    return { id: newRoleId, name: newName, roleOrder: nextOrder };
  } catch (error) {
    await safeRollback(client);
    if (
      isMissingTableError(error, "strategies") ||
      isMissingTableError(error, "strategy_roles") ||
      isMissingTableError(error, "strategy_role_files")
    ) {
      throw new AppError("MIGRATION_REQUIRED", 500, "Missing strategies tables");
    }
    throw error;
  } finally {
    client.release();
  }
}

async function getTransactionClient() {
  const pool = getPool();
  return await pool.connect();
}

async function safeRollback(client: { query: (sql: string) => Promise<unknown> }) {
  try {
    await client.query("rollback");
  } catch {
  }
}

const STRATEGY_WORKFLOW_PATH = "debate/workflow.json";

type StrategyWorkflowRoleRecord = {
  id: string;
  name: string;
  role_order: number;
  workflow_content: string | null;
};

function buildStrategyWorkflowPhasePromptResponse(
  workflowConfig: DebateWorkflowConfig,
  ownerRoleId: string,
  canEdit: boolean,
  hasExistingWorkflow: boolean
) {
  const normalized = normalizeDebateWorkflow(workflowConfig) ?? normalizeDebateWorkflow(createDefaultDebateWorkflowConfig());
  if (!normalized) {
    throw new AppError("INTERNAL_ERROR", 500, "Failed to normalize workflow");
  }
  return {
    ownerRoleId,
    canEdit,
    hasExistingWorkflow,
    openingPrompt: normalized.promptPolicies.openingPrompt ?? "",
    ideaBank: normalized.ideaBank,
    phases: normalized.phaseMachine.phases.map((phase) => ({
      id: phase.id,
      title: phase.title,
      kind: phase.kind,
      description: phase.description,
      minRounds: phase.minRounds,
      injectedPrompt: phase.injectedPrompt ?? ""
    }))
  };
}

async function loadStrategyWorkflowPhasePromptState(strategyId: string) {
  const { strategy, canEdit } = await getStrategyRowById(strategyId);
  try {
    const roleRows = await query<StrategyWorkflowRoleRecord>(
      `
        select r.id, r.name, r.role_order, f.content as workflow_content
          from strategy_roles r
          left join strategy_role_files f
            on f.strategy_role_id = r.id
           and f.path = $2
         where r.strategy_id = $1
         order by r.role_order asc
      `,
      [strategy.id, STRATEGY_WORKFLOW_PATH]
    );
    if ((roleRows.rowCount ?? 0) <= 0) {
      throw new AppError("VALIDATION_ERROR", 400, "Strategy has no roles");
    }

    const rows = roleRows.rows;
    const owner = rows.find((row) => String(row.workflow_content ?? "").trim()) ?? rows[0];
    const rawWorkflow = String(owner.workflow_content ?? "").trim();
    const workflowConfig = (() => {
      if (!rawWorkflow) return createDefaultDebateWorkflowConfig();
      try {
        const parsed = JSON.parse(rawWorkflow) as DebateWorkflowConfig;
        return toCanonicalWorkflowConfig(parsed) ?? createDefaultDebateWorkflowConfig();
      } catch {
        return createDefaultDebateWorkflowConfig();
      }
    })();

    return {
      canEdit,
      ownerRoleId: String(owner.id),
      roleIds: rows.map((row) => String(row.id)),
      workflowConfig,
      hasExistingWorkflow: Boolean(rawWorkflow)
    };
  } catch (error) {
    if (isMissingTableError(error, "strategy_roles") || isMissingTableError(error, "strategy_role_files")) {
      throw new AppError("MIGRATION_REQUIRED", 500, "Missing strategies tables");
    }
    throw error;
  }
}

export async function getStrategyWorkflowPhasePrompts(strategyId: string) {
  const state = await loadStrategyWorkflowPhasePromptState(strategyId);
  return buildStrategyWorkflowPhasePromptResponse(
    state.workflowConfig,
    state.ownerRoleId,
    state.canEdit,
    state.hasExistingWorkflow
  );
}

export async function getStrategyWorkflowConfig(strategyId: string) {
  const state = await loadStrategyWorkflowPhasePromptState(strategyId);
  return {
    ownerRoleId: state.ownerRoleId,
    canEdit: state.canEdit,
    hasExistingWorkflow: state.hasExistingWorkflow,
    workflowConfig: state.workflowConfig
  };
}

export async function updateStrategyWorkflowConfig(strategyId: string, input: unknown) {
  const data = updateStrategyWorkflowConfigSchema.parse(input);
  const state = await loadStrategyWorkflowPhasePromptState(strategyId);
  if (!state.canEdit) {
    throw new AppError("FORBIDDEN", 403, "Permission denied");
  }

  const canonicalWorkflow = toCanonicalWorkflowConfig(data.workflowConfig);
  if (!canonicalWorkflow) {
    throw new AppError("VALIDATION_ERROR", 400, "Invalid workflow config");
  }

  const now = new Date().toISOString();
  const content = JSON.stringify(canonicalWorkflow, null, 2);
  const client = await getTransactionClient();
  try {
    await client.query("begin");
    await client.query(
      `
        insert into strategy_role_files (strategy_role_id, path, content, created_at, updated_at)
        values ($1, $2, $3, $4, $4)
        on conflict (strategy_role_id, path)
        do update set content = excluded.content, updated_at = excluded.updated_at
      `,
      [state.ownerRoleId, STRATEGY_WORKFLOW_PATH, content, now]
    );
    await client.query(
      `
        delete from strategy_role_files
         where path = $2
           and strategy_role_id = any($3::uuid[])
           and strategy_role_id <> $1
      `,
      [state.ownerRoleId, STRATEGY_WORKFLOW_PATH, state.roleIds]
    );
    await client.query("commit");
  } catch (error) {
    await safeRollback(client);
    if (isMissingTableError(error, "strategy_role_files")) {
      throw new AppError("MIGRATION_REQUIRED", 500, "Missing strategies tables");
    }
    throw error;
  } finally {
    client.release();
  }

  return {
    ownerRoleId: state.ownerRoleId,
    canEdit: true,
    hasExistingWorkflow: true,
    workflowConfig: canonicalWorkflow
  };
}

export async function updateStrategyWorkflowPhasePrompts(strategyId: string, input: unknown) {
  const data = updateStrategyWorkflowPhasePromptsSchema.parse(input);
  const state = await loadStrategyWorkflowPhasePromptState(strategyId);
  if (!state.canEdit) {
    throw new AppError("FORBIDDEN", 403, "Permission denied");
  }

  const nextWorkflow = JSON.parse(JSON.stringify(state.workflowConfig)) as DebateWorkflowConfig;
  nextWorkflow.promptPolicies = {
    ...(nextWorkflow.promptPolicies ?? {}),
    openingPrompt: typeof data.openingPrompt === "string" ? data.openingPrompt.trim() || null : nextWorkflow.promptPolicies?.openingPrompt ?? null
  };
  const phasePromptById = new Map(
    data.phases.map((phase) => [phase.id, typeof phase.injectedPrompt === "string" ? phase.injectedPrompt.trim() : ""] as const)
  );
  const defaultPhases = createDefaultDebateWorkflowConfig().phaseMachine?.phases ?? [];
  const currentPhases = nextWorkflow.phaseMachine?.phases ?? defaultPhases;
  nextWorkflow.phaseMachine = {
    ...(nextWorkflow.phaseMachine ?? {}),
    phases: currentPhases.map((phase) => ({
      ...phase,
      injectedPrompt: phasePromptById.has(String(phase.id)) ? phasePromptById.get(String(phase.id)) || null : phase.injectedPrompt ?? null
    }))
  };

  const now = new Date().toISOString();
  const canonicalWorkflow = toCanonicalWorkflowConfig(nextWorkflow) ?? nextWorkflow;
  const content = JSON.stringify(canonicalWorkflow, null, 2);
  const client = await getTransactionClient();
  try {
    await client.query("begin");
    await client.query(
      `
        insert into strategy_role_files (strategy_role_id, path, content, created_at, updated_at)
        values ($1, $2, $3, $4, $4)
        on conflict (strategy_role_id, path)
        do update set content = excluded.content, updated_at = excluded.updated_at
      `,
      [state.ownerRoleId, STRATEGY_WORKFLOW_PATH, content, now]
    );
    await client.query(
      `
        delete from strategy_role_files
         where path = $2
           and strategy_role_id = any($3::uuid[])
           and strategy_role_id <> $1
      `,
      [state.ownerRoleId, STRATEGY_WORKFLOW_PATH, state.roleIds]
    );
    await client.query("commit");
  } catch (error) {
    await safeRollback(client);
    if (isMissingTableError(error, "strategy_role_files")) {
      throw new AppError("MIGRATION_REQUIRED", 500, "Missing strategies tables");
    }
    throw error;
  } finally {
    client.release();
  }

  return buildStrategyWorkflowPhasePromptResponse(canonicalWorkflow, state.ownerRoleId, true, true);
}

async function requireVisibleStrategyRole(strategyId: string, roleId: string) {
  const session = await requireSessionUser();
  try {
    const result = await query<{ owner_user_id: string; is_shared: boolean }>(
      `
        select s.owner_user_id, s.is_shared
          from strategies s
          join strategy_roles r on r.strategy_id = s.id
         where s.id = $1
           and r.id = $2
           and (s.owner_user_id = $3 or s.is_shared = true)
         limit 1
      `,
      [strategyId, roleId, session.userId]
    );
    if ((result.rowCount ?? 0) !== 1) {
      throw new AppError("NOT_FOUND", 404, "Strategy role not found");
    }
    const ownerUserId = String(result.rows[0].owner_user_id);
    return { session, canEdit: ownerUserId === session.userId };
  } catch (error) {
    if (isMissingTableError(error, "strategies") || isMissingTableError(error, "strategy_roles")) {
      throw new AppError("MIGRATION_REQUIRED", 500, "Missing strategies tables");
    }
    throw error;
  }
}

export async function listStrategyRoleFiles(strategyId: string, roleId: string) {
  await requireVisibleStrategyRole(strategyId, roleId);
  try {
    const result = await query<Record<string, unknown>>(
      `
        select path, created_at, updated_at
          from strategy_role_files
         where strategy_role_id = $1
         order by path asc
      `,
      [roleId]
    );
    return result.rows.map((row) => ({
      path: String(row.path),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    }));
  } catch (error) {
    if (isMissingTableError(error, "strategy_role_files")) {
      throw new AppError("MIGRATION_REQUIRED", 500, "Missing strategies tables");
    }
    throw error;
  }
}

export async function getStrategyRoleFile(strategyId: string, roleId: string, path: string) {
  await requireVisibleStrategyRole(strategyId, roleId);
  try {
    const result = await query<Record<string, unknown>>(
      `
        select path, content, created_at, updated_at
          from strategy_role_files
         where strategy_role_id = $1
           and path = $2
         limit 1
      `,
      [roleId, path]
    );
    if ((result.rowCount ?? 0) !== 1) {
      throw new AppError("NOT_FOUND", 404, "File not found");
    }
    return {
      path: String(result.rows[0].path),
      content: String(result.rows[0].content ?? ""),
      createdAt: String(result.rows[0].created_at),
      updatedAt: String(result.rows[0].updated_at)
    };
  } catch (error) {
    if (isMissingTableError(error, "strategy_role_files")) {
      throw new AppError("MIGRATION_REQUIRED", 500, "Missing strategies tables");
    }
    throw error;
  }
}

export async function upsertStrategyRoleFile(strategyId: string, roleId: string, input: unknown) {
  const data = agentFileUpsertSchema.parse(input);
  const { canEdit } = await requireVisibleStrategyRole(strategyId, roleId);
  if (!canEdit) {
    throw new AppError("FORBIDDEN", 403, "Permission denied");
  }

  const now = new Date().toISOString();
  try {
    const result = await query<Record<string, unknown>>(
      `
        insert into strategy_role_files (strategy_role_id, path, content, created_at, updated_at)
        values ($1, $2, $3, $4, $4)
        on conflict (strategy_role_id, path)
        do update set content = excluded.content, updated_at = excluded.updated_at
        returning path, content, created_at, updated_at
      `,
      [roleId, data.path, data.content, now]
    );
    return {
      path: String(result.rows[0].path),
      content: String(result.rows[0].content ?? ""),
      createdAt: String(result.rows[0].created_at),
      updatedAt: String(result.rows[0].updated_at)
    };
  } catch (error) {
    if (isMissingTableError(error, "strategy_role_files")) {
      throw new AppError("MIGRATION_REQUIRED", 500, "Missing strategies tables");
    }
    throw error;
  }
}

export async function deleteStrategyRoleFile(strategyId: string, roleId: string, input: unknown) {
  const data = agentFileDeleteSchema.parse(input);
  const { canEdit } = await requireVisibleStrategyRole(strategyId, roleId);
  if (!canEdit) {
    throw new AppError("FORBIDDEN", 403, "Permission denied");
  }

  try {
    const result = await query(
      "delete from strategy_role_files where strategy_role_id = $1 and path = $2",
      [roleId, data.path]
    );
    if ((result.rowCount ?? 0) !== 1) {
      throw new AppError("NOT_FOUND", 404, "File not found");
    }
    return null;
  } catch (error) {
    if (isMissingTableError(error, "strategy_role_files")) {
      throw new AppError("MIGRATION_REQUIRED", 500, "Missing strategies tables");
    }
    throw error;
  }
}

export async function deleteStrategyRoleFilesByPrefix(strategyId: string, roleId: string, prefix: string) {
  const { canEdit } = await requireVisibleStrategyRole(strategyId, roleId);
  if (!canEdit) {
    throw new AppError("FORBIDDEN", 403, "Permission denied");
  }

  const normalized = String(prefix ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
  const like = normalized ? `${normalized.replace(/\/+$/, "")}/%` : "%";
  try {
    const result = await query(
      "delete from strategy_role_files where strategy_role_id = $1 and path like $2",
      [roleId, like]
    );
    return { deleted: Number(result.rowCount ?? 0) };
  } catch (error) {
    if (isMissingTableError(error, "strategy_role_files")) {
      throw new AppError("MIGRATION_REQUIRED", 500, "Missing strategies tables");
    }
    throw error;
  }
}

export async function moveStrategyRoleFile(strategyId: string, roleId: string, input: unknown) {
  const data = agentFileMoveSchema.parse(input);
  const { canEdit } = await requireVisibleStrategyRole(strategyId, roleId);
  if (!canEdit) {
    throw new AppError("FORBIDDEN", 403, "Permission denied");
  }
  if (data.fromPath === data.toPath) {
    throw new AppError("VALIDATION_ERROR", 400, "fromPath and toPath must be different");
  }

  const now = new Date().toISOString();
  try {
    const exists = await query<{ path: string }>(
      "select path from strategy_role_files where strategy_role_id = $1 and path = $2",
      [roleId, data.toPath]
    );
    if ((exists.rowCount ?? 0) > 0) {
      throw new AppError("CONFLICT", 409, "Target path already exists");
    }

    const updated = await query<Record<string, unknown>>(
      `
        update strategy_role_files
           set path = $3,
               updated_at = $4
         where strategy_role_id = $1 and path = $2
         returning path, content, created_at, updated_at
      `,
      [roleId, data.fromPath, data.toPath, now]
    );
    if ((updated.rowCount ?? 0) !== 1) {
      throw new AppError("NOT_FOUND", 404, "File not found");
    }
    return {
      path: String(updated.rows[0].path),
      content: String(updated.rows[0].content ?? ""),
      createdAt: String(updated.rows[0].created_at),
      updatedAt: String(updated.rows[0].updated_at)
    };
  } catch (error) {
    if (isMissingTableError(error, "strategy_role_files")) {
      throw new AppError("MIGRATION_REQUIRED", 500, "Missing strategies tables");
    }
    throw error;
  }
}
