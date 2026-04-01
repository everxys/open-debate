import { randomUUID } from "crypto";

import { getPool, query } from "@/lib/db";
import { AppError } from "@/lib/http";
import { readSession } from "@/lib/session";
import {
  agentFileDeleteSchema,
  agentFileMoveSchema,
  agentFileUpsertSchema,
  createStrategySchema,
  relativeFilePathSchema,
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

type StrategyFolderExportEntry = {
  path: string;
  content: string;
  updatedAt?: string | null;
};

type StrategyFolderManifest = {
  formatVersion: 1;
  exportedAt: string;
  strategy: {
    id: string;
    name: string;
    description: string | null;
    isShared: boolean;
  };
  roles: Array<{
    folderName: string;
    name: string;
    roleOrder: number;
    sourceRoleId: string;
  }>;
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

function toPortableSlug(value: string, fallback: string) {
  const cleaned = String(value ?? "")
    .trim()
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (cleaned || fallback).slice(0, 48);
}

function toPortableRoleFolderName(roleOrder: number, roleName: string, roleId: string) {
  const roleLabel = toPortableSlug(roleName, "role");
  return `role-${String(roleOrder).padStart(2, "0")}-${roleLabel}-${roleId.slice(0, 8)}`;
}

function renderStrategyRoleMeta(role: {
  id: string;
  name: string;
  roleOrder: number;
  systemPrompt: string | null;
}) {
  const lines = [
    "# Role Metadata",
    "",
    `- roleId: ${role.id}`,
    `- roleOrder: ${role.roleOrder}`,
    `- roleName: ${role.name}`,
    `- hasSystemPrompt: ${role.systemPrompt ? "yes" : "no"}`
  ];
  return `${lines.join("\n")}\n`;
}

function renderStrategyFolderReadme(manifest: StrategyFolderManifest) {
  const lines = [
    "# Strategy Folder Export",
    "",
    `- strategyId: ${manifest.strategy.id}`,
    `- strategyName: ${manifest.strategy.name}`,
    `- exportedAt: ${manifest.exportedAt}`,
    "",
    "## Import",
    "",
    "在策略详情页使用“上传文件夹覆盖”时，请选择当前目录本身，而不是只选其中单个子目录。",
    "",
    "## Roles",
    ""
  ];
  for (const role of manifest.roles.slice().sort((a, b) => a.roleOrder - b.roleOrder)) {
    lines.push(`- #${role.roleOrder} ${role.name} -> ${role.folderName}/`);
  }
  return `${lines.join("\n")}\n`;
}

function normalizeImportedStrategyRelativePath(value: string) {
  return String(value ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/{2,}/g, "/")
    .replace(/\/+$/, "");
}

function stripStrategyImportRootPrefix(paths: string[]) {
  if (paths.includes("manifest.json")) return paths;
  const firstSegments = Array.from(new Set(paths.map((item) => item.split("/")[0]).filter(Boolean)));
  if (firstSegments.length !== 1) return paths;
  const root = firstSegments[0];
  if (!paths.includes(`${root}/manifest.json`)) return paths;
  return paths
    .filter((item) => item.startsWith(`${root}/`))
    .map((item) => item.slice(root.length + 1));
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

export async function getStrategyFolderExport(id: string) {
  const detail = await getStrategyDetail(id);
  const rootFolderName = `strategy-${toPortableSlug(detail.name, detail.id)}`;
  const manifest: StrategyFolderManifest = {
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    strategy: {
      id: detail.id,
      name: detail.name,
      description: detail.description,
      isShared: detail.isShared
    },
    roles: detail.roles
      .slice()
      .sort((a, b) => a.roleOrder - b.roleOrder)
      .map((role) => ({
        folderName: toPortableRoleFolderName(role.roleOrder, role.name, role.id),
        name: role.name,
        roleOrder: role.roleOrder,
        sourceRoleId: role.id
      }))
  };

  const entries: StrategyFolderExportEntry[] = [
    {
      path: `${rootFolderName}/manifest.json`,
      content: `${JSON.stringify(manifest, null, 2)}\n`
    },
    {
      path: `${rootFolderName}/README.md`,
      content: renderStrategyFolderReadme(manifest)
    }
  ];

  for (const role of detail.roles.slice().sort((a, b) => a.roleOrder - b.roleOrder)) {
    const manifestRole = manifest.roles.find((item) => item.sourceRoleId === role.id);
    if (!manifestRole) continue;
    const roleRoot = `${rootFolderName}/${manifestRole.folderName}`;
    entries.push({
      path: `${roleRoot}/ROLE_META.md`,
      content: renderStrategyRoleMeta(role)
    });
    if (role.systemPrompt && role.systemPrompt.trim()) {
      entries.push({
        path: `${roleRoot}/system_prompt.md`,
        content: role.systemPrompt
      });
    }
    for (const file of (role.files ?? []).slice().sort((a, b) => a.path.localeCompare(b.path))) {
      entries.push({
        path: `${roleRoot}/${file.path}`,
        content: file.content ?? ""
      });
    }
  }

  return {
    strategyId: detail.id,
    strategyName: detail.name,
    filename: `${rootFolderName}.zip`,
    entries
  };
}

export async function overwriteStrategyFromFolderUpload(
  strategyId: string,
  uploadedFiles: Array<{ relativePath: string; content: string }>
) {
  const { strategy, canEdit } = await getStrategyRowById(strategyId);
  if (!canEdit) {
    throw new AppError("FORBIDDEN", 403, "Permission denied");
  }
  if (uploadedFiles.length <= 0) {
    throw new AppError("VALIDATION_ERROR", 400, "No uploaded files found");
  }

  const normalizedPairs = uploadedFiles
    .map((file) => ({
      relativePath: normalizeImportedStrategyRelativePath(file.relativePath),
      content: String(file.content ?? "")
    }))
    .filter((file) => file.relativePath.length > 0);
  const strippedPaths = stripStrategyImportRootPrefix(normalizedPairs.map((file) => file.relativePath));
  const imported = normalizedPairs.map((file, index) => ({
    relativePath: strippedPaths[index] ?? file.relativePath,
    content: file.content
  }));
  const fileMap = new Map(imported.map((file) => [file.relativePath, file.content] as const));

  const manifestRaw = fileMap.get("manifest.json");
  if (!manifestRaw) {
    throw new AppError("VALIDATION_ERROR", 400, "Uploaded folder must contain manifest.json at its root");
  }

  let manifest: StrategyFolderManifest;
  try {
    const parsed = JSON.parse(manifestRaw) as Partial<StrategyFolderManifest>;
    if (parsed.formatVersion !== 1 || !parsed.strategy || !Array.isArray(parsed.roles)) {
      throw new Error("invalid manifest");
    }
    manifest = {
      formatVersion: 1,
      exportedAt: typeof parsed.exportedAt === "string" ? parsed.exportedAt : new Date().toISOString(),
      strategy: {
        id: typeof parsed.strategy.id === "string" ? parsed.strategy.id : strategy.id,
        name: typeof parsed.strategy.name === "string" ? parsed.strategy.name : strategy.name,
        description:
          typeof parsed.strategy.description === "string" || parsed.strategy.description === null
            ? parsed.strategy.description
            : strategy.description,
        isShared: typeof parsed.strategy.isShared === "boolean" ? parsed.strategy.isShared : strategy.isShared
      },
      roles: parsed.roles
        .map((role) => ({
          folderName: typeof role.folderName === "string" ? role.folderName : "",
          name: typeof role.name === "string" ? role.name : "",
          roleOrder: typeof role.roleOrder === "number" ? Math.floor(role.roleOrder) : 0,
          sourceRoleId: typeof role.sourceRoleId === "string" ? role.sourceRoleId : ""
        }))
        .filter((role) => role.folderName && role.name && role.roleOrder > 0)
    };
  } catch {
    throw new AppError("VALIDATION_ERROR", 400, "Invalid strategy folder manifest");
  }

  if (manifest.roles.length < 2) {
    throw new AppError("VALIDATION_ERROR", 400, "Imported strategy folder must contain at least 2 roles");
  }

  const nextRoles = manifest.roles
    .slice()
    .sort((a, b) => a.roleOrder - b.roleOrder)
    .map((role) => {
      const prefix = `${role.folderName}/`;
      const systemPrompt = fileMap.get(`${role.folderName}/system_prompt.md`) ?? null;
      const files = Array.from(fileMap.entries())
        .filter(([relativePath]) => relativePath.startsWith(prefix))
        .filter(([relativePath]) => relativePath !== `${role.folderName}/ROLE_META.md`)
        .filter(([relativePath]) => relativePath !== `${role.folderName}/system_prompt.md`)
        .map(([relativePath, content]) => ({
          path: relativeFilePathSchema.parse(relativePath.slice(prefix.length)),
          content: agentFileUpsertSchema.parse({
            path: relativePath.slice(prefix.length),
            content
          }).content
        }))
        .sort((a, b) => a.path.localeCompare(b.path));

      return {
        id: randomUUID(),
        name: role.name,
        roleOrder: role.roleOrder,
        systemPrompt,
        files
      };
    });

  const now = new Date().toISOString();
  const client = await getTransactionClient();
  try {
    await client.query("begin");

    await client.query(
      `
        update strategies
           set name = $3,
               description = $4,
               is_shared = $5,
               updated_at = $6
         where id = $1 and owner_user_id = $2
      `,
      [strategyId, strategy.ownerUserId, manifest.strategy.name, manifest.strategy.description ?? null, manifest.strategy.isShared, now]
    );

    const existingRoles = await client.query<{ id: string }>(
      "select id from strategy_roles where strategy_id = $1",
      [strategyId]
    );
    const existingRoleIds = existingRoles.rows.map((row) => row.id);
    if (existingRoleIds.length > 0) {
      await client.query("delete from strategy_role_files where strategy_role_id = any($1::uuid[])", [existingRoleIds]);
    }
    await client.query("delete from strategy_roles where strategy_id = $1", [strategyId]);

    for (const role of nextRoles) {
      await client.query(
        `
          insert into strategy_roles (id, strategy_id, name, system_prompt, role_order, created_at, updated_at)
          values ($1,$2,$3,$4,$5,$6,$6)
        `,
        [role.id, strategyId, role.name, role.systemPrompt, role.roleOrder, now]
      );

      for (const file of role.files) {
        await client.query(
          `
            insert into strategy_role_files (id, strategy_role_id, path, content, created_at, updated_at)
            values ($1,$2,$3,$4,$5,$5)
          `,
          [randomUUID(), role.id, file.path, file.content, now]
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
