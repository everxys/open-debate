import { randomUUID } from "node:crypto";

import { sql, type Kysely, type Transaction } from "kysely";

import { ensureDb } from "@/lib/db";
import type { OpenDebateDb } from "@/lib/db-schema";
import { indexDebateContextChunk, splitTextIntoRetrievalChunks } from "@/lib/retrieval";
import { appendServerLog } from "@/lib/server-log";
import {
  describeContextAccessDenied,
  hasContextAccessRules,
  isContextPathReadable,
  normalizeContextPath
} from "@/lib/runtime/context-inline";
import { readDebateFile } from "@/lib/runtime/file-store";
import {
  appendDebateFileContent,
  describeLegacyFinalWriteError,
  isFinalDebateOutputPath,
  mergeMarkdownSectionByHeading,
  normalizeDebateFileWriteMode,
  normalizeDebateOutputPath,
  shouldRejectDeliverableShrink,
  type DebateFileWriteMode
} from "@/lib/runtime/tools";
import { getPgErrorCode } from "@/lib/runtime/runtime-utils";
import type { NormalizedDebateWorkflow, WorkflowPhaseKind } from "@/lib/workflow";

export type DebateFileActivityAction = "read" | "write" | "search" | "list" | "stat";
export type DebateFileActivityAudit = {
  debateId: string;
  debateAgentId: string;
  turnNumber: number;
  roundNumber: number;
  now: string;
};

export type SeatFileSource = "debate" | "agent";
export type SeatFileEntry = {
  path: string;
  content: string;
  source: SeatFileSource;
};

type DbLike = Kysely<OpenDebateDb> | Transaction<OpenDebateDb>;
type DebateFileReadPolicy =
  | {
      workflow: NormalizedDebateWorkflow | null;
      currentPhaseKind: WorkflowPhaseKind | null | undefined;
    }
  | null;
type DebateFileToolAudit =
  | {
      debateId: string;
      turnNumber: number;
      roundNumber: number;
      now: string;
    }
  | null;

function normalizeSeatFilePath(path: string) {
  return path.replace(/\\/g, "/").replace(/^\/+/, "").trim();
}

async function listRawDebateSeatFiles(userId: string, debateAgentId: string, prefix = "") {
  try {
    const prefixLike = `${prefix}%`;
    const db = await ensureDb();
    const result = await db
      .selectFrom("debate_agent_files as f")
      .innerJoin("debate_agents as da", "da.id", "f.debate_agent_id")
      .innerJoin("debates as d", "d.id", "da.debate_id")
      .select(["f.path", "f.content"])
      .where("f.debate_agent_id", "=", debateAgentId)
      .where("d.user_id", "=", userId)
      .where("f.path", "like", prefixLike)
      .orderBy("f.path", "asc")
      .execute();
    return result.map((row) => ({
      path: String(row.path ?? ""),
      content: String(row.content ?? ""),
      source: "debate" as const
    }));
  } catch (error) {
    if (isMissingTableError(error, "debate_agent_files")) return [] as SeatFileEntry[];
    throw error;
  }
}

async function listRawAgentFiles(userId: string, agentId: string, prefix = "") {
  try {
    const prefixLike = `${prefix}%`;
    const db = await ensureDb();
    const result = await db
      .selectFrom("ai_agent_files as f")
      .innerJoin("ai_agents as a", "a.id", "f.ai_agent_id")
      .select(["f.path", "f.content"])
      .where("f.ai_agent_id", "=", agentId)
      .where("a.user_id", "=", userId)
      .where("f.path", "like", prefixLike)
      .orderBy("f.path", "asc")
      .execute();
    return result.map((row) => ({
      path: String(row.path ?? ""),
      content: String(row.content ?? ""),
      source: "agent" as const
    }));
  } catch (error) {
    if (getPgErrorCode(error) === "42P01") return [] as SeatFileEntry[];
    throw error;
  }
}

export async function listMergedSeatFiles(userId: string, debateAgentId: string, agentId: string, prefix = "") {
  const [agentFiles, debateFiles] = await Promise.all([
    listRawAgentFiles(userId, agentId, prefix),
    listRawDebateSeatFiles(userId, debateAgentId, prefix)
  ]);
  const merged = new Map<string, SeatFileEntry>();
  for (const file of agentFiles) {
    merged.set(normalizeSeatFilePath(file.path), file);
  }
  for (const file of debateFiles) {
    merged.set(normalizeSeatFilePath(file.path), file);
  }
  return [...merged.values()].sort((left, right) => left.path.localeCompare(right.path));
}

