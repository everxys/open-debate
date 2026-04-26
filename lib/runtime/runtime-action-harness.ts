import { sql } from "kysely";

import { ensureDb } from "@/lib/db";
import { readDebateAgentFile, readDebateFile, upsertDebateAgentFile } from "@/lib/runtime/file-store";
import {
  CONTEXT_WORKING_SET_PATH
} from "@/lib/runtime/constants";
import {
  getDebateFileMeta,
  listMergedSeatFiles,
  toolDebateFilesStat,
  toolDebateFilesWrite
} from "@/lib/runtime/debate-file-access";
import { toolVoteCast } from "@/lib/runtime/tools";
import { normalizeTimestampString } from "@/lib/timestamps";
import type { DebateParticipantRoleType } from "@/lib/debate-role-types";
import type { NormalizedWorkflowRequiredFile, WorkflowPhaseKind } from "@/lib/workflow";
import type { OpenOfficialVote } from "@/lib/runtime/workflow-phase";

type WorkingSetFileRef = {
  path: string;
  source: "seat" | "shared";
  version: number | null;
  updatedAt: string | null;
  excerpt: string | null;
};

export type RuntimeActionName =
  | "list"
  | "search"
  | "read"
  | "write_replace"
  | "write_append"
  | "write_section"
  | "vote_cast";

export type RuntimeHarnessAction =
  | { action: "list"; prefix?: string | null }
  | { action: "search"; query: string }
  | { action: "read"; path: string }
  | { action: "write_replace"; path: string; content: string }
  | { action: "write_append"; path: string; content: string }
  | { action: "write_section"; path: string; heading: string; content: string }
  | { action: "vote_cast"; choice: string; reason?: string | null };

export type RuntimeActionPolicy = {
  allowedActions: RuntimeActionName[];
  preferredWriteAction: RuntimeActionName | null;
  reason: string;
  knownTargetPaths: string[];
  knownWritableTargetPaths: string[];
  preferredWritableTargetPaths: string[];
};

export type RuntimeSeatWorkingSet = {
  canonicalSourceFiles: WorkingSetFileRef[];
  recentlyReadFiles: WorkingSetFileRef[];
  recentlyWrittenFiles: WorkingSetFileRef[];
  updatedAt: string | null;
};

type WorkingSetContext = {
  userId: string;
  debateId: string;
  debateAgentId: string;
  agentId: string;
  allowedOutputPaths: string[];
};

type SharedReadContext = WorkingSetContext & {
  readableSharedPaths: string[];
};

type ExecuteHarnessActionInput = SharedReadContext & {
  action: RuntimeHarnessAction;
  readTargetPaths: string[];
  writeTargetPaths: string[];
  participantCount: number;
  voterName: string;
  turnNumber: number;
  roundNumber: number;
  now: string;
  currentWorkingSet: RuntimeSeatWorkingSet;
  mutationSequenceNumber: number;
};

type SharedFileRow = {
  path: string;
  content: string;
  version: number;
  updatedAt: string | null;
};

type LoopRecord = {
  family: RuntimeActionName;
  signature: string;
  path: string | null;
  query: string | null;
  contentSample: string | null;
};

export type RuntimeActionLoopState = {
  records: LoopRecord[];
};

type DebateFileSnapshot = {
  exists: boolean;
  content: string | null;
  version: number | null;
  updatedAt: string | null;
  createdAt: string | null;
};

type RuntimeTurnMutationKind = Extract<RuntimeActionName, "write_replace" | "write_append" | "write_section" | "vote_cast">;

type RuntimeTurnMutationJournalRow = {
  id: string;
  debate_id: string;
  debate_agent_id: string;
  turn_number: number;
  round_number: number;
  mutation_kind: string;
  target_path: string;
  sequence_number: number;
  status: string;
  before_exists: boolean;
  before_content: string | null;
  before_version: number | null;
  before_updated_at: string | null;
  before_created_at: string | null;
  after_exists: boolean;
  after_content: string | null;
  after_version: number | null;
  after_updated_at: string | null;
  action_payload_json: unknown | null;
  result_json: unknown | null;
  created_at: string;
};

function safeJsonParse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function clipExcerpt(content: string | null | undefined, maxChars = 240) {
  const normalized = String(content ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars - 1)}…` : normalized;
}

function normalizePath(path: string) {
  return String(path ?? "").replace(/\\/g, "/").replace(/^\/+/, "").trim();
}

function isPathInSharedSurface(path: string, sharedPaths: string[]) {
  const normalized = normalizePath(path);
  return sharedPaths.some((candidate) => {
    const expected = normalizePath(candidate);
    return expected.endsWith("/") ? normalized.startsWith(expected) : normalized === expected;
  });
}

function makeFileRef(input: {
  path: string;
  source: "seat" | "shared";
  content?: string | null;
  version?: number | null;
  updatedAt?: string | null;
}): WorkingSetFileRef {
  return {
    path: normalizePath(input.path),
    source: input.source,
    version: typeof input.version === "number" && Number.isFinite(input.version) ? Math.floor(input.version) : null,
    updatedAt: input.updatedAt ?? null,
    excerpt: clipExcerpt(input.content ?? null)
  };
}

function dedupeRefs(items: WorkingSetFileRef[], limit = 8) {
  const seen = new Set<string>();
  const result: WorkingSetFileRef[] = [];
  for (const item of items) {
    const key = `${item.source}:${item.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
    if (result.length >= limit) break;
  }
  return result;
}

