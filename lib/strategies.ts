import { randomUUID } from "crypto";
import { sql } from "kysely";

import { ensureDb } from "@/lib/db";
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
  const db = await ensureDb();

  try {
    if (scope === "shared") {
      try {
        const rows = await db
          .selectFrom("strategies as s")
          .leftJoin(
            db
              .selectFrom("strategy_roles")
              .select(["strategy_id", sql<number>`count(1)::int`.as("role_count")])
              .groupBy("strategy_id")
              .as("r"),
            "r.strategy_id",
            "s.id"
          )
          .leftJoin(
            db
              .selectFrom("strategy_favorites")
              .select(["strategy_id", sql<number>`count(1)::int`.as("favorite_count")])
              .groupBy("strategy_id")
              .as("f"),
            "f.strategy_id",
            "s.id"
          )
          .leftJoin(
            db
              .selectFrom("strategies")
              .select(["forked_from_strategy_id as strategy_id", sql<number>`count(1)::int`.as("fork_count")])
              .where("forked_from_strategy_id", "is not", null)
              .groupBy("forked_from_strategy_id")
              .as("k"),
            "k.strategy_id",
            "s.id"
          )
          .selectAll("s")
          .select([
            sql<number>`coalesce(r.role_count, 0)::int`.as("role_count"),
            sql<number>`coalesce(f.favorite_count, 0)::int`.as("favorite_count"),
            sql<number>`coalesce(k.fork_count, 0)::int`.as("fork_count"),
            sql<boolean>`exists(
              select 1
                from strategy_favorites sf
               where sf.strategy_id = s.id and sf.user_id = ${session.userId}
            )`.as("is_favorited")
          ])
          .where("s.is_shared", "=", true)
          .orderBy("s.updated_at", "desc")
          .limit(200)
          .execute();
        return rows.map((row) => ({
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
          const rows = await db
            .selectFrom("strategies as s")
            .leftJoin(
              db
                .selectFrom("strategy_roles")
                .select(["strategy_id", sql<number>`count(1)::int`.as("role_count")])
                .groupBy("strategy_id")
                .as("r"),
              "r.strategy_id",
              "s.id"
            )
            .selectAll("s")
            .select(sql<number>`coalesce(r.role_count, 0)::int`.as("role_count"))
            .where("s.is_shared", "=", true)
            .orderBy("s.updated_at", "desc")
            .limit(200)
            .execute();
          return rows.map((row) =>
            toListItem(normalizeStrategyRow(row), Number(row.role_count ?? 0))
          );
        }
        throw error;
      }
    }

    const rows = await db
      .selectFrom("strategies as s")
      .leftJoin(
        db
          .selectFrom("strategy_roles")
          .select(["strategy_id", sql<number>`count(1)::int`.as("role_count")])
          .groupBy("strategy_id")
          .as("r"),
        "r.strategy_id",
        "s.id"
      )
      .selectAll("s")
      .select(sql<number>`coalesce(r.role_count, 0)::int`.as("role_count"))
      .where("s.owner_user_id", "=", session.userId)
      .orderBy("s.updated_at", "desc")
      .limit(200)
      .execute();
    return rows.map((row) =>
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
    const db = await ensureDb();
    const row = await db
      .selectFrom("strategies")
      .selectAll()
      .where("id", "=", id)
      .where((eb) => eb.or([eb("owner_user_id", "=", session.userId), eb("is_shared", "=", true)]))
      .executeTakeFirst();
    if (!row) {
      throw new AppError("NOT_FOUND", 404, "Strategy not found");
    }
    const strategy = normalizeStrategyRow(row);
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
  const db = await ensureDb();

  try {
    let favoriteCount = 0;
    let forkCount = 0;
    let isFavorited = false;
    if (strategy.isShared) {
      const session = await requireSessionUser();
      try {
        const [favoriteCountRow, isFavRow, forkCountRow] = await Promise.all([
          db
            .selectFrom("strategy_favorites")
            .select(sql<number>`count(1)::int`.as("count"))
            .where("strategy_id", "=", strategy.id)
            .executeTakeFirst(),
          db
            .selectNoFrom([
              sql<boolean>`exists(
                select 1
                  from strategy_favorites
                 where strategy_id = ${strategy.id}
                   and user_id = ${session.userId}
              )`.as("ok")
            ])
            .executeTakeFirst(),
          db
            .selectFrom("strategies")
            .select(sql<number>`count(1)::int`.as("count"))
            .where("forked_from_strategy_id", "=", strategy.id)
            .executeTakeFirst()
        ]);
        favoriteCount = favoriteCountRow?.count ?? 0;
        isFavorited = Boolean(isFavRow?.ok);
        forkCount = forkCountRow?.count ?? 0;
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

    const roleRows = await db
      .selectFrom("strategy_roles")
      .selectAll()
      .where("strategy_id", "=", strategy.id)
      .orderBy("role_order", "asc")
      .execute();
    const roles = roleRows.map((row) => normalizeStrategyRoleRow(row));

    const roleIds = roles.map((role) => role.id);
    let files: Array<{
      roleId: string;
      path: string;
      content: string;
      createdAt: string;
      updatedAt: string;
    }> = [];

    if (roleIds.length > 0) {
      const fileRows = await db
        .selectFrom("strategy_role_files")
        .select(["strategy_role_id", "path", "content", "created_at", "updated_at"])
        .where("strategy_role_id", "in", roleIds)
        .orderBy("strategy_role_id", "asc")
        .orderBy("path", "asc")
        .execute();
      files = fileRows.map((row) => ({
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
  try {
    const db = await ensureDb();
    await db.transaction().execute(async (trx) => {
      await trx
        .updateTable("strategies")
        .set({
          name: manifest.strategy.name,
          description: manifest.strategy.description ?? null,
          is_shared: manifest.strategy.isShared,
          updated_at: now
        })
        .where("id", "=", strategyId)
        .where("owner_user_id", "=", strategy.ownerUserId)
        .execute();

      const existingRoles = await trx
        .selectFrom("strategy_roles")
        .select("id")
        .where("strategy_id", "=", strategyId)
        .execute();
      const existingRoleIds = existingRoles.map((row) => row.id);
      if (existingRoleIds.length > 0) {
        await trx.deleteFrom("strategy_role_files").where("strategy_role_id", "in", existingRoleIds).execute();
      }
      await trx.deleteFrom("strategy_roles").where("strategy_id", "=", strategyId).execute();

      for (const role of nextRoles) {
        await trx
          .insertInto("strategy_roles")
          .values({
            id: role.id,
            strategy_id: strategyId,
            name: role.name,
            system_prompt: role.systemPrompt,
            role_order: role.roleOrder,
            created_at: now,
            updated_at: now
          })
          .execute();

        for (const file of role.files) {
          await trx
            .insertInto("strategy_role_files")
            .values({
              id: randomUUID(),
              strategy_role_id: role.id,
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
    if (
      isMissingTableError(error, "strategies") ||
      isMissingTableError(error, "strategy_roles") ||
      isMissingTableError(error, "strategy_role_files")
    ) {
      throw new AppError("MIGRATION_REQUIRED", 500, "Missing strategies tables");
    }
    throw error;
  }

  return getStrategyDetail(strategyId);
}

export async function favoriteStrategy(id: string) {
  const session = await requireSessionUser();
  try {
    const db = await ensureDb();
    const visible = await db
      .selectFrom("strategies")
      .select("id")
      .where("id", "=", id)
      .where("is_shared", "=", true)
      .executeTakeFirst();
    if (!visible) {
      throw new AppError("NOT_FOUND", 404, "Strategy not found");
    }
    await db
      .insertInto("strategy_favorites")
      .values({
        user_id: session.userId,
        strategy_id: id,
        created_at: new Date().toISOString()
      })
      .onConflict((oc) => oc.columns(["user_id", "strategy_id"]).doNothing())
      .execute();
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
    const db = await ensureDb();
    await db
      .deleteFrom("strategy_favorites")
      .where("user_id", "=", session.userId)
      .where("strategy_id", "=", id)
      .execute();
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
  try {
    const db = await ensureDb();
    const now = new Date().toISOString();
    const forkId = randomUUID();
    await db.transaction().execute(async (trx) => {
      const sourceRow = await trx
        .selectFrom("strategies")
        .selectAll()
        .where("id", "=", id)
        .where("is_shared", "=", true)
        .executeTakeFirst();
      if (!sourceRow) {
        throw new AppError("NOT_FOUND", 404, "Strategy not found");
      }
      const source = normalizeStrategyRow(sourceRow);
      const forkName = `${source.name}（Fork）`;

      await trx
        .insertInto("strategies")
        .values({
          id: forkId,
          owner_user_id: session.userId,
          name: forkName,
          description: source.description,
          is_shared: false,
          forked_from_strategy_id: source.id,
          created_at: now,
          updated_at: now
        })
        .execute();

      const roles = await trx
        .selectFrom("strategy_roles")
        .selectAll()
        .where("strategy_id", "=", source.id)
        .orderBy("role_order", "asc")
        .execute();

      const roleIdMap = new Map<string, string>();
      for (const role of roles) {
        const newRoleId = randomUUID();
        roleIdMap.set(role.id, newRoleId);
        await trx
          .insertInto("strategy_roles")
          .values({
            id: newRoleId,
            strategy_id: forkId,
            name: role.name,
            system_prompt: role.system_prompt,
            role_order: role.role_order,
            created_at: now,
            updated_at: now
          })
          .execute();
      }

      const sourceRoleIds = roles.map((role) => role.id);
      if (sourceRoleIds.length > 0) {
        const files = await trx
          .selectFrom("strategy_role_files")
          .select(["strategy_role_id", "path", "content"])
          .where("strategy_role_id", "in", sourceRoleIds)
          .orderBy("strategy_role_id", "asc")
          .orderBy("path", "asc")
          .execute();

        for (const file of files) {
          const newRoleId = roleIdMap.get(file.strategy_role_id);
          if (!newRoleId) continue;
          await trx
            .insertInto("strategy_role_files")
            .values({
              id: randomUUID(),
              strategy_role_id: newRoleId,
              path: file.path,
              content: file.content ?? "",
              created_at: now,
              updated_at: now
            })
            .execute();
        }
      }
    });
    return { id: forkId };
  } catch (error) {
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
  }
}

export async function createStrategy(input: unknown) {
  const data = createStrategySchema.parse(input);
  const session = await requireSessionUser();

  const now = new Date().toISOString();
  const strategyId = randomUUID();

  try {
    const db = await ensureDb();
    await db.transaction().execute(async (trx) => {
      await trx
        .insertInto("strategies")
        .values({
          id: strategyId,
          owner_user_id: session.userId,
          name: data.name,
          description: data.description ?? null,
          is_shared: data.isShared,
          created_at: now,
          updated_at: now
        })
        .execute();

      for (let index = 0; index < data.roles.length; index += 1) {
        const role = data.roles[index];
        const roleId = randomUUID();
        await trx
          .insertInto("strategy_roles")
          .values({
            id: roleId,
            strategy_id: strategyId,
            name: role.name,
            system_prompt: role.systemPrompt ?? null,
            role_order: index + 1,
            created_at: now,
            updated_at: now
          })
          .execute();

        for (const file of role.files ?? []) {
          await trx
            .insertInto("strategy_role_files")
            .values({
              id: randomUUID(),
              strategy_role_id: roleId,
              path: file.path,
              content: file.content ?? "",
              created_at: now,
              updated_at: now
            })
            .execute();
        }
      }
    });
  } catch (error) {
    if (
      isMissingTableError(error, "strategies") ||
      isMissingTableError(error, "strategy_roles") ||
      isMissingTableError(error, "strategy_role_files")
    ) {
      throw new AppError("MIGRATION_REQUIRED", 500, "Missing strategies tables");
    }
    throw error;
  }

  return getStrategyDetail(strategyId);
}

export async function updateStrategy(id: string, input: unknown) {
  const data = updateStrategySchema.parse(input);
  const session = await requireSessionUser();

  const now = new Date().toISOString();

  try {
    const db = await ensureDb();
    await db.transaction().execute(async (trx) => {
      const existing = await trx
        .selectFrom("strategies")
        .selectAll()
        .where("id", "=", id)
        .where("owner_user_id", "=", session.userId)
        .executeTakeFirst();
      if (!existing) {
        throw new AppError("NOT_FOUND", 404, "Strategy not found");
      }

      await trx
        .updateTable("strategies")
        .set({
          name: data.name,
          description: data.description ?? null,
          is_shared: data.isShared,
          updated_at: now
        })
        .where("id", "=", id)
        .where("owner_user_id", "=", session.userId)
        .execute();

      const existingRoles = await trx
        .selectFrom("strategy_roles")
        .selectAll()
        .where("strategy_id", "=", id)
        .execute();
      const existingRoleIds = new Set(existingRoles.map((row) => String(row.id)));

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
          await trx
            .deleteFrom("strategy_roles")
            .where("id", "=", roleId)
            .where("strategy_id", "=", id)
            .execute();
        }
      }

      for (const role of desired) {
        if (role.isNew) {
          await trx
            .insertInto("strategy_roles")
            .values({
              id: role.id,
              strategy_id: id,
              name: role.name,
              system_prompt: role.systemPrompt,
              role_order: role.roleOrder,
              created_at: now,
              updated_at: now
            })
            .execute();
        } else {
          await trx
            .updateTable("strategy_roles")
            .set({
              name: role.name,
              system_prompt: role.systemPrompt,
              role_order: role.roleOrder,
              updated_at: now
            })
            .where("id", "=", role.id)
            .where("strategy_id", "=", id)
            .execute();
        }
      }
    });
  } catch (error) {
    if (
      isMissingTableError(error, "strategies") ||
      isMissingTableError(error, "strategy_roles") ||
      isMissingTableError(error, "strategy_role_files")
    ) {
      throw new AppError("MIGRATION_REQUIRED", 500, "Missing strategies tables");
    }
    throw error;
  }

  return getStrategyDetail(id);
}

export async function deleteStrategy(id: string) {
  const session = await requireSessionUser();
  try {
    const db = await ensureDb();
    const result = await db
      .deleteFrom("strategies")
      .where("id", "=", id)
      .where("owner_user_id", "=", session.userId)
      .executeTakeFirst();
    if (Number(result.numDeletedRows ?? 0) !== 1) {
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
  const now = new Date().toISOString();

  try {
    const newRoleId = randomUUID();
    const db = await ensureDb();
    const duplicated = await db.transaction().execute(async (trx) => {
      const strategyResult = await trx
        .selectFrom("strategies")
        .select("id")
        .where("id", "=", strategyId)
        .where("owner_user_id", "=", session.userId)
        .executeTakeFirst();
      if (!strategyResult) {
        throw new AppError("NOT_FOUND", 404, "Strategy not found");
      }

      const roleResult = await trx
        .selectFrom("strategy_roles")
        .select(["name", "system_prompt"])
        .where("id", "=", roleId)
        .where("strategy_id", "=", strategyId)
        .executeTakeFirst();
      if (!roleResult) {
        throw new AppError("NOT_FOUND", 404, "Strategy role not found");
      }

      const nextOrderRow = await trx
        .selectFrom("strategy_roles")
        .select(sql<number>`(coalesce(max(role_order), 0) + 1)::int`.as("next"))
        .where("strategy_id", "=", strategyId)
        .executeTakeFirst();
      const nextOrder = nextOrderRow?.next ?? 1;

      await trx
        .insertInto("strategy_roles")
        .values({
          id: newRoleId,
          strategy_id: strategyId,
          name: roleResult.name,
          system_prompt: roleResult.system_prompt ?? null,
          role_order: nextOrder,
          created_at: now,
          updated_at: now
        })
        .execute();

      const sourceFiles = await trx
        .selectFrom("strategy_role_files")
        .select(["path", "content"])
        .where("strategy_role_id", "=", roleId)
        .orderBy("path", "asc")
        .execute();
      for (const file of sourceFiles) {
        await trx
          .insertInto("strategy_role_files")
          .values({
            id: randomUUID(),
            strategy_role_id: newRoleId,
            path: file.path,
            content: file.content,
            created_at: now,
            updated_at: now
          })
          .execute();
      }

      return { newName: roleResult.name, nextOrder };
    });
    return { id: newRoleId, name: duplicated.newName, roleOrder: duplicated.nextOrder };
  } catch (error) {
    if (
      isMissingTableError(error, "strategies") ||
      isMissingTableError(error, "strategy_roles") ||
      isMissingTableError(error, "strategy_role_files")
    ) {
      throw new AppError("MIGRATION_REQUIRED", 500, "Missing strategies tables");
    }
    throw error;
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
    const db = await ensureDb();
    const rows = await db
      .selectFrom("strategy_roles as r")
      .leftJoin("strategy_role_files as f", (join) =>
        join.onRef("f.strategy_role_id", "=", "r.id").on("f.path", "=", STRATEGY_WORKFLOW_PATH)
      )
      .select(["r.id", "r.name", "r.role_order", "f.content as workflow_content"])
      .where("r.strategy_id", "=", strategy.id)
      .orderBy("r.role_order", "asc")
      .execute();
    if (rows.length <= 0) {
      throw new AppError("VALIDATION_ERROR", 400, "Strategy has no roles");
    }

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
  try {
    const db = await ensureDb();
    await db.transaction().execute(async (trx) => {
      await trx
        .insertInto("strategy_role_files")
        .values({
          id: randomUUID(),
          strategy_role_id: state.ownerRoleId,
          path: STRATEGY_WORKFLOW_PATH,
          content,
          created_at: now,
          updated_at: now
        })
        .onConflict((oc) =>
          oc.columns(["strategy_role_id", "path"]).doUpdateSet({
            content,
            updated_at: now
          })
        )
        .execute();
      await trx
        .deleteFrom("strategy_role_files")
        .where("path", "=", STRATEGY_WORKFLOW_PATH)
        .where("strategy_role_id", "in", state.roleIds)
        .where("strategy_role_id", "!=", state.ownerRoleId)
        .execute();
    });
  } catch (error) {
    if (isMissingTableError(error, "strategy_role_files")) {
      throw new AppError("MIGRATION_REQUIRED", 500, "Missing strategies tables");
    }
    throw error;
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
  try {
    const db = await ensureDb();
    await db.transaction().execute(async (trx) => {
      await trx
        .insertInto("strategy_role_files")
        .values({
          id: randomUUID(),
          strategy_role_id: state.ownerRoleId,
          path: STRATEGY_WORKFLOW_PATH,
          content,
          created_at: now,
          updated_at: now
        })
        .onConflict((oc) =>
          oc.columns(["strategy_role_id", "path"]).doUpdateSet({
            content,
            updated_at: now
          })
        )
        .execute();
      await trx
        .deleteFrom("strategy_role_files")
        .where("path", "=", STRATEGY_WORKFLOW_PATH)
        .where("strategy_role_id", "in", state.roleIds)
        .where("strategy_role_id", "!=", state.ownerRoleId)
        .execute();
    });
  } catch (error) {
    if (isMissingTableError(error, "strategy_role_files")) {
      throw new AppError("MIGRATION_REQUIRED", 500, "Missing strategies tables");
    }
    throw error;
  }

  return buildStrategyWorkflowPhasePromptResponse(canonicalWorkflow, state.ownerRoleId, true, true);
}

async function requireVisibleStrategyRole(strategyId: string, roleId: string) {
  const session = await requireSessionUser();
  try {
    const db = await ensureDb();
    const result = await db
      .selectFrom("strategies as s")
      .innerJoin("strategy_roles as r", "r.strategy_id", "s.id")
      .select(["s.owner_user_id", "s.is_shared"])
      .where("s.id", "=", strategyId)
      .where("r.id", "=", roleId)
      .where((eb) => eb.or([eb("s.owner_user_id", "=", session.userId), eb("s.is_shared", "=", true)]))
      .limit(1)
      .executeTakeFirst();
    if (!result) {
      throw new AppError("NOT_FOUND", 404, "Strategy role not found");
    }
    const ownerUserId = String(result.owner_user_id);
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
    const db = await ensureDb();
    const result = await db
      .selectFrom("strategy_role_files")
      .select(["path", "created_at", "updated_at"])
      .where("strategy_role_id", "=", roleId)
      .orderBy("path", "asc")
      .execute();
    return result.map((row) => ({
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
    const db = await ensureDb();
    const result = await db
      .selectFrom("strategy_role_files")
      .select(["path", "content", "created_at", "updated_at"])
      .where("strategy_role_id", "=", roleId)
      .where("path", "=", path)
      .limit(1)
      .executeTakeFirst();
    if (!result) {
      throw new AppError("NOT_FOUND", 404, "File not found");
    }
    return {
      path: String(result.path),
      content: String(result.content ?? ""),
      createdAt: String(result.created_at),
      updatedAt: String(result.updated_at)
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
    const db = await ensureDb();
    const result = await db
      .insertInto("strategy_role_files")
      .values({
        id: randomUUID(),
        strategy_role_id: roleId,
        path: data.path,
        content: data.content,
        created_at: now,
        updated_at: now
      })
      .onConflict((oc) =>
        oc.columns(["strategy_role_id", "path"]).doUpdateSet({
          content: data.content,
          updated_at: now
        })
      )
      .returning(["path", "content", "created_at", "updated_at"])
      .executeTakeFirstOrThrow();
    return {
      path: String(result.path),
      content: String(result.content ?? ""),
      createdAt: String(result.created_at),
      updatedAt: String(result.updated_at)
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
    const db = await ensureDb();
    const result = await db
      .deleteFrom("strategy_role_files")
      .where("strategy_role_id", "=", roleId)
      .where("path", "=", data.path)
      .executeTakeFirst();
    if (Number(result.numDeletedRows ?? 0) !== 1) {
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
    const db = await ensureDb();
    const result = await db
      .deleteFrom("strategy_role_files")
      .where("strategy_role_id", "=", roleId)
      .where("path", "like", like)
      .executeTakeFirst();
    return { deleted: Number(result.numDeletedRows ?? 0) };
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
    const db = await ensureDb();
    const exists = await db
      .selectFrom("strategy_role_files")
      .select("path")
      .where("strategy_role_id", "=", roleId)
      .where("path", "=", data.toPath)
      .executeTakeFirst();
    if (exists) {
      throw new AppError("CONFLICT", 409, "Target path already exists");
    }

    const updated = await db
      .updateTable("strategy_role_files")
      .set({
        path: data.toPath,
        updated_at: now
      })
      .where("strategy_role_id", "=", roleId)
      .where("path", "=", data.fromPath)
      .returning(["path", "content", "created_at", "updated_at"])
      .executeTakeFirst();
    if (!updated) {
      throw new AppError("NOT_FOUND", 404, "File not found");
    }
    return {
      path: String(updated.path),
      content: String(updated.content ?? ""),
      createdAt: String(updated.created_at),
      updatedAt: String(updated.updated_at)
    };
  } catch (error) {
    if (isMissingTableError(error, "strategy_role_files")) {
      throw new AppError("MIGRATION_REQUIRED", 500, "Missing strategies tables");
    }
    throw error;
  }
}