export function isMissingTableError(error: unknown, table: string) {
  if (typeof error !== "object" || error === null) return false;
  const anyError = error as { code?: unknown; message?: unknown };
  if (anyError.code !== "42P01") return false;
  const message = typeof anyError.message === "string" ? anyError.message : "";
  return message.toLowerCase().includes(table.toLowerCase());
}

export async function toolListFiles(
  userId: string,
  debateAgentId: string,
  agentId: string,
  prefix?: string,
  audit: DebateFileToolAudit = null,
  policy: DebateFileReadPolicy = null
) {
  const effectivePrefix = (prefix ?? "").trim();
  if (policy && hasContextAccessRules(policy.workflow) && effectivePrefix) {
    if (!isContextPathReadable(policy.workflow, policy.currentPhaseKind, "seat", effectivePrefix)) {
      return [describeContextAccessDenied(policy.workflow, policy.currentPhaseKind, "seat", effectivePrefix) ?? `ACCESS_DENIED: ${effectivePrefix}`];
    }
  }
  try {
    const rows = await listMergedSeatFiles(userId, debateAgentId, agentId, effectivePrefix);
    if (rows.length > 0) {
      const paths = rows
        .map((row) => String(row.path))
        .filter((path) => (policy ? isContextPathReadable(policy.workflow, policy.currentPhaseKind, "seat", path) : true));
      if (audit) {
        for (const row of rows.filter((item) => paths.includes(item.path)).slice(0, 20)) {
          // eslint-disable-next-line no-await-in-loop
          await recordDebateFileActivity({
            debateId: audit.debateId,
            debateAgentId,
            turnNumber: audit.turnNumber,
            roundNumber: audit.roundNumber,
            action: "list",
            scope: "agent",
            path: row.path,
            targetDebateAgentId: row.source === "debate" ? debateAgentId : null,
            now: audit.now
          });
        }
      }
      return paths;
    }
  } catch (error) {
    if (!isMissingTableError(error, "debate_agent_files")) {
      throw error;
    }
  }

  return toolListFilesFromAgent(userId, debateAgentId, agentId, prefix, audit, policy);
}

export async function toolListFilesFromAgent(
  userId: string,
  debateAgentId: string,
  agentId: string,
  prefix?: string,
  audit: DebateFileToolAudit = null,
  policy: DebateFileReadPolicy = null
) {
  try {
    const prefixLike = `${(prefix ?? "").trim()}%`;
    const db = await ensureDb();
    const result = await db
      .selectFrom("ai_agent_files as f")
      .innerJoin("ai_agents as a", "a.id", "f.ai_agent_id")
      .select("f.path")
      .where("f.ai_agent_id", "=", agentId)
      .where("a.user_id", "=", userId)
      .where("f.path", "like", prefixLike)
      .orderBy("f.path", "asc")
      .limit(200)
      .execute();
    const paths = result
      .map((row) => String(row.path))
      .filter((path) => (policy ? isContextPathReadable(policy.workflow, policy.currentPhaseKind, "seat", path) : true));
    if (audit) {
      for (const path of paths.slice(0, 20)) {
        // eslint-disable-next-line no-await-in-loop
        await recordDebateFileActivity({
          debateId: audit.debateId,
          debateAgentId,
          turnNumber: audit.turnNumber,
          roundNumber: audit.roundNumber,
          action: "list",
          scope: "agent",
          path,
          targetDebateAgentId: null,
          now: audit.now
        });
      }
    }
    return paths;
  } catch (error) {
    if (getPgErrorCode(error) === "42P01") return [];
    throw error;
  }
}