function collectWorkingSetReadTargets(input: {
  workingSet: RuntimeSeatWorkingSet;
  readableSharedPaths: string[];
}) {
  return dedupeRefs(
    [
      ...input.workingSet.recentlyWrittenFiles,
      ...input.workingSet.canonicalSourceFiles,
      ...input.workingSet.recentlyReadFiles
    ].filter((item) => item.source === "seat" || isPathInSharedSurface(item.path, input.readableSharedPaths)),
    12
  ).map((item) => item.path);
}

function dedupePaths(paths: string[]) {
  return Array.from(new Set(paths.map((item) => normalizePath(item)).filter(Boolean)));
}

function collectWorkingSetWritableTargets(input: {
  workingSet: RuntimeSeatWorkingSet;
  allowedOutputPaths: string[];
}) {
  return dedupeRefs(
    [
      ...input.workingSet.recentlyWrittenFiles,
      ...input.workingSet.canonicalSourceFiles,
      ...input.workingSet.recentlyReadFiles
    ].filter((item) => item.source === "shared" && isPathInSharedSurface(item.path, input.allowedOutputPaths)),
    12
  ).map((item) => item.path);
}

function collectBootstrapWritableTargets(input: {
  pendingDeliverables: NormalizedWorkflowRequiredFile[];
  allowedOutputPaths: string[];
  phasePreferredWritablePaths: string[];
}) {
  return dedupePaths([
    ...input.phasePreferredWritablePaths,
    ...input.allowedOutputPaths.filter((item) => !normalizePath(item).endsWith("/")),
    ...input.pendingDeliverables.map((item) => item.path)
  ]);
}

function collectPreferredWritableTargets(input: {
  currentPhaseKind: WorkflowPhaseKind | null;
  phasePreferredWritablePaths: string[];
  workingSetWritableTargets: string[];
  bootstrapWritableTargetPaths: string[];
  pendingDeliverables: NormalizedWorkflowRequiredFile[];
}) {
  const knownWritableTargets = [...input.workingSetWritableTargets, ...input.bootstrapWritableTargetPaths];
  const preferredPhaseTargets = input.phasePreferredWritablePaths.filter((path) =>
    knownWritableTargets.some((candidate) => normalizePath(candidate) === normalizePath(path))
  );
  if (preferredPhaseTargets.length > 0) return dedupePaths(preferredPhaseTargets);

  const pendingDeliverablePathSet = new Set(input.pendingDeliverables.map((item) => normalizePath(item.path)));
  const pendingTargets = knownWritableTargets.filter((path) => pendingDeliverablePathSet.has(normalizePath(path)));
  if (pendingTargets.length > 0) return dedupePaths(pendingTargets);

  if (input.currentPhaseKind === "deliberation") {
    const markdownTargets = knownWritableTargets.filter((path) => normalizePath(path).endsWith(".md"));
    if (markdownTargets.length > 0) return dedupePaths(markdownTargets.slice(0, 6));
  }

  return dedupePaths(knownWritableTargets);
}

async function loadDebateFileSnapshot(debateId: string, path: string): Promise<DebateFileSnapshot> {
  const db = await ensureDb();
  const current = await getDebateFileMeta(db, debateId, path);
  if (!current) {
    return {
      exists: false,
      content: null,
      version: null,
      updatedAt: null,
      createdAt: null
    };
  }
  return {
    exists: true,
    content: current.content,
    version: current.version,
    updatedAt: current.updatedAt,
    createdAt: current.createdAt
  };
}

async function listSharedFiles(input: SharedReadContext): Promise<SharedFileRow[]> {
  const db = await ensureDb();
  const result = await db
    .selectFrom("debate_files as f")
    .innerJoin("debates as d", "d.id", "f.debate_id")
    .select(["f.path", "f.content", "f.version", "f.updated_at"])
    .where("f.debate_id", "=", input.debateId)
    .where("d.user_id", "=", input.userId)
    .orderBy("f.path", "asc")
    .execute();
  return result
    .map((row) => ({
      path: normalizePath(String(row.path ?? "")),
      content: String(row.content ?? ""),
      version: Number(row.version ?? 0) || 0,
      updatedAt: row.updated_at === null || row.updated_at === undefined ? null : normalizeTimestampString(row.updated_at)
    }))
    .filter((row) => isPathInSharedSurface(row.path, input.readableSharedPaths));
}

function buildDefaultCanonicalPaths(allowedOutputPaths: string[]) {
  return allowedOutputPaths
    .map((item) => normalizePath(item))
    .filter((item) => item && !item.endsWith("/"))
    .map((path) => makeFileRef({ path, source: "shared" }));
}

export async function loadRuntimeSeatWorkingSet(input: WorkingSetContext): Promise<RuntimeSeatWorkingSet> {
  const saved = safeJsonParse<RuntimeSeatWorkingSet>(
    await readDebateAgentFile(input.userId, input.debateAgentId, CONTEXT_WORKING_SET_PATH)
  );
  const canonicalSourceFiles = dedupeRefs([
    ...(saved?.canonicalSourceFiles ?? []),
    ...buildDefaultCanonicalPaths(input.allowedOutputPaths)
  ]);
  return {
    canonicalSourceFiles,
    recentlyReadFiles: dedupeRefs(saved?.recentlyReadFiles ?? []),
    recentlyWrittenFiles: dedupeRefs(saved?.recentlyWrittenFiles ?? []),
    updatedAt: saved?.updatedAt ?? null
  };
}