export async function toolReadFile(
  userId: string,
  debateAgentId: string,
  agentId: string,
  path: string,
  audit: DebateFileToolAudit,
  policy: DebateFileReadPolicy = null
) {
  if (policy && !isContextPathReadable(policy.workflow, policy.currentPhaseKind, "seat", path)) {
    return describeContextAccessDenied(policy.workflow, policy.currentPhaseKind, "seat", path) ?? `ACCESS_DENIED: ${path}`;
  }
  const files = await listMergedSeatFiles(userId, debateAgentId, agentId);
  const matched = files.find((file) => file.path === normalizeSeatFilePath(path) || file.path === path);
  if (matched) {
    if (audit) {
      await recordDebateFileActivity({
        debateId: audit.debateId,
        debateAgentId,
        turnNumber: audit.turnNumber,
        roundNumber: audit.roundNumber,
        action: "read",
        scope: "agent",
        path: matched.path,
        targetDebateAgentId: matched.source === "debate" ? debateAgentId : null,
        now: audit.now
      });
    }
    return matched.content;
  }
  return `NOT_FOUND: ${path}`;
}

export async function toolReadDebateFile(
  userId: string,
  debateAgentId: string,
  debateId: string,
  path: string,
  auditNow: string,
  turnNumber: number,
  roundNumber: number,
  policy: NonNullable<DebateFileReadPolicy>
) {
  if (!hasContextAccessRules(policy.workflow)) {
    return `ACCESS_DENIED: ${path} requires workflow.contextAccess rule`;
  }
  if (!isContextPathReadable(policy.workflow, policy.currentPhaseKind, "shared", path)) {
    return describeContextAccessDenied(policy.workflow, policy.currentPhaseKind, "shared", path) ?? `ACCESS_DENIED: ${path}`;
  }
  const content = await readDebateFile(userId, debateId, path);
  if (content !== null) {
    await recordDebateFileActivity({
      debateId,
      debateAgentId,
      turnNumber,
      roundNumber,
      action: "read",
      scope: "debate",
      path,
      now: auditNow
    });
  }
  return content ?? `NOT_FOUND: ${path}`;
}

export async function toolReadFileFromAgent(
  userId: string,
  debateAgentId: string,
  agentId: string,
  path: string,
  audit: DebateFileToolAudit
) {
  try {
    const db = await ensureDb();
    const result = await db
      .selectFrom("ai_agent_files as f")
      .innerJoin("ai_agents as a", "a.id", "f.ai_agent_id")
      .select("f.content")
      .where("f.ai_agent_id", "=", agentId)
      .where("a.user_id", "=", userId)
      .where("f.path", "=", path)
      .limit(1)
      .executeTakeFirst();
    if (!result) {
      return `NOT_FOUND: ${path}`;
    }
    const content = String(result.content ?? "");
    if (audit) {
      await recordDebateFileActivity({
        debateId: audit.debateId,
        debateAgentId,
        turnNumber: audit.turnNumber,
        roundNumber: audit.roundNumber,
        action: "read",
        scope: "agent",
        path,
        targetDebateAgentId: null,
        now: audit.now
      });
    }
    return content;
  } catch (error) {
    if (getPgErrorCode(error) === "42P01") {
      return "MIGRATION_REQUIRED: ai_agent_files table missing";
    }
    throw error;
  }
}

export async function toolSearchFiles(
  userId: string,
  debateAgentId: string,
  agentId: string,
  queryText: string,
  audit: DebateFileToolAudit = null,
  policy: DebateFileReadPolicy = null
) {
  const searchQuery = queryText.trim();
  if (!searchQuery) return [];

  const rows = (await listMergedSeatFiles(userId, debateAgentId, agentId))
    .filter((row) => row.content.toLowerCase().includes(searchQuery.toLowerCase()))
    .filter((row) => (policy ? isContextPathReadable(policy.workflow, policy.currentPhaseKind, "seat", String(row.path ?? "")) : true))
    .slice(0, 5)
    .map((row) => {
      const content = String(row.content ?? "");
      const lower = content.toLowerCase();
      const idx = lower.indexOf(searchQuery.toLowerCase());
      const start = Math.max(0, idx - 120);
      const end = Math.min(content.length, idx + searchQuery.length + 120);
      const snippet = content.slice(start, end);
      return { path: String(row.path), snippet, source: row.source };
    });
  if (rows.length > 0) {
    if (audit) {
      for (const row of rows) {
        // eslint-disable-next-line no-await-in-loop
        await recordDebateFileActivity({
          debateId: audit.debateId,
          debateAgentId,
          turnNumber: audit.turnNumber,
          roundNumber: audit.roundNumber,
          action: "search",
          scope: "agent",
          path: row.path,
          targetDebateAgentId: row.source === "debate" ? debateAgentId : null,
          now: audit.now
        });
      }
    }
    return rows.map(({ path, snippet }) => ({ path, snippet }));
  }

  return toolSearchFilesFromAgent(userId, debateAgentId, agentId, queryText, audit, policy);
}

export async function toolSearchFilesFromAgent(
  userId: string,
  debateAgentId: string,
  agentId: string,
  queryText: string,
  audit: DebateFileToolAudit = null,
  policy: DebateFileReadPolicy = null
) {
  const searchQuery = queryText.trim();
  if (!searchQuery) return [];
  try {
    const db = await ensureDb();
    const result = await db
      .selectFrom("ai_agent_files as f")
      .innerJoin("ai_agents as a", "a.id", "f.ai_agent_id")
      .select(["f.path", "f.content"])
      .where("f.ai_agent_id", "=", agentId)
      .where("a.user_id", "=", userId)
      .where("f.content", "ilike", `%${searchQuery}%`)
      .orderBy("f.path", "asc")
      .limit(5)
      .execute();

    const rows = result
      .filter((row) => (policy ? isContextPathReadable(policy.workflow, policy.currentPhaseKind, "seat", String(row.path ?? "")) : true))
      .map((row) => {
        const content = String(row.content ?? "");
        const lower = content.toLowerCase();
        const idx = lower.indexOf(searchQuery.toLowerCase());
        const start = Math.max(0, idx - 120);
        const end = Math.min(content.length, idx + searchQuery.length + 120);
        const snippet = content.slice(start, end);
        return { path: String(row.path), snippet };
      });
    if (audit) {
      for (const row of rows) {
        // eslint-disable-next-line no-await-in-loop
        await recordDebateFileActivity({
          debateId: audit.debateId,
          debateAgentId,
          turnNumber: audit.turnNumber,
          roundNumber: audit.roundNumber,
          action: "search",
          scope: "agent",
          path: row.path,
          targetDebateAgentId: null,
          now: audit.now
        });
      }
    }
    return rows;
  } catch (error) {
    if (getPgErrorCode(error) === "42P01") return [];
    throw error;
  }
}

export async function getDebateFileMeta(db: DbLike, debateId: string, path: string) {
  const result = await db.executeQuery<{ content: string; created_at: string; updated_at: string; version: number }>(sql`
    select content, created_at, updated_at, version
      from debate_files
     where debate_id = ${debateId}
       and path = ${path}
     limit 1
     for update
  `.compile(db));
  if ((result.rows.length ?? 0) !== 1) return null;
  return {
    content: String(result.rows[0].content ?? ""),
    createdAt: String(result.rows[0].created_at ?? ""),
    updatedAt: String(result.rows[0].updated_at ?? ""),
    version: Number(result.rows[0].version ?? 1) || 1
  };
}

export async function recordDebateFileActivity(input: {
  db?: DbLike;
  debateId: string;
  debateAgentId: string;
  turnNumber: number;
  roundNumber: number;
  action: DebateFileActivityAction;
  scope: "debate" | "agent";
  path: string;
  targetDebateAgentId?: string | null;
  writeMode?: DebateFileWriteMode | null;
  beforeVersion?: number | null;
  afterVersion?: number | null;
  beforeContent?: string | null;
  afterContent?: string | null;
  targetHeading?: string | null;
  reason?: string | null;
  now: string;
}) {
  const db = input.db ?? (await ensureDb());
  await db.executeQuery(sql`
    insert into debate_file_activity_logs (
      id,
      debate_id,
      debate_agent_id,
      turn_number,
      round_number,
      action,
      scope,
      path,
      target_debate_agent_id,
      write_mode,
      before_version,
      after_version,
      before_content,
      after_content,
      target_heading,
      reason,
      created_at
    )
    values (
      ${randomUUID()},
      ${input.debateId},
      ${input.debateAgentId},
      ${input.turnNumber},
      ${input.roundNumber},
      ${input.action},
      ${input.scope},
      ${input.path},
      ${input.targetDebateAgentId ?? null},
      ${input.writeMode ?? null},
      ${input.beforeVersion ?? null},
      ${input.afterVersion ?? null},
      ${input.beforeContent ?? null},
      ${input.afterContent ?? null},
      ${input.targetHeading ?? null},
      ${input.reason ?? null},
      ${input.now}
    )
  `.compile(db));
}