export function mergeRuntimeSharedFilesIntoWorkingSet(
  workingSet: RuntimeSeatWorkingSet,
  refs: Array<{
    path: string;
    content?: string | null;
    version?: number | null;
    updatedAt?: string | null;
  }>
): RuntimeSeatWorkingSet {
  const next: RuntimeSeatWorkingSet = {
    canonicalSourceFiles: [...workingSet.canonicalSourceFiles],
    recentlyReadFiles: [...workingSet.recentlyReadFiles],
    recentlyWrittenFiles: [...workingSet.recentlyWrittenFiles],
    updatedAt: workingSet.updatedAt
  };
  for (const ref of refs) {
    appendWorkingSetRead(
      next,
      makeFileRef({
        path: ref.path,
        source: "shared",
        content: ref.content ?? null,
        version: ref.version ?? null,
        updatedAt: ref.updatedAt ?? null
      })
    );
  }
  return next;
}

export async function persistRuntimeSeatWorkingSet(input: WorkingSetContext & { workingSet: RuntimeSeatWorkingSet; now: string }) {
  const payload: RuntimeSeatWorkingSet = {
    canonicalSourceFiles: dedupeRefs(input.workingSet.canonicalSourceFiles),
    recentlyReadFiles: dedupeRefs(input.workingSet.recentlyReadFiles),
    recentlyWrittenFiles: dedupeRefs(input.workingSet.recentlyWrittenFiles),
    updatedAt: input.now
  };
  await upsertDebateAgentFile(input.debateAgentId, CONTEXT_WORKING_SET_PATH, JSON.stringify(payload, null, 2), input.now);
}