export async function recordImplicitFileReads(input: {
  audit: DebateFileActivityAudit | null;
  scope: "debate" | "agent";
  paths: string[];
  targetDebateAgentId?: string | null;
}) {
  if (!input.audit) return;
  const uniquePaths = Array.from(new Set(input.paths.map((path) => normalizeContextPath(path)).filter(Boolean)));
  for (const path of uniquePaths) {
    // eslint-disable-next-line no-await-in-loop
    await recordDebateFileActivity({
      debateId: input.audit.debateId,
      debateAgentId: input.audit.debateAgentId,
      turnNumber: input.audit.turnNumber,
      roundNumber: input.audit.roundNumber,
      action: "read",
      scope: input.scope,
      path,
      targetDebateAgentId: input.targetDebateAgentId ?? null,
      now: input.audit.now
    });
  }
}

export async function insertDebateFileVersionRecord(input: {
  db: DbLike;
  debateId: string;
  path: string;
  version: number;
  content: string;
  mode: DebateFileWriteMode;
  reason: string | null;
  baseVersion: number | null;
  debateAgentId?: string | null;
  now: string;
}) {
  await input.db.executeQuery(sql`
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
    values (
      ${randomUUID()},
      ${input.debateId},
      ${input.path},
      ${input.version},
      ${input.content},
      ${input.mode},
      ${input.reason},
      ${input.baseVersion},
      ${input.debateAgentId ?? null},
      ${input.now}
    )
    on conflict (debate_id, path, version) do nothing
  `.compile(input.db));
}

export async function writeDebateFileWithMode(input: {
  userId: string;
  debateId: string;
  debateAgentId?: string | null;
  turnNumber: number;
  roundNumber: number;
  path: string;
  content: string;
  mode: DebateFileWriteMode;
  baseVersion?: number | null;
  baseUpdatedAt?: string | null;
  reason?: string | null;
  targetHeading?: string | null;
  allowShrink?: boolean;
  now: string;
}) {
  const db = await ensureDb();
  return db.transaction().execute(async (trx) => {
    const current = await getDebateFileMeta(trx, input.debateId, input.path);
    const isDeliverable = isFinalDebateOutputPath(input.path);
    const baseVersion = Number.isFinite(input.baseVersion) ? Math.floor(Number(input.baseVersion)) : null;
    const baseUpdatedAt = typeof input.baseUpdatedAt === "string" && input.baseUpdatedAt.trim() ? input.baseUpdatedAt.trim() : null;
    const expectedCurrentVersion = current?.version ?? 0;
    const expectedCurrentUpdatedAt = current?.updatedAt ?? null;

    if (isDeliverable && baseVersion === null && baseUpdatedAt === null && current) {
      return {
        error: `final/* writes require baseVersion or baseUpdatedAt for ${input.path}. Call debate_files_stat or debate_files_read first.`
      };
    }
    if (baseVersion !== null && baseVersion !== expectedCurrentVersion) {
      return {
        error: `WRITE_CONFLICT: ${input.path} is at version ${expectedCurrentVersion}, not ${baseVersion}. Call debate_files_stat/debate_files_read and retry.`
      };
    }
    if (baseUpdatedAt !== null && baseUpdatedAt !== expectedCurrentUpdatedAt) {
      return {
        error: `WRITE_CONFLICT: ${input.path} was updated at ${expectedCurrentUpdatedAt ?? "(missing)"}, not ${baseUpdatedAt}. Call debate_files_stat/debate_files_read and retry.`
      };
    }

    let nextContent = String(input.content ?? "");
    if (input.mode === "replace") {
      if (isDeliverable && current && shouldRejectDeliverableShrink(current.content, nextContent, Boolean(input.allowShrink))) {
        return {
          error: `replace rejected for ${input.path}: content shrank from ${current.content.length} to ${nextContent.length} chars. Use allowShrink=true only when intentional.`
        };
      }
    } else if (input.mode === "append") {
      nextContent = appendDebateFileContent(current?.content ?? "", nextContent);
      if (isDeliverable) {
        await appendServerLog("warn", "append used for final deliverable", {
          debateId: input.debateId,
          path: input.path,
          debateAgentId: input.debateAgentId ?? null,
          reason: input.reason ?? null
        });
      }
    } else {
      const targetHeading = typeof input.targetHeading === "string" && input.targetHeading.trim() ? input.targetHeading.trim() : "";
      if (!targetHeading) {
        return { error: `section_merge requires targetHeading for ${input.path}.` };
      }
      if (!current) {
        return { error: `TARGET_FILE_NOT_FOUND: ${input.path}. Create the file with mode="replace" first.` };
      }
      const merged = mergeMarkdownSectionByHeading(current.content, targetHeading, nextContent);
      if ("error" in merged) {
        return { error: merged.error };
      }
      nextContent = merged.content;
    }

    const nextVersion = current ? current.version + 1 : 1;
    await trx.executeQuery(sql`
      insert into debate_files (debate_id, path, content, version, created_at, updated_at)
      values (${input.debateId}, ${input.path}, ${nextContent}, ${nextVersion}, ${input.now}, ${input.now})
      on conflict (debate_id, path)
      do update
        set content = excluded.content,
            version = excluded.version,
            updated_at = excluded.updated_at
    `.compile(trx));

    if (isDeliverable) {
      await insertDebateFileVersionRecord({
        db: trx,
        debateId: input.debateId,
        path: input.path,
        version: nextVersion,
        content: nextContent,
        mode: input.mode,
        reason: input.reason ?? null,
        baseVersion: current?.version ?? null,
        debateAgentId: input.debateAgentId ?? null,
        now: input.now
      });
    }
    if (input.debateAgentId) {
      await recordDebateFileActivity({
        db: trx,
        debateId: input.debateId,
        debateAgentId: input.debateAgentId,
        turnNumber: input.turnNumber,
        roundNumber: input.roundNumber,
        action: "write",
        scope: "debate",
        path: input.path,
        writeMode: input.mode,
        beforeVersion: current?.version ?? null,
        afterVersion: nextVersion,
        beforeContent: current?.content ?? "",
        afterContent: nextContent,
        targetHeading: input.targetHeading ?? null,
        reason: input.reason ?? null,
        now: input.now
      });
    }

    return {
      ok: true,
      path: input.path,
      size: nextContent.length,
      content: nextContent,
      version: nextVersion,
      updatedAt: input.now,
      mode: input.mode
    };
  });
}

export async function toolDebateFilesStat(input: {
  debateAgentId?: string | null;
  debateId: string;
  turnNumber?: number;
  roundNumber?: number;
  path: string;
  now?: string;
  allowedOutputPaths?: string[];
}) {
  const safePath = normalizeDebateOutputPath(input.path, input.allowedOutputPaths);
  if (!safePath) {
    return {
      error: `Invalid path. Only ${(input.allowedOutputPaths?.length ?? 0) > 0 ? input.allowedOutputPaths?.join(", ") : "final/, outputs/"} allowed (no '..').`
    };
  }
  try {
    const db = await ensureDb();
    const result = await db
      .selectFrom("debate_files")
      .select([
        "updated_at",
        "version",
        sql<number>`char_length(content)`.as("content_length")
      ])
      .where("debate_id", "=", input.debateId)
      .where("path", "=", safePath)
      .limit(1)
      .executeTakeFirst();
    if (!result) {
      return { ok: true, path: safePath, exists: false, size: 0, updatedAt: null, version: 0 };
    }
    if (input.debateAgentId && typeof input.turnNumber === "number" && typeof input.roundNumber === "number" && input.now) {
      await recordDebateFileActivity({
        debateId: input.debateId,
        debateAgentId: input.debateAgentId,
        turnNumber: input.turnNumber,
        roundNumber: input.roundNumber,
        action: "stat",
        scope: "debate",
        path: safePath,
        now: input.now
      });
    }
    return {
      ok: true,
      path: safePath,
      exists: true,
      size: Number(result.content_length ?? 0) || 0,
      updatedAt: String(result.updated_at ?? ""),
      version: Number(result.version ?? 1) || 1
    };
  } catch (error) {
    if (getPgErrorCode(error) === "42P01") {
      return "MIGRATION_REQUIRED: debate_files table missing";
    }
    throw error;
  }
}