async function insertPendingRuntimeTurnMutation(input: {
  debateId: string;
  debateAgentId: string;
  turnNumber: number;
  roundNumber: number;
  mutationKind: RuntimeTurnMutationKind;
  targetPath: string;
  sequenceNumber: number;
  before: DebateFileSnapshot;
  after: DebateFileSnapshot;
  actionPayload: RuntimeHarnessAction;
  result: unknown;
  now: string;
}) {
  const db = await ensureDb();
  const row = await db
    .insertInto("debate_turn_mutations")
    .values({
      id: sql<string>`gen_random_uuid()`,
      debate_id: input.debateId,
      debate_agent_id: input.debateAgentId,
      turn_number: input.turnNumber,
      round_number: input.roundNumber,
      mutation_kind: input.mutationKind,
      target_path: input.targetPath,
      sequence_number: input.sequenceNumber,
      status: "pending",
      before_exists: input.before.exists,
      before_content: input.before.content,
      before_version: input.before.version,
      before_updated_at: input.before.updatedAt,
      before_created_at: input.before.createdAt,
      after_exists: input.after.exists,
      after_content: input.after.content,
      after_version: input.after.version,
      after_updated_at: input.after.updatedAt,
      action_payload_json: JSON.stringify(input.actionPayload),
      result_json: JSON.stringify(input.result),
      created_at: input.now,
      committed_at: null,
      rolled_back_at: null
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return String(row.id);
}

function normalizeMutationTargetPath(action: RuntimeHarnessAction) {
  if (action.action === "vote_cast") return "votes/open.json";
  if (action.action === "read" || action.action === "write_replace" || action.action === "write_append" || action.action === "write_section") {
    return normalizePath(action.path);
  }
  return "";
}

async function applyDebateFileSnapshot(input: {
  debateId: string;
  targetPath: string;
  snapshot: DebateFileSnapshot;
}) {
  const db = await ensureDb();
  await db.transaction().execute(async (trx) => {
    if (!input.snapshot.exists) {
      await trx
        .deleteFrom("debate_files")
        .where("debate_id", "=", input.debateId)
        .where("path", "=", input.targetPath)
        .execute();
      return;
    }
    await trx.executeQuery(sql`
      insert into debate_files (debate_id, path, content, version, created_at, updated_at)
      values (
        ${input.debateId},
        ${input.targetPath},
        ${input.snapshot.content ?? ""},
        ${input.snapshot.version ?? 1},
        ${input.snapshot.createdAt ?? input.snapshot.updatedAt ?? new Date().toISOString()},
        ${input.snapshot.updatedAt ?? new Date().toISOString()}
      )
      on conflict (debate_id, path)
      do update
        set content = excluded.content,
            version = excluded.version,
            created_at = excluded.created_at,
            updated_at = excluded.updated_at
    `.compile(trx));
  });
}

async function rollbackPendingRuntimeTurnMutationRow(row: RuntimeTurnMutationJournalRow) {
  await applyDebateFileSnapshot({
    debateId: row.debate_id,
    targetPath: row.target_path,
    snapshot: {
      exists: row.before_exists,
      content: row.before_content,
      version: row.before_version,
      updatedAt: row.before_updated_at,
      createdAt: row.before_created_at
    }
  });
  if ((row.mutation_kind === "write_replace" || row.mutation_kind === "write_append" || row.mutation_kind === "write_section") && row.after_version) {
    const db = await ensureDb();
    await db.transaction().execute(async (trx) => {
      await trx
        .deleteFrom("debate_file_versions")
        .where("debate_id", "=", row.debate_id)
        .where("path", "=", row.target_path)
        .where("version", "=", row.after_version)
        .where("created_by_debate_agent_id", "=", row.debate_agent_id)
        .where("created_at", "=", row.created_at)
        .execute();
      await trx
        .deleteFrom("debate_file_activity_logs")
        .where("debate_id", "=", row.debate_id)
        .where("debate_agent_id", "=", row.debate_agent_id)
        .where("turn_number", "=", row.turn_number)
        .where("round_number", "=", row.round_number)
        .where("action", "=", "write")
        .where("scope", "=", "debate")
        .where("path", "=", row.target_path)
        .where("after_version", "=", row.after_version)
        .where("created_at", "=", row.created_at)
        .execute();
    });
  }
}

export async function markRuntimeTurnMutationsCommitted(mutationIds: string[], now: string) {
  if (mutationIds.length <= 0) return;
  const db = await ensureDb();
  await db
    .updateTable("debate_turn_mutations")
    .set({
      status: "committed",
      committed_at: now
    })
    .where("id", "in", mutationIds)
    .where("status", "=", "pending")
    .execute();
}

export async function rollbackRuntimeTurnMutationsByIds(mutationIds: string[], now: string) {
  if (mutationIds.length <= 0) return;
  const db = await ensureDb();
  const rows = await db
    .selectFrom("debate_turn_mutations")
    .selectAll()
    .where("id", "in", mutationIds)
    .where("status", "=", "pending")
    .orderBy("sequence_number", "desc")
    .execute();
  for (const row of rows) {
    // eslint-disable-next-line no-await-in-loop
    await rollbackPendingRuntimeTurnMutationRow(row as RuntimeTurnMutationJournalRow);
  }
  await db
    .updateTable("debate_turn_mutations")
    .set({
      status: "rolled_back",
      rolled_back_at: now
    })
    .where("id", "in", rows.map((row) => String(row.id)))
    .where("status", "=", "pending")
    .execute();
}

export async function reconcileRuntimeTurnMutationState(input: {
  debateId: string;
  currentTurnNumber: number;
  now: string;
}) {
  const db = await ensureDb();
  const pendingRows = await db
    .selectFrom("debate_turn_mutations")
    .selectAll()
    .where("debate_id", "=", input.debateId)
    .where("status", "=", "pending")
    .orderBy("turn_number", "asc")
    .orderBy("sequence_number", "desc")
    .execute();
  if (pendingRows.length <= 0) return;
  const turnNumbers = Array.from(new Set(pendingRows.map((row) => Number(row.turn_number ?? 0)).filter((value) => value > 0)));
  const persistedTurns = await db
    .selectFrom("debate_turns")
    .select(["turn_number"])
    .where("debate_id", "=", input.debateId)
    .where("turn_number", "in", turnNumbers)
    .execute();
  const persistedTurnSet = new Set(persistedTurns.map((row) => Number(row.turn_number ?? 0)));
  const rollbackRows = pendingRows.filter((row) => {
    const turnNumber = Number(row.turn_number ?? 0);
    return !persistedTurnSet.has(turnNumber) && turnNumber <= input.currentTurnNumber;
  });
  for (const row of rollbackRows) {
    // eslint-disable-next-line no-await-in-loop
    await rollbackPendingRuntimeTurnMutationRow(row as RuntimeTurnMutationJournalRow);
  }
  if (rollbackRows.length > 0) {
    await db
      .updateTable("debate_turn_mutations")
      .set({
        status: "rolled_back",
        rolled_back_at: input.now
      })
      .where("id", "in", rollbackRows.map((row) => String(row.id)))
      .where("status", "=", "pending")
      .execute();
  }
  const commitRows = pendingRows.filter((row) => persistedTurnSet.has(Number(row.turn_number ?? 0)));
  if (commitRows.length > 0) {
    await db
      .updateTable("debate_turn_mutations")
      .set({
        status: "committed",
        committed_at: input.now
      })
      .where("id", "in", commitRows.map((row) => String(row.id)))
      .where("status", "=", "pending")
      .execute();
  }
}

export function buildRuntimeActionWorkingSetInline(workingSet: RuntimeSeatWorkingSet) {
  const lines: string[] = [];
  if (workingSet.canonicalSourceFiles.length > 0) {
    lines.push("Seat working set: canonical source files");
    for (const item of workingSet.canonicalSourceFiles.slice(0, 8)) {
      lines.push(`- ${item.path}${item.version ? ` (v${item.version})` : ""}${item.excerpt ? ` :: ${item.excerpt}` : ""}`);
    }
  }
  if (workingSet.recentlyReadFiles.length > 0) {
    lines.push("Recently read");
    for (const item of workingSet.recentlyReadFiles.slice(0, 6)) {
      lines.push(`- ${item.path}${item.excerpt ? ` :: ${item.excerpt}` : ""}`);
    }
  }
  if (workingSet.recentlyWrittenFiles.length > 0) {
    lines.push("Recently written");
    for (const item of workingSet.recentlyWrittenFiles.slice(0, 6)) {
      lines.push(`- ${item.path}${item.version ? ` (v${item.version})` : ""}${item.excerpt ? ` :: ${item.excerpt}` : ""}`);
    }
  }
  return lines.length > 0 ? lines.join("\n") : null;
}

export function resolveRuntimeActionPolicy(input: {
  roleType: DebateParticipantRoleType;
  currentPhaseKind: WorkflowPhaseKind | null;
  pendingDeliverables: NormalizedWorkflowRequiredFile[];
  phasePreferredWritablePaths: string[];
  openVote: OpenOfficialVote | null;
  debateAgentId: string;
  workingSet: RuntimeSeatWorkingSet;
  readableSharedPaths: string[];
  allowedOutputPaths: string[];
}) : RuntimeActionPolicy {
  const workingSetReadTargets = collectWorkingSetReadTargets({
    workingSet: input.workingSet,
    readableSharedPaths: input.readableSharedPaths
  });
  const workingSetWritableTargets = collectWorkingSetWritableTargets({
    workingSet: input.workingSet,
    allowedOutputPaths: input.allowedOutputPaths
  });
  const bootstrapWritableTargetPaths = collectBootstrapWritableTargets({
    pendingDeliverables: input.pendingDeliverables,
    allowedOutputPaths: input.allowedOutputPaths,
    phasePreferredWritablePaths: input.phasePreferredWritablePaths
  });
  const knownTargetPaths = dedupePaths([...workingSetReadTargets, ...bootstrapWritableTargetPaths]);
  const knownWritableTargetPaths = dedupePaths([...workingSetWritableTargets, ...bootstrapWritableTargetPaths]);
  const preferredWritableTargetPaths = collectPreferredWritableTargets({
    currentPhaseKind: input.currentPhaseKind,
    phasePreferredWritablePaths: input.phasePreferredWritablePaths,
    workingSetWritableTargets,
    bootstrapWritableTargetPaths,
    pendingDeliverables: input.pendingDeliverables
  });
  const alreadyVoted = Boolean(
    input.openVote?.ballots?.some((ballot: { debateAgentId?: string | null }) => String(ballot.debateAgentId ?? "") === input.debateAgentId)
  );
  if (input.openVote && !alreadyVoted) {
    return {
        allowedActions: ["vote_cast"],
        preferredWriteAction: null,
        reason: "There is an open official vote and this seat has not voted yet.",
        knownTargetPaths,
        knownWritableTargetPaths,
        preferredWritableTargetPaths: []
      };
  }
  if (knownTargetPaths.length === 0) {
    return {
        allowedActions: ["list", "search"],
        preferredWriteAction: null,
        reason: "No working-set target is known yet. Discover the target path first.",
        knownTargetPaths,
        knownWritableTargetPaths,
        preferredWritableTargetPaths
      };
  }
  if (knownWritableTargetPaths.length === 0) {
    return {
        allowedActions: ["read"],
        preferredWriteAction: null,
        reason: "A readable target is known, but no writable shared target is available for this step.",
        knownTargetPaths,
        knownWritableTargetPaths,
        preferredWritableTargetPaths
      };
  }
  const pendingDeliverablePathSet = new Set(input.pendingDeliverables.map((item) => normalizePath(item.path)));
  const hasPendingWorkingSetDeliverableTarget = workingSetWritableTargets.some((path) =>
    pendingDeliverablePathSet.has(normalizePath(path))
  );
  const hasBootstrapPendingDeliverableTarget =
    workingSetWritableTargets.length === 0 &&
    bootstrapWritableTargetPaths.some((path) => pendingDeliverablePathSet.has(normalizePath(path)));
  const hasPreferredPhaseTarget = preferredWritableTargetPaths.some((path) =>
    input.phasePreferredWritablePaths.some((candidate) => normalizePath(candidate) === normalizePath(path))
  );
  const preferredWriteAction: RuntimeActionName | null =
    hasPreferredPhaseTarget
      ? preferredWritableTargetPaths.some((path) => path.endsWith(".md"))
        ? "write_section"
        : "write_replace"
      : hasPendingWorkingSetDeliverableTarget || hasBootstrapPendingDeliverableTarget
      ? "write_replace"
      : knownWritableTargetPaths.some((path) => path.endsWith(".md"))
        ? "write_section"
        : input.roleType === "Host"
          ? null
          : "write_replace";
  return {
    allowedActions: preferredWriteAction ? ["read", preferredWriteAction] : ["read"],
    preferredWriteAction,
    reason: preferredWriteAction
      ? hasPreferredPhaseTarget
        ? `Use the phase-preferred ledger target directly; only ${preferredWriteAction} is exposed for writes this step.`
        : `Use the known target directly; only ${preferredWriteAction} is exposed for writes this step.`
      : "Read the known target directly; this step does not expose a write action.",
    knownTargetPaths,
    knownWritableTargetPaths,
    preferredWritableTargetPaths
  };
}

export function buildRuntimeActionInstructions(input: {
  policy: RuntimeActionPolicy;
  allowedOutputPaths: string[];
}) {
  const lines: string[] = [];
  const shapeByAction: Record<RuntimeActionName, string> = {
    list: '{ "action": "list", "prefix": "optional/prefix/" }',
    search: '{ "action": "search", "query": "needle" }',
    read: '{ "action": "read", "path": "file.md" }',
    write_replace: '{ "action": "write_replace", "path": "file.md", "content": "..." }',
    write_append: '{ "action": "write_append", "path": "file.md", "content": "..." }',
    write_section: '{ "action": "write_section", "path": "file.md", "heading": "## Section", "content": "## Section\\n..." }',
    vote_cast: '{ "action": "vote_cast", "choice": "Option", "reason": "optional" }'
  };
  const allowedShapeLines = input.policy.allowedActions.map((action) => shapeByAction[action]);
  lines.push("Runtime actions are harness-owned. Do not rely on provider-native tool calling.");
  lines.push("Only the latest HARNESS_ACTION_RESULT is authoritative for file state.");
  lines.push("Do not claim a file was created, updated, appended, or section-merged unless the latest result confirmed ok:true for that exact path.");
  lines.push("If a harness write returns an error, treat the target file as unchanged.");
  lines.push(`Allowed actions this step: ${input.policy.allowedActions.join(", ") || "none"}.`);
  lines.push(`Action policy reason: ${input.policy.reason}`);
  if (input.policy.knownTargetPaths.length > 0) {
    lines.push(`Known targets: ${input.policy.knownTargetPaths.slice(0, 8).join(", ")}`);
  }
  if (input.policy.knownWritableTargetPaths.length > 0) {
    lines.push(`Writable targets: ${input.policy.knownWritableTargetPaths.slice(0, 8).join(", ")}`);
  }
  if (input.policy.preferredWritableTargetPaths.length > 0) {
    lines.push(`Preferred write targets this step: ${input.policy.preferredWritableTargetPaths.slice(0, 8).join(", ")}`);
  }
  if (allowedShapeLines.length > 0) {
    lines.push("If you need an action, output exactly one fenced JSON block matching one of the allowed shapes below and nothing else:");
    lines.push("```debate-action");
    lines.push(allowedShapeLines[0]);
    lines.push("```");
    lines.push("Allowed JSON shapes:");
    for (const shape of allowedShapeLines) {
      lines.push(`- ${shape}`);
    }
  } else {
    lines.push("Do not emit a debate-action block in this step.");
  }
  lines.push(`Writable shared paths are constrained to: ${input.allowedOutputPaths.join(", ")}`);
  lines.push("The fenced JSON action block is the only exception to the no-raw-JSON output rule.");
  lines.push("When no action is needed, return the normal Markdown answer without JSON.");
  return lines.join("\n");
}

export function parseRuntimeHarnessAction(text: string, allowedActions: RuntimeActionName[]) {
  const candidates: string[] = [];
  const blockPattern = /```(?:debate-action|action)\s*([\s\S]*?)```/gi;
  let blockMatch: RegExpExecArray | null = null;
  while ((blockMatch = blockPattern.exec(text))) {
    candidates.push(blockMatch[1].trim());
  }
  const xmlPattern = /<debate_action>([\s\S]*?)<\/debate_action>/gi;
  let xmlMatch: RegExpExecArray | null = null;
  while ((xmlMatch = xmlPattern.exec(text))) {
    candidates.push(xmlMatch[1].trim());
  }
  for (const candidate of candidates) {
    const parsed = safeJsonParse<Record<string, unknown>>(candidate);
    if (!parsed) continue;
    const actionName = typeof parsed.action === "string" ? parsed.action.trim() : "";
    if (!allowedActions.includes(actionName as RuntimeActionName)) {
      return { error: `ACTION_NOT_ALLOWED: ${actionName || "(missing action)"}` };
    }
    if (actionName === "list") return { action: { action: "list", prefix: typeof parsed.prefix === "string" ? parsed.prefix : null } satisfies RuntimeHarnessAction };
    if (actionName === "search" && typeof parsed.query === "string" && parsed.query.trim()) {
      return { action: { action: "search", query: parsed.query.trim() } satisfies RuntimeHarnessAction };
    }
    if (actionName === "read" && typeof parsed.path === "string" && parsed.path.trim()) {
      return { action: { action: "read", path: normalizePath(parsed.path) } satisfies RuntimeHarnessAction };
    }
    if (actionName === "write_replace" && typeof parsed.path === "string" && typeof parsed.content === "string") {
      return { action: { action: "write_replace", path: normalizePath(parsed.path), content: parsed.content } satisfies RuntimeHarnessAction };
    }
    if (actionName === "write_append" && typeof parsed.path === "string" && typeof parsed.content === "string") {
      return { action: { action: "write_append", path: normalizePath(parsed.path), content: parsed.content } satisfies RuntimeHarnessAction };
    }
    if (
      actionName === "write_section" &&
      typeof parsed.path === "string" &&
      typeof parsed.heading === "string" &&
      typeof parsed.content === "string"
    ) {
      return {
        action: {
          action: "write_section",
          path: normalizePath(parsed.path),
          heading: parsed.heading.trim(),
          content: parsed.content
        } satisfies RuntimeHarnessAction
      };
    }
    if (actionName === "vote_cast" && typeof parsed.choice === "string" && parsed.choice.trim()) {
      return {
        action: {
          action: "vote_cast",
          choice: parsed.choice.trim(),
          reason: typeof parsed.reason === "string" ? parsed.reason.trim() : null
        } satisfies RuntimeHarnessAction
      };
    }
    return { error: `ACTION_INVALID_PAYLOAD: ${actionName}` };
  }
  return { action: null };
}

function appendWorkingSetRead(workingSet: RuntimeSeatWorkingSet, ref: WorkingSetFileRef) {
  workingSet.recentlyReadFiles = dedupeRefs([ref, ...workingSet.recentlyReadFiles]);
  if (ref.source === "shared" && !workingSet.canonicalSourceFiles.some((item) => item.path === ref.path)) {
    workingSet.canonicalSourceFiles = dedupeRefs([ref, ...workingSet.canonicalSourceFiles]);
  }
}

function appendWorkingSetWrite(workingSet: RuntimeSeatWorkingSet, ref: WorkingSetFileRef) {
  workingSet.recentlyWrittenFiles = dedupeRefs([ref, ...workingSet.recentlyWrittenFiles]);
  workingSet.canonicalSourceFiles = dedupeRefs([ref, ...workingSet.canonicalSourceFiles]);
}

function buildSearchSnippet(content: string, query: string) {
  const haystack = content.toLowerCase();
  const needle = query.toLowerCase();
  const index = haystack.indexOf(needle);
  const start = Math.max(0, index - 120);
  const end = Math.min(content.length, index + query.length + 120);
  return content.slice(start, end);
}

async function searchVisibleFiles(input: SharedReadContext, query: string) {
  const seatFiles = await listMergedSeatFiles(input.userId, input.debateAgentId, input.agentId);
  const sharedFiles = await listSharedFiles(input);
  const allFiles = [
    ...seatFiles.map((item) => ({ path: normalizePath(item.path), content: item.content, source: "seat" as const })),
    ...sharedFiles.map((item) => ({ path: item.path, content: item.content, source: "shared" as const, version: item.version, updatedAt: item.updatedAt }))
  ];
  return allFiles
    .filter((item) => item.content.toLowerCase().includes(query.toLowerCase()))
    .slice(0, 8)
    .map((item) => ({
      path: item.path,
      source: item.source,
      snippet: buildSearchSnippet(item.content, query),
      version: "version" in item ? item.version ?? null : null,
      updatedAt: "updatedAt" in item ? item.updatedAt ?? null : null
    }));
}

async function listVisiblePaths(input: SharedReadContext, prefix?: string | null) {
  const normalizedPrefix = normalizePath(prefix ?? "");
  const seatFiles = await listMergedSeatFiles(input.userId, input.debateAgentId, input.agentId, normalizedPrefix);
  const sharedFiles = await listSharedFiles(input);
  return [
    ...seatFiles.map((item) => ({ path: normalizePath(item.path), source: "seat" as const })),
    ...sharedFiles
      .filter((item) => !normalizedPrefix || item.path.startsWith(normalizedPrefix))
      .map((item) => ({ path: item.path, source: "shared" as const, version: item.version, updatedAt: item.updatedAt }))
  ].slice(0, 40);
}

export async function executeRuntimeHarnessAction(input: ExecuteHarnessActionInput) {
  const action = input.action;
  const workingSet = {
    canonicalSourceFiles: [...input.currentWorkingSet.canonicalSourceFiles],
    recentlyReadFiles: [...input.currentWorkingSet.recentlyReadFiles],
    recentlyWrittenFiles: [...input.currentWorkingSet.recentlyWrittenFiles],
    updatedAt: input.currentWorkingSet.updatedAt
  };
  let result: unknown;
  let mutationJournalId: string | null = null;
  const mutationKind =
    action.action === "write_replace" ||
    action.action === "write_append" ||
    action.action === "write_section" ||
    action.action === "vote_cast"
      ? action.action
      : null;
  const mutationTargetPath = mutationKind ? normalizeMutationTargetPath(action) : null;
  const beforeMutation = mutationTargetPath ? await loadDebateFileSnapshot(input.debateId, mutationTargetPath) : null;

  if (action.action === "list") {
    const listed = await listVisiblePaths(input, action.prefix ?? null);
    for (const item of listed.slice(0, 8)) {
      appendWorkingSetRead(
        workingSet,
        makeFileRef({
          path: item.path,
          source: item.source,
          version: "version" in item ? item.version ?? null : null,
          updatedAt: "updatedAt" in item ? item.updatedAt ?? null : null
        })
      );
    }
    result = listed;
  } else if (action.action === "search") {
    const hits = await searchVisibleFiles(input, action.query);
    for (const hit of hits) {
      appendWorkingSetRead(
        workingSet,
        makeFileRef({
          path: hit.path,
          source: hit.source,
          content: hit.snippet,
          version: hit.version ?? null,
          updatedAt: hit.updatedAt ?? null
        })
      );
    }
    result = hits;
  } else if (action.action === "read") {
    const readTargetSet = new Set(input.readTargetPaths.map((item) => normalizePath(item)));
    if (readTargetSet.size > 0 && !readTargetSet.has(action.path)) {
      result = { error: `READ_TARGET_NOT_ALLOWED: ${action.path}` };
    } else {
      const sharedContent = isPathInSharedSurface(action.path, input.readableSharedPaths)
        ? await readDebateFile(input.userId, input.debateId, action.path)
        : null;
      if (sharedContent !== null) {
        const sharedSnapshot = await loadDebateFileSnapshot(input.debateId, action.path);
        appendWorkingSetRead(
          workingSet,
          makeFileRef({
            path: action.path,
            source: "shared",
            content: sharedContent,
            version: sharedSnapshot.version,
            updatedAt: sharedSnapshot.updatedAt
          })
        );
        result = { ok: true, path: action.path, source: "shared", content: sharedContent };
      } else {
        const seatFiles = await listMergedSeatFiles(input.userId, input.debateAgentId, input.agentId);
        const matched = seatFiles.find((item) => normalizePath(item.path) === action.path);
        if (!matched) {
          result = { error: `NOT_FOUND: ${action.path}` };
        } else {
          appendWorkingSetRead(workingSet, makeFileRef({ path: matched.path, source: "seat", content: matched.content }));
          result = { ok: true, path: matched.path, source: "seat", content: matched.content };
        }
      }
    }
  } else if (action.action === "vote_cast") {
    result = await toolVoteCast({
      userId: input.userId,
      debateId: input.debateId,
      participantCount: input.participantCount,
      debateAgentId: input.debateAgentId,
      voterName: input.voterName,
      choice: action.choice,
      reason: action.reason ?? undefined
    });
  } else {
    const writeTargetSet = new Set(input.writeTargetPaths.map((item) => normalizePath(item)));
    if (writeTargetSet.size > 0 && !writeTargetSet.has(action.path)) {
      result = { error: `WRITE_TARGET_NOT_ALLOWED: ${action.path}` };
    } else {
      const stat = await toolDebateFilesStat({
        debateAgentId: input.debateAgentId,
        debateId: input.debateId,
        turnNumber: input.turnNumber,
        roundNumber: input.roundNumber,
        path: action.path,
        now: input.now,
        allowedOutputPaths: input.allowedOutputPaths
      });
      const baseVersion = typeof stat === "object" && stat && "version" in stat ? Number(stat.version ?? 0) : null;
      const baseUpdatedAt =
        typeof stat === "object" && stat && "updatedAt" in stat && typeof stat.updatedAt === "string"
          ? stat.updatedAt
          : null;
      const mode =
        action.action === "write_replace" ? "replace" : action.action === "write_append" ? "append" : "section_merge";
      result = await toolDebateFilesWrite({
        userId: input.userId,
        debateAgentId: input.debateAgentId,
        debateId: input.debateId,
        turnNumber: input.turnNumber,
        roundNumber: input.roundNumber,
        path: action.path,
        content: action.content,
        mode,
        baseVersion,
        baseUpdatedAt,
        targetHeading: action.action === "write_section" ? action.heading : null,
        now: input.now,
        allowedOutputPaths: input.allowedOutputPaths
      });
      if (typeof result === "object" && result && "ok" in result && result.ok === true) {
        appendWorkingSetWrite(
          workingSet,
          makeFileRef({
            path: action.path,
            source: "shared",
            content: action.content,
            version: "version" in result ? Number((result as { version?: unknown }).version ?? 0) : null,
            updatedAt:
              "updatedAt" in result && (result as { updatedAt?: unknown }).updatedAt !== null && (result as { updatedAt?: unknown }).updatedAt !== undefined
                ? normalizeTimestampString((result as { updatedAt?: unknown }).updatedAt)
                : null
          })
        );
      }
    }
  }

  if (mutationKind && mutationTargetPath) {
    const afterMutation = await loadDebateFileSnapshot(input.debateId, mutationTargetPath);
    mutationJournalId = await insertPendingRuntimeTurnMutation({
      debateId: input.debateId,
      debateAgentId: input.debateAgentId,
      turnNumber: input.turnNumber,
      roundNumber: input.roundNumber,
      mutationKind,
      targetPath: mutationTargetPath,
      sequenceNumber: input.mutationSequenceNumber,
      before: beforeMutation ?? {
        exists: false,
        content: null,
        version: null,
        updatedAt: null,
        createdAt: null
      },
      after: afterMutation,
      actionPayload: action,
      result,
      now: input.now
    });
  }

  await persistRuntimeSeatWorkingSet({
    userId: input.userId,
    debateId: input.debateId,
    debateAgentId: input.debateAgentId,
    agentId: input.agentId,
    allowedOutputPaths: input.allowedOutputPaths,
    workingSet,
    now: input.now
  });
  return { result, workingSet, mutationJournalId };
}

function sampleContent(contentSample: string | null) {
  return contentSample ? contentSample.slice(0, 180) : null;
}

export function makeRuntimeActionLoopRecord(action: RuntimeHarnessAction): LoopRecord {
  if (action.action === "list") {
    return { family: "list", signature: `list:${normalizePath(action.prefix ?? "")}`, path: null, query: null, contentSample: null };
  }
  if (action.action === "search") {
    return { family: "search", signature: `search:${action.query.trim().toLowerCase()}`, path: null, query: action.query.trim().toLowerCase(), contentSample: null };
  }
  if (action.action === "read") {
    return { family: "read", signature: `read:${normalizePath(action.path)}`, path: normalizePath(action.path), query: null, contentSample: null };
  }
  if (action.action === "vote_cast") {
    return { family: "vote_cast", signature: `vote_cast:${action.choice.trim().toLowerCase()}`, path: null, query: null, contentSample: sampleContent(action.reason ?? null) };
  }
  return {
    family: action.action,
    signature: `${action.action}:${normalizePath(action.path)}`,
    path: normalizePath(action.path),
    query: null,
    contentSample: sampleContent(action.content)
  };
}

export function detectRuntimeActionLoop(state: RuntimeActionLoopState, next: LoopRecord) {
  const recent = [...state.records.slice(-5), next];
  const identical = recent.filter((item) => item.signature === next.signature);
  if ((next.family === "search" || next.family === "read" || next.family === "list") && identical.length >= 3) {
    return `${next.family} repeated with no narrowing: ${next.signature}`;
  }
  if (next.family === "write_replace" || next.family === "write_append" || next.family === "write_section") {
    const samePathWrites = recent.filter((item) => item.family.startsWith("write_") && item.path === next.path);
    if (
      samePathWrites.length >= 3 &&
      samePathWrites.every((item) => item.contentSample === next.contentSample)
    ) {
      return `write repeated with near-identical content on ${next.path}`;
    }
  }
  if (recent.length >= 4) {
    const tail = recent.slice(-4).map((item) => item.family);
    if (
      (tail[0] === "list" && tail[1] === "search" && tail[2] === "list" && tail[3] === "search") ||
      (tail[0] === "search" && tail[1] === "list" && tail[2] === "search" && tail[3] === "list")
    ) {
      return `oscillation between ${tail[0]} and ${tail[1]} without progress`;
    }
  }
  return null;
}

export function pushRuntimeActionLoopRecord(state: RuntimeActionLoopState, record: LoopRecord) {
  return {
    records: [...state.records, record].slice(-8)
  };
}