function getWorkflowSourcePathHint(allowedOutputPaths?: string[]) {
  const sourcePaths = getWorkflowSourceOutputPaths(allowedOutputPaths);
  return sourcePaths.length > 0 ? sourcePaths.join(" / ") : "the configured workflow source-of-truth file";
}

function getWorkflowSourceOutputPaths(allowedOutputPaths?: string[]) {
  return (allowedOutputPaths ?? []).filter((item) => !item.endsWith("/") && !item.startsWith("outputs/") && !item.startsWith("final/"));
}

function getFileBaseName(path: string) {
  return path.split("/").pop()?.toLowerCase() ?? "";
}

function stripMarkdownExtension(path: string) {
  return path.toLowerCase().replace(/\.mdx?$/, "");
}

function isWorkflowSourceShadowOutputPath(path: string, allowedOutputPaths?: string[]) {
  if (!path.startsWith("outputs/")) return false;
  const outputBaseName = getFileBaseName(path);
  const outputStem = stripMarkdownExtension(outputBaseName);
  return getWorkflowSourceOutputPaths(allowedOutputPaths).some((sourcePath) => {
    const sourceBaseName = getFileBaseName(sourcePath);
    return outputBaseName === sourceBaseName || outputStem === stripMarkdownExtension(sourceBaseName);
  });
}

export async function toolDebateFilesWrite(input: {
  userId: string;
  debateAgentId?: string | null;
  debateId: string;
  turnNumber: number;
  roundNumber: number;
  path: string;
  content: string;
  mode?: string | null;
  baseVersion?: number | null;
  baseUpdatedAt?: string | null;
  reason?: string | null;
  targetHeading?: string | null;
  allowShrink?: boolean;
  now: string;
  allowedOutputPaths?: string[];
}) {
  const safePath = normalizeDebateOutputPath(input.path, input.allowedOutputPaths);
  if (!safePath) {
    return {
      error: `Invalid path. Only ${(input.allowedOutputPaths?.length ?? 0) > 0 ? input.allowedOutputPaths?.join(", ") : "final/, outputs/"} allowed (no '..').`
    };
  }
  if (isWorkflowSourceShadowOutputPath(safePath, input.allowedOutputPaths)) {
    return {
      error: `Invalid path: ${safePath} looks like a shadow copy of a workflow source-of-truth file. Write the configured source file instead: ${getWorkflowSourcePathHint(input.allowedOutputPaths)}.`
    };
  }
  const content = String(input.content ?? "");
  const mode = normalizeDebateFileWriteMode(safePath, typeof input.mode === "string" ? input.mode : null);
  if (!mode) {
    return { error: describeLegacyFinalWriteError(safePath) };
  }
  const writeResult = await writeDebateFileWithMode({
    userId: input.userId,
    debateId: input.debateId,
    debateAgentId: input.debateAgentId ?? null,
    turnNumber: input.turnNumber,
    roundNumber: input.roundNumber,
    path: safePath,
    content,
    mode,
    baseVersion: input.baseVersion ?? null,
    baseUpdatedAt: input.baseUpdatedAt ?? null,
    reason: input.reason ?? null,
    targetHeading: input.targetHeading ?? null,
    allowShrink: Boolean(input.allowShrink),
    now: input.now
  });
  if ("error" in writeResult) {
    return writeResult;
  }
  try {
    const chunks = splitTextIntoRetrievalChunks(writeResult.content, 1_500, 220);
    for (let index = 0; index < chunks.length; index += 1) {
      // eslint-disable-next-line no-await-in-loop
      await indexDebateContextChunk({
        userId: input.userId,
        debateId: input.debateId,
        chunkKey: `deliverable:${safePath}:chunk:${index + 1}`,
        sourceType: "deliverable_file",
        sourcePath: safePath,
        content: chunks[index],
        now: input.now
      });
    }
  } catch {
    // retrieval indexing is best-effort
  }
  return {
    ok: true,
    path: writeResult.path,
    size: writeResult.size,
    version: writeResult.version,
    updatedAt: writeResult.updatedAt,
    mode: writeResult.mode,
    verification: {
      path: writeResult.path,
      version: writeResult.version,
      size: writeResult.size,
      updatedAt: writeResult.updatedAt
    },
    message: `WRITE_CONFIRMED: ${writeResult.path} v${writeResult.version}, ${writeResult.size} chars`
  };
}
