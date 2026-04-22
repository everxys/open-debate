import { randomUUID } from "crypto";
import { sql } from "kysely";

import { requireSessionUser } from "@/lib/auth";
import { getDebateParticipantRoleType, loadDebateParticipantRoleTypes, type DebateParticipantRoleType } from "@/lib/debate-role-types";
import { ensureDb, ensureDebateAutoRecoverColumns } from "@/lib/db";
import { AppError } from "@/lib/http";
import { buildLineDiffRows, summarizeLineDiffRows } from "@/lib/line-diff";
import { runDebate } from "@/lib/runtime";
import { listStrategyFileAccessRules, mergeWorkflowConfigWithFileAccessRules } from "@/lib/strategies";
import type { DebateRecord } from "@/lib/types";
import {
  createDebateSchema,
  ignoreDebateRuntimeErrorSchema,
  updateDebateAutoRecoverSchema,
  updateDebateQuestionSchema,
  updateDebateSharingSchema
} from "@/lib/validation";
import {
  createDefaultDebateWorkflowConfig,
  type DebateWorkflowConfig,
  formatRequiredDeliverableSummary,
  normalizeDebateWorkflow,
  toCanonicalWorkflowConfig
} from "@/lib/workflow";

function createUniqueDisplayName(used: Set<string>) {
  let index = used.size + 1;
  while (true) {
    const name = `AI-${index}`;
    if (!used.has(name)) {
      used.add(name);
      return name;
    }
    index += 1;
  }
}

function normalizePreferredDisplayName(value: string | null | undefined) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized ? normalized.slice(0, 80) : null;
}

function resolveDisplayName(used: Set<string>, preferred?: string | null) {
  const normalizedPreferred = normalizePreferredDisplayName(preferred);
  if (normalizedPreferred && !used.has(normalizedPreferred)) {
    used.add(normalizedPreferred);
    return normalizedPreferred;
  }
  return createUniqueDisplayName(used);
}

function buildFileActivityDiagnosticLabels(input: {
  actorRoleType: DebateParticipantRoleType;
  summary: { added: number; deleted: number; changed: number };
  beforeContent: string;
  afterContent: string;
  writeMode: string | null;
}) {
  const labels: string[] = [];
  const growth = Math.max(0, input.afterContent.length - input.beforeContent.length);
  if (input.writeMode === "replace" || input.summary.changed >= 12 || growth >= 1800) {
    labels.push("大幅改写中");
  } else if (input.summary.added > 0 || input.summary.deleted > 0) {
    labels.push("内容整合中");
  }
  if (input.summary.added >= 10 || growth >= 1200) {
    labels.push("内容扩写中");
  }
  return labels;
}

function normalizeDebateRow(row: Record<string, unknown>): DebateRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    question: String(row.question),
    status: row.status as DebateRecord["status"],
    maxTurns: Number(row.max_turns),
    currentTurn: Number(row.current_turn),
    tokenUsed: Number(row.token_used),
    enableSharedFacts: row.enable_shared_facts === undefined ? true : Boolean(row.enable_shared_facts),
    isShared: row.is_shared === undefined ? false : Boolean(row.is_shared),
    consensusReached: Boolean(row.consensus_reached),
    consensusSummary: (row.consensus_summary as DebateRecord["consensusSummary"]) ?? null,
    workflowPhaseKind: (row.workflow_phase_kind as DebateRecord["workflowPhaseKind"]) ?? null,
    workflowPhaseTitle: (row.workflow_phase_title as string | null) ?? null,
    workflowPhaseRound: row.workflow_phase_round === null ? null : Number(row.workflow_phase_round),
    runtimeNoticeKind: (row.runtime_notice_kind as DebateRecord["runtimeNoticeKind"]) ?? null,
    runtimeNoticeMessage: (row.runtime_notice_message as string | null) ?? null,
    runtimeNoticeAt: (row.runtime_notice_at as string | null) ?? null,
    lastErrorCode: (row.last_error_code as string | null) ?? null,
    lastErrorMessage: (row.last_error_message as string | null) ?? null,
    ignoredRuntimeErrorSignature: (row.ignored_runtime_error_signature as string | null) ?? null,
    ignoredRuntimeErrorAt: (row.ignored_runtime_error_at as string | null) ?? null,
    autoRecoverOnceOnFailed: Boolean(row.auto_recover_once_on_failed),
    autoRecoverOnceUsedAt: (row.auto_recover_once_used_at as string | null) ?? null,
    startedAt: (row.started_at as string | null) ?? null,
    finishedAt: (row.finished_at as string | null) ?? null,
    stoppedReason: (row.stopped_reason as string | null) ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function buildRuntimeErrorSignature(code: string | null | undefined, message: string | null | undefined) {
  const normalizedCode = typeof code === "string" ? code.trim() : "";
  const normalizedMessage = typeof message === "string" ? message.trim() : "";
  const signature = [normalizedCode, normalizedMessage].filter(Boolean).join(" · ");
  return signature || null;
}

function appendWorkflowSummaryLines(lines: string[], workflow: NonNullable<ReturnType<typeof normalizeDebateWorkflow>>) {
  const hasFinalizationVotePhase = workflow.phaseMachine.phases.some((phase) => phase.kind === "finalization_vote");
  const hasFinalizationPhase = workflow.phaseMachine.phases.some((phase) => phase.kind === "finalization");
  const analysisMinRounds = workflow.phaseMachine.phases.find((phase) => phase.kind === "analysis")?.minRounds ?? 0;
  const deliberationMinRounds = workflow.phaseMachine.phases.find((phase) => phase.kind === "deliberation")?.minRounds ?? 0;
  const finalizationVoteMinRounds = workflow.phaseMachine.phases.find((phase) => phase.kind === "finalization_vote")?.minRounds ?? 0;
  const finalizationMinRounds = workflow.phaseMachine.phases.find((phase) => phase.kind === "finalization")?.minRounds ?? 0;
  lines.push(`- version: v${workflow.workflowVersion}`);
  if (workflow.phaseMachine.phases.length > 0) {
    lines.push("- phaseMachine:");
    for (const phase of workflow.phaseMachine.phases) {
      lines.push(
        `  - ${phase.title}${phase.description ? ` · ${phase.description}` : ""}${phase.minRounds ? ` · minRounds=${phase.minRounds}` : ""}${phase.injectedPrompt ? " · phasePrompt=configured" : ""}`
      );
    }
  }
  lines.push(
    `- phase minRounds: analysis=${analysisMinRounds}; deliberation=${deliberationMinRounds}; finalization_vote=${hasFinalizationVotePhase ? finalizationVoteMinRounds : "n/a"}; finalization=${hasFinalizationPhase ? finalizationMinRounds : "n/a"}`
  );
  lines.push(
    `- consolidation controls: votePhase=${hasFinalizationVotePhase ? "yes" : "no"}; consolidationPhase=${hasFinalizationPhase ? "yes" : "no"}; autoOpenVote=${workflow.phaseMachine.transitionRules.finalization.autoOpenVote ? "yes" : "no"}; requireUnanimousVote=${workflow.phaseMachine.transitionRules.finalization.requireUnanimousVote ? "yes" : "no"}; reopenUntilPassed=${workflow.phaseMachine.transitionRules.finalization.reopenUntilPassed ? "yes" : "no"}; discussionRoundsBetweenVotes=${workflow.phaseMachine.transitionRules.finalization.discussionRoundsBetweenVotes}; requirePhaseForCompletion=${workflow.phaseMachine.transitionRules.finalization.requirePhaseForCompletion ? "yes" : "no"}`
  );
  lines.push(`- completion mode: ${workflow.completion.mode}`);
  lines.push(`- vote tieBreaker: ${workflow.voting.governance.tieBreaker}`);
  lines.push(`- vote maxTieRounds: ${workflow.voting.governance.maxTieRounds}`);
  lines.push(
    `- output budget: discussion=${workflow.promptPolicies.outputBudget.discussionMaxTokens}; writing=${workflow.promptPolicies.outputBudget.writingMaxTokens}`
  );
  lines.push(
    `- deliverable paths: ${workflow.deliverables.allowedPaths.length ? workflow.deliverables.allowedPaths.join(" / ") : "(none)"}`
  );
  if (workflow.ideaBank.rawIdeaBankPath || Object.values(workflow.ideaBank.derivedFiles).some(Boolean)) {
    lines.push(`- idea bank raw: ${workflow.ideaBank.rawIdeaBankPath ?? "(none)"}`);
    lines.push(
      `- idea bank derived: ${[
        workflow.ideaBank.derivedFiles.selectedSTierPath,
        workflow.ideaBank.derivedFiles.selectedATierPath,
        workflow.ideaBank.derivedFiles.rejectedOrMergedPath,
        workflow.ideaBank.derivedFiles.eventMappingsPath,
        workflow.ideaBank.derivedFiles.newlyInventedIdeasPath
      ]
        .filter((item): item is string => Boolean(item))
        .join(" / ")}`
    );
  }
  if (workflow.summarizer.enabled) {
    lines.push(
      `- summarizer: perTurn=${workflow.summarizer.perTurn ? "yes" : "no"} / perRound=${workflow.summarizer.perRound ? "yes" : "no"} / factsBoard=${workflow.summarizer.factsBoard ? "yes" : "no"}`
    );
    lines.push(
      `- summarizer outputs: ${workflow.summarizer.outputPaths.turnSummaryDir} / ${workflow.summarizer.outputPaths.roundSummaryDir} / ${workflow.summarizer.outputPaths.factsBoardPath}`
    );
  }
  if (
    workflow.contextAccess.alwaysRead.length > 0 ||
    workflow.contextAccess.readWhenNeeded.length > 0 ||
    workflow.contextAccess.unlockAfterPhase.length > 0
  ) {
    lines.push(
      `- contextAccess alwaysRead: ${workflow.contextAccess.alwaysRead.length ? workflow.contextAccess.alwaysRead.map((rule) => `[${rule.scope}] ${rule.pathPrefix}`).join(" / ") : "(none)"}`
    );
    lines.push(
      `- contextAccess readWhenNeeded: ${workflow.contextAccess.readWhenNeeded.length ? workflow.contextAccess.readWhenNeeded.map((rule) => `[${rule.scope}] ${rule.pathPrefix}`).join(" / ") : "(none)"}`
    );
    lines.push(
      `- contextAccess unlockAfterPhase: ${workflow.contextAccess.unlockAfterPhase.length ? workflow.contextAccess.unlockAfterPhase.map((rule) => `[${rule.scope}] ${rule.pathPrefix} @ ${rule.phaseKind}`).join(" / ") : "(none)"}`
    );
  }
  if (workflow.deliverables.requiredFiles.length > 0) {
    lines.push("- required deliverables:");
    for (const file of workflow.deliverables.requiredFiles) {
      lines.push(`  - ${formatRequiredDeliverableSummary(file, "plain")}`);
    }
  }
}

function toListItem(debate: DebateRecord) {
  return {
    id: debate.id,
    question: debate.question,
    status: debate.status,
    currentTurn: debate.currentTurn,
    maxTurns: debate.maxTurns,
    tokenUsed: debate.tokenUsed,
    isShared: debate.isShared,
    consensusReached: debate.consensusReached,
    workflowPhaseKind: debate.workflowPhaseKind,
    workflowPhaseTitle: debate.workflowPhaseTitle,
    workflowPhaseRound: debate.workflowPhaseRound,
    runtimeNoticeKind: debate.runtimeNoticeKind,
    runtimeNoticeMessage: debate.runtimeNoticeMessage,
    runtimeNoticeAt: debate.runtimeNoticeAt,
    createdAt: debate.createdAt
  };
}

function isMissingTableError(error: unknown, table: string) {
  if (typeof error !== "object" || error === null) return false;
  const anyError = error as { code?: unknown; message?: unknown };
  if (anyError.code !== "42P01") return false;
  const message = typeof anyError.message === "string" ? anyError.message : "";
  return message.toLowerCase().includes(table.toLowerCase());
}

type DebateFileActivityAction = "read" | "write" | "search" | "list" | "stat";
type DebateFileActivityFilter = "read" | "write" | "summarizer_write";
type DebateFileActivityScope = "debate" | "agent";

function isSummarizerActivityReason(reason: string | null | undefined) {
  return typeof reason === "string" && reason.startsWith("summarizer:");
}

function isMissingColumnError(error: unknown, column: string) {
  if (typeof error !== "object" || error === null) return false;
  const anyError = error as { code?: unknown; message?: unknown };
  if (anyError.code !== "42703") return false;
  const message = typeof anyError.message === "string" ? anyError.message : "";
  return message.toLowerCase().includes(column.toLowerCase());
}

async function getDebate(id: string) {
  const session = await requireSessionUser();
  const db = await ensureDb();
  const row = await db
    .selectFrom("debates")
    .selectAll()
    .where("id", "=", id)
    .where("user_id", "=", session.userId)
    .executeTakeFirst();
  if (!row) {
    throw new AppError("NOT_FOUND", 404, "Debate not found");
  }
  return { session, debate: normalizeDebateRow(row) };
}

async function getDebateForView(id: string, userId: string) {
  try {
    const db = await ensureDb();
    const row = await db
      .selectFrom("debates as d")
      .selectAll("d")
      .select(sql<boolean>`(d.user_id = ${userId})`.as("is_owner"))
      .where("d.id", "=", id)
      .where((eb) => eb.or([eb("d.user_id", "=", userId), eb("d.is_shared", "=", true)]))
      .executeTakeFirst();
    if (!row) {
      throw new AppError("NOT_FOUND", 404, "Debate not found");
    }
    return {
      debate: normalizeDebateRow(row),
      isOwner: Boolean((row as { is_owner?: unknown }).is_owner)
    };
  } catch (error) {
    if (isMissingColumnError(error, "is_shared")) {
      throw new AppError("MIGRATION_REQUIRED", 500, "Missing debates.is_shared column");
    }
    throw error;
  }
}

export async function listDebates(scope: "mine" | "shared" = "mine") {
  const session = await requireSessionUser();
  if (scope === "shared") {
    try {
      const db = await ensureDb();
      const rows = await db
        .selectFrom("debates as d")
        .selectAll("d")
        .select([
          sql<boolean>`(d.user_id = ${session.userId})`.as("is_owner"),
          sql<number>`(
            select count(*)::int from debate_agents da where da.debate_id = d.id
          )`.as("agent_count")
        ])
        .where("d.is_shared", "=", true)
        .orderBy("d.updated_at", "desc")
        .limit(200)
        .execute();
      return rows.map((row: Record<string, unknown>) => ({
        ...toListItem(normalizeDebateRow(row)),
        isOwner: Boolean(row.is_owner),
        agentCount: Number(row.agent_count ?? 0)
      }));
    } catch (error) {
      if (isMissingColumnError(error, "is_shared")) {
        throw new AppError("MIGRATION_REQUIRED", 500, "Missing debates.is_shared column");
      }
      throw error;
    }
  }

  const db = await ensureDb();
  const rows = await db
    .selectFrom("debates as d")
    .selectAll("d")
    .select([
      sql<boolean>`true`.as("is_owner"),
      sql<number>`(
        select count(*)::int from debate_agents da where da.debate_id = d.id
      )`.as("agent_count")
    ])
    .where("d.user_id", "=", session.userId)
    .orderBy("d.created_at", "desc")
    .execute();
  return rows.map((row: Record<string, unknown>) => ({
    ...toListItem(normalizeDebateRow(row)),
    isOwner: Boolean(row.is_owner),
    agentCount: Number(row.agent_count ?? 0)
  }));
}

export async function createDebate(input: unknown) {
  const data = createDebateSchema.parse(input);
  const session = await requireSessionUser();

  if ("agentIds" in data) {
    return createDebateWithAgents(session.userId, data);
  }

  return createDebateWithStrategy(session.userId, data);
}

async function insertPendingDebate(input: {
  userId: string;
  question: string;
  maxTurns: number;
  enableSharedFacts: boolean;
  sourceWorkspaceId?: string | null;
  now: string;
}) {
  const db = await ensureDb();
  const row = await db
    .insertInto("debates")
    .values({
      user_id: input.userId,
      source_workspace_id: input.sourceWorkspaceId ?? null,
      question: input.question,
      status: "pending",
      max_turns: input.maxTurns,
      current_turn: 0,
      token_budget: null,
      token_used: 0,
      enable_shared_facts: input.enableSharedFacts,
      is_shared: false,
      consensus_reached: false,
      consensus_summary: null,
      workflow_phase_kind: null,
      workflow_phase_title: null,
      workflow_phase_round: null,
      runtime_notice_kind: null,
      runtime_notice_message: null,
      runtime_notice_at: null,
      last_error_code: null,
      last_error_message: null,
      ignored_runtime_error_signature: null,
      ignored_runtime_error_at: null,
      auto_recover_once_on_failed: false,
      auto_recover_once_used_at: null,
      started_at: null,
      finished_at: null,
      stopped_reason: null,
      created_at: input.now,
      updated_at: input.now
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return normalizeDebateRow(row);
}

async function insertDebateAgent(input: {
  debateId: string;
  agentId: string;
  displayName: string;
  turnOrder: number;
  now: string;
}) {
  const db = await ensureDb();
  return await db
    .insertInto("debate_agents")
    .values({
      debate_id: input.debateId,
      ai_agent_id: input.agentId,
      display_name: input.displayName,
      turn_order: input.turnOrder,
      turn_count: 0,
      created_at: input.now
    })
    .returning("id")
    .executeTakeFirstOrThrow();
}

async function validateOwnedAgents(userId: string, agentIds: string[]) {
  const db = await ensureDb();
  const agents = await db
    .selectFrom("ai_agents")
    .select("id")
    .where("user_id", "=", userId)
    .where("deleted_at", "is", null)
    .where("is_active", "=", true)
    .where("id", "in", agentIds)
    .execute();
  if (agents.length !== agentIds.length) {
    throw new AppError("VALIDATION_ERROR", 400, "Selected agents are invalid or disabled");
  }
}

async function loadVisibleStrategy(strategyId: string, userId: string) {
  try {
    const db = await ensureDb();
    const row = await db
      .selectFrom("strategies")
      .select("id")
      .where("id", "=", strategyId)
      .where((eb) => eb.or([eb("owner_user_id", "=", userId), eb("is_shared", "=", true)]))
      .executeTakeFirst();
    return row ?? null;
  } catch (error) {
    if (isMissingTableError(error, "strategies")) {
      throw new AppError("MIGRATION_REQUIRED", 500, "Missing strategies tables");
    }
    throw error;
  }
}

async function loadStrategyRolesMap(strategyId: string, roleIds: string[]) {
  try {
    const db = await ensureDb();
    const roleResult = await db
      .selectFrom("strategy_roles")
      .select(["id", "name", "system_prompt"])
      .where("strategy_id", "=", strategyId)
      .where("id", "in", roleIds)
      .execute();
    return new Map(
      roleResult.map((row) => [
        String(row.id),
        {
          id: String(row.id),
          name: (row.name as string | null) ?? null,
          systemPrompt: (row.system_prompt as string | null) ?? null
        }
      ])
    );
  } catch (error) {
    if (isMissingTableError(error, "strategy_roles")) {
      throw new AppError("MIGRATION_REQUIRED", 500, "Missing strategies tables");
    }
    throw error;
  }
}

async function copyStrategyDebateFiles(
  strategyId: string,
  debateId: string,
  roleIds: string[],
  now: string,
  options?: { summaryAgentId?: string | null }
) {
  const db = await ensureDb();
  const workflow = await db
    .selectFrom("strategy_role_files")
    .select("content")
    .where("strategy_role_id", "in", roleIds)
    .where(sql<boolean>`lower(path) = 'debate/workflow.json'`)
    .limit(1)
    .executeTakeFirst();
  const workflowContent = workflow ? String(workflow.content ?? "").trim() : "";
  const strategyFileAccessRules = await listStrategyFileAccessRules(strategyId);
  const canonicalWorkflowContent = (() => {
    try {
      const parsed = workflowContent ? (JSON.parse(workflowContent) as unknown) : createDefaultDebateWorkflowConfig();
      const baseCanonical = (toCanonicalWorkflowConfig(parsed) ?? parsed) as DebateWorkflowConfig;
      const mergedCanonical = mergeWorkflowConfigWithFileAccessRules(baseCanonical, strategyFileAccessRules);
      const canonical = mergedCanonical as Record<string, unknown>;
      const summaryAgentId = typeof options?.summaryAgentId === "string" ? options.summaryAgentId.trim() : "";
      if (
        canonical &&
        typeof canonical === "object" &&
        canonical.summarizer &&
        typeof canonical.summarizer === "object"
      ) {
        canonical.summarizer = {
          ...(canonical.summarizer as Record<string, unknown>),
          aiAgentId: summaryAgentId || null
        };
      }
      return JSON.stringify(canonical, null, 2);
    } catch {
      return JSON.stringify(
        mergeWorkflowConfigWithFileAccessRules(createDefaultDebateWorkflowConfig(), strategyFileAccessRules),
        null,
        2
      );
    }
  })();
  await db
    .insertInto("debate_files")
    .values({
      debate_id: debateId,
      path: "workflow.json",
      content: canonicalWorkflowContent,
      created_at: now,
      updated_at: now
    })
    .onConflict((oc) =>
      oc.columns(["debate_id", "path"]).doUpdateSet({
        content: canonicalWorkflowContent,
        updated_at: now
      })
    )
    .execute();

  const sharedDebateFiles = await db
    .selectFrom("strategy_role_files")
    .select(["path", "content"])
    .where("strategy_role_id", "in", roleIds)
    .where(sql<boolean>`lower(path) like 'debate/ideas/%'`)
    .distinctOn(sql`lower(path)`)
    .orderBy(sql`lower(path)`)
    .orderBy("strategy_role_id", "asc")
    .execute();
  for (const file of sharedDebateFiles) {
    const sourcePath = String(file.path ?? "");
    const normalizedPath = sourcePath.replace(/\\/g, "/").replace(/^\/+/, "").trim();
    const debatePath = normalizedPath.replace(/^debate\//i, "");
    if (!debatePath) continue;
    const content = String(file.content ?? "");
    await db
      .insertInto("debate_files")
      .values({
        debate_id: debateId,
        path: debatePath,
        content,
        created_at: now,
        updated_at: now
      })
      .onConflict((oc) =>
        oc.columns(["debate_id", "path"]).doUpdateSet({
          content,
          updated_at: now
        })
      )
      .execute();
  }
}

async function copyStrategyRoleFilesToDebateAgent(input: {
  roleId: string;
  debateAgentId: string;
  roleName?: string | null;
  now: string;
}) {
  const db = await ensureDb();
  const roleFiles = await db
    .selectFrom("strategy_role_files")
    .select(["path", "content"])
    .where("strategy_role_id", "=", input.roleId)
    .orderBy("path", "asc")
    .execute();

  for (const file of roleFiles) {
    const path = String(file.path ?? "");
    const normalized = path.replace(/\\/g, "/").replace(/^\/+/, "").trim().toLowerCase();
    if (normalized.startsWith("memory/")) continue;
    // Strategy role files are meant to seed per-seat prompt context and reusable workflow/content files.
    // Never seed debate-internal runtime files (they can cause "previous debate memory" leakage).
    if (normalized.startsWith("debate/")) continue;
    if (normalized.startsWith("context/")) continue;
    if (normalized.startsWith("facts/")) continue;
    if (normalized.startsWith("votes/")) continue;
    if (normalized.startsWith("question/")) continue;
    await db
      .insertInto("debate_agent_files")
      .values({
        id: randomUUID(),
        debate_agent_id: input.debateAgentId,
        path,
        content: file.content ?? "",
        created_at: input.now,
        updated_at: input.now
      })
      .execute();
  }

  const baseRoleContent = JSON.stringify({ baseRole: input.roleName?.trim() || "Participant" }, null, 2);
  await db
    .insertInto("debate_agent_files")
    .values({
      id: randomUUID(),
      debate_agent_id: input.debateAgentId,
      path: "context/base_role.json",
      content: baseRoleContent,
      created_at: input.now,
      updated_at: input.now
    })
    .onConflict((oc) =>
      oc.columns(["debate_agent_id", "path"]).doUpdateSet({
        content: baseRoleContent,
        updated_at: input.now
      })
    )
    .execute();
}

async function createDebateWithAgents(
  userId: string,
  data: {
    question: string;
    maxTurns: number;
    enableSharedFacts: boolean;
    agentIds: string[];
  }
) {
  await validateOwnedAgents(userId, data.agentIds);

  const now = new Date().toISOString();
  const debate = await insertPendingDebate({
    userId,
    question: data.question,
    maxTurns: data.maxTurns,
    enableSharedFacts: data.enableSharedFacts,
    now
  });
  const usedDisplayNames = new Set<string>();

  for (let index = 0; index < data.agentIds.length; index += 1) {
    await insertDebateAgent({
      debateId: debate.id,
      agentId: data.agentIds[index],
      displayName: createUniqueDisplayName(usedDisplayNames),
      turnOrder: index + 1,
      now
    });
  }
  return toListItem(debate);
}

async function createDebateWithStrategy(
  userId: string,
  data: {
    question: string;
    maxTurns: number;
    enableSharedFacts: boolean;
    strategy: {
      strategyId: string;
      bindings: Array<{ roleId: string; agentId: string; displayName?: string | null }>;
      summaryAgentId?: string | null;
    };
  }
) {
  return createDebateFromStrategyBindings(userId, {
    question: data.question,
    maxTurns: data.maxTurns,
    enableSharedFacts: data.enableSharedFacts,
    strategyId: data.strategy.strategyId,
    bindings: data.strategy.bindings,
    summaryAgentId: data.strategy.summaryAgentId ?? null,
    sourceWorkspaceId: null,
    workspaceFiles: []
  });
}

async function copyWorkspaceFilesToDebate(input: {
  debateId: string;
  files: Array<{ path: string; content: string }>;
  now: string;
}) {
  const db = await ensureDb();
  for (const file of input.files) {
    const normalizedPath = String(file.path ?? "").replace(/\\/g, "/").replace(/^\/+/, "").trim();
    const debatePath = normalizedPath;
    if (!debatePath) continue;
    const content = String(file.content ?? "");
    await db
      .insertInto("debate_files")
      .values({
        debate_id: input.debateId,
        path: debatePath,
        content,
        created_at: input.now,
        updated_at: input.now
      })
      .onConflict((oc) =>
        oc.columns(["debate_id", "path"]).doUpdateSet({
          content,
          updated_at: input.now
        })
      )
      .execute();
  }
}

export async function createDebateFromStrategyBindings(
  userId: string,
  data: {
    question: string;
    maxTurns: number;
    enableSharedFacts: boolean;
    strategyId: string;
    bindings: Array<{ roleId: string; agentId: string; displayName?: string | null }>;
    summaryAgentId?: string | null;
    sourceWorkspaceId?: string | null;
    workspaceFiles?: Array<{ path: string; content: string }>;
  }
) {
  const bindings = data.bindings;
  const roleIds = bindings.map((binding) => binding.roleId);
  const uniqueRoleIds = Array.from(new Set(roleIds));
  const uniqueAgentIds = Array.from(
    new Set([
      ...bindings.map((binding) => binding.agentId),
      ...(typeof data.summaryAgentId === "string" && data.summaryAgentId.trim()
        ? [data.summaryAgentId.trim()]
        : [])
    ])
  );

  const strategyVisible = await loadVisibleStrategy(data.strategyId, userId);
  if (!strategyVisible) {
    throw new AppError("NOT_FOUND", 404, "Strategy not found");
  }

  await validateOwnedAgents(userId, uniqueAgentIds);
  const rolesById = await loadStrategyRolesMap(data.strategyId, roleIds);
  if (rolesById.size !== uniqueRoleIds.length) {
    throw new AppError("VALIDATION_ERROR", 400, "Selected strategy roles are invalid");
  }

  const now = new Date().toISOString();
  const debate = await insertPendingDebate({
    userId,
    question: data.question,
    maxTurns: data.maxTurns,
    enableSharedFacts: data.enableSharedFacts,
    sourceWorkspaceId: data.sourceWorkspaceId ?? null,
    now
  });

  try {
    const db = await ensureDb();
    const usedDisplayNames = new Set<string>();
    await copyStrategyDebateFiles(data.strategyId, debate.id, uniqueRoleIds, now, {
      summaryAgentId: data.summaryAgentId ?? null
    });
    if (Array.isArray(data.workspaceFiles) && data.workspaceFiles.length > 0) {
      await copyWorkspaceFilesToDebate({
        debateId: debate.id,
        files: data.workspaceFiles,
        now
      });
    }

    for (let index = 0; index < bindings.length; index += 1) {
      const binding = bindings[index];
      const insertParticipant = await insertDebateAgent({
        debateId: debate.id,
        agentId: binding.agentId,
        displayName: resolveDisplayName(usedDisplayNames, binding.displayName),
        turnOrder: index + 1,
        now
      });

      const debateAgentId = insertParticipant?.id;
      if (!debateAgentId) {
        throw new AppError("INTERNAL_ERROR", 500, "Failed to create debate agent");
      }

      const role = rolesById.get(binding.roleId);
      await db
        .insertInto("debate_agent_overrides")
        .values({
          debate_agent_id: debateAgentId,
          system_prompt: role?.systemPrompt ?? null,
          created_at: now,
          updated_at: now
        })
        .execute();
      await copyStrategyRoleFilesToDebateAgent({
        roleId: binding.roleId,
        debateAgentId,
        roleName: role?.name ?? null,
        now
      });
    }
  } catch (error) {
    if (
      isMissingTableError(error, "strategy_role_files") ||
      isMissingTableError(error, "debate_agent_overrides") ||
      isMissingTableError(error, "debate_agent_files") ||
      isMissingTableError(error, "debate_files")
    ) {
      throw new AppError("MIGRATION_REQUIRED", 500, "Missing strategies tables");
    }
    throw error;
  }

  return toListItem(debate);
}

export async function getDebateDetail(id: string) {
  const session = await requireSessionUser();
  const { debate, isOwner } = await getDebateForView(id, session.userId);
  const roleAssignments = await loadDebateParticipantRoleTypes(session.userId, debate.id);
  const db = await ensureDb();
  const agentRows = await db
    .selectFrom("debate_agents as da")
    .innerJoin("ai_agents as a", "a.id", "da.ai_agent_id")
    .select([
      "da.id as debate_agent_id",
      "da.ai_agent_id",
      "da.display_name as display_name",
      "da.turn_order",
      "da.turn_count",
      "a.name as agent_name",
      "a.provider as agent_provider",
      "a.context_length as context_length",
      "a.max_input_tokens as max_input_tokens",
      "a.max_output_tokens as max_output_tokens"
    ])
    .where("da.debate_id", "=", debate.id)
    .orderBy("da.turn_order", "asc")
    .execute();

  const agents = agentRows.map((item) => ({
    id: String(item.ai_agent_id),
    debateAgentId: String(item.debate_agent_id),
    displayName: item.display_name ? String(item.display_name) : `Seat-${Number(item.turn_order)}`,
    baseRoleName: getDebateParticipantRoleType(roleAssignments, String(item.debate_agent_id)),
    name: item.agent_name ? String(item.agent_name) : "Unknown",
    provider: item.agent_provider ? String(item.agent_provider) : "openai",
    contextLength: item.context_length === null ? null : Number(item.context_length),
    maxInputTokens: item.max_input_tokens === null ? null : Number(item.max_input_tokens),
    maxOutputTokens: item.max_output_tokens === null ? null : Number(item.max_output_tokens),
    turnOrder: Number(item.turn_order),
    turnCount: Number(item.turn_count)
  }));

  return {
    id: debate.id,
    question: debate.question,
    status: debate.status,
    currentTurn: debate.currentTurn,
    maxTurns: debate.maxTurns,
    tokenUsed: debate.tokenUsed,
    isShared: debate.isShared,
    isOwner,
    consensusReached: debate.consensusReached,
    consensusSummary: debate.consensusSummary,
    workflowPhaseKind: debate.workflowPhaseKind,
    workflowPhaseTitle: debate.workflowPhaseTitle,
    workflowPhaseRound: debate.workflowPhaseRound,
    runtimeNoticeKind: debate.runtimeNoticeKind,
    runtimeNoticeMessage: debate.runtimeNoticeMessage,
    runtimeNoticeAt: debate.runtimeNoticeAt,
    lastErrorCode: debate.lastErrorCode,
    lastErrorMessage: debate.lastErrorMessage,
    ignoredRuntimeErrorSignature: debate.ignoredRuntimeErrorSignature,
    ignoredRuntimeErrorAt: debate.ignoredRuntimeErrorAt,
    autoRecoverOnceOnFailed: debate.autoRecoverOnceOnFailed,
    autoRecoverOnceUsedAt: debate.autoRecoverOnceUsedAt,
    stoppedReason: debate.stoppedReason,
    agents
  };
}

export async function updateDebateQuestion(id: string, input: unknown) {
  const session = await requireSessionUser();
  const data = updateDebateQuestionSchema.parse(input);
  const now = new Date().toISOString();

  const db = await ensureDb();
  const existing = await db
    .selectFrom("debates")
    .select(["status", "question"])
    .where("id", "=", id)
    .where("user_id", "=", session.userId)
    .executeTakeFirst();
  if (!existing) {
    throw new AppError("NOT_FOUND", 404, "Debate not found");
  }
  const status = String(existing.status ?? "");
  const previousQuestion = String(existing.question ?? "");
  if (status === "running") {
    throw new AppError("CONFLICT", 409, "Please pause the debate before editing the question");
  }
  if (!["pending", "paused"].includes(status)) {
    throw new AppError("CONFLICT", 409, "Debate question cannot be edited in current status");
  }

  const result = await db
    .updateTable("debates")
    .set({
      question: data.question,
      updated_at: now
    })
    .where("id", "=", id)
    .where("user_id", "=", session.userId)
    .where("status", "in", ["pending", "paused"])
    .returningAll()
    .executeTakeFirst();
  if (!result) {
    throw new AppError("CONFLICT", 409, "Debate question update failed");
  }

  // Persist latest diff and versions for runtime injection.
  const prevLines = previousQuestion.replace(/\r\n/g, "\n").split("\n");
  const nextLines = data.question.replace(/\r\n/g, "\n").split("\n");
  let prefix = 0;
  while (prefix < prevLines.length && prefix < nextLines.length && prevLines[prefix] === nextLines[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < prevLines.length - prefix &&
    suffix < nextLines.length - prefix &&
    prevLines[prevLines.length - 1 - suffix] === nextLines[nextLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const removed = prevLines.slice(prefix, prevLines.length - suffix);
  const added = nextLines.slice(prefix, nextLines.length - suffix);
  const limit = 120;
  const removedShown = removed.slice(0, limit);
  const addedShown = added.slice(0, limit);
  const diffLines = [
    ...removedShown.map((line) => `- ${line}`),
    ...addedShown.map((line) => `+ ${line}`)
  ];
  const truncatedNote =
    removed.length > removedShown.length || added.length > addedShown.length
      ? "\n\n（diff 过长，已截断展示）"
      : "";

  try {
    type HistoryItem = { version: number; path: string; at: string };
    const historyPath = "question/history.json";
    const versionPrefix = "question/versions/";
    const pad = (n: number) => String(n).padStart(4, "0");

    const historyRes = await db
      .selectFrom("debate_files")
      .select("content")
      .where("debate_id", "=", id)
      .where("path", "=", historyPath)
      .limit(1)
      .executeTakeFirst();
    let history: HistoryItem[] = [];
    if (historyRes) {
      try {
        const parsed = JSON.parse(String(historyRes.content ?? "")) as unknown;
        if (Array.isArray(parsed)) {
          history = parsed
            .map((item) => ({
              version: Number((item as { version?: unknown }).version),
              path: String((item as { path?: unknown }).path ?? ""),
              at: String((item as { at?: unknown }).at ?? "")
            }))
            .filter((item) => Number.isFinite(item.version) && item.version > 0 && item.path);
        }
      } catch {
      }
    }

    // If no history yet, seed v0001 from previous question (best-effort).
    if (history.length === 0) {
      const seededPath = `${versionPrefix}v${pad(1)}.md`;
      await db
        .insertInto("debate_files")
        .values({
          debate_id: id,
          path: seededPath,
          content: previousQuestion,
          created_at: now,
          updated_at: now
        })
        .onConflict((oc) =>
          oc.columns(["debate_id", "path"]).doUpdateSet({
            content: previousQuestion,
            updated_at: now
          })
        )
        .execute();
      history.push({ version: 1, path: seededPath, at: now });
    }

    const previousVersion = history[history.length - 1]?.version ?? 1;
    const nextVersion = previousVersion + 1;
    const nextVersionPath = `${versionPrefix}v${pad(nextVersion)}.md`;

    await db
      .insertInto("debate_files")
      .values({
        debate_id: id,
        path: nextVersionPath,
        content: data.question,
        created_at: now,
        updated_at: now
      })
      .onConflict((oc) =>
        oc.columns(["debate_id", "path"]).doUpdateSet({
          content: data.question,
          updated_at: now
        })
      )
      .execute();
    history.push({ version: nextVersion, path: nextVersionPath, at: now });

    const historyContent = JSON.stringify(history, null, 2);
    await db
      .insertInto("debate_files")
      .values({
        debate_id: id,
        path: historyPath,
        content: historyContent,
        created_at: now,
        updated_at: now
      })
      .onConflict((oc) =>
        oc.columns(["debate_id", "path"]).doUpdateSet({
          content: historyContent,
          updated_at: now
        })
      )
      .execute();

    const diffMarkdown = [
      "# QUESTION UPDATED",
      "",
      `- At: ${now}`,
      `- From: v${previousVersion}`,
      `- To: v${nextVersion}`,
      "",
      "```diff",
      ...diffLines,
      "```",
      truncatedNote
    ]
      .join("\n")
      .trim();

    await db
      .insertInto("debate_files")
      .values({
        debate_id: id,
        path: "question/latest_diff.md",
        content: diffMarkdown,
        created_at: now,
        updated_at: now
      })
      .onConflict((oc) =>
        oc.columns(["debate_id", "path"]).doUpdateSet({
          content: diffMarkdown,
          updated_at: now
        })
      )
      .execute();
  } catch (error) {
    if (!isMissingTableError(error, "debate_files")) throw error;
  }

  return toListItem(normalizeDebateRow(result));
}

export async function updateDebateSharing(id: string, input: unknown) {
  const session = await requireSessionUser();
  const data = updateDebateSharingSchema.parse(input);
  const now = new Date().toISOString();

  try {
    const db = await ensureDb();
    const result = await db
      .updateTable("debates")
      .set({
        is_shared: data.isShared,
        updated_at: now
      })
      .where("id", "=", id)
      .where("user_id", "=", session.userId)
      .returningAll()
      .executeTakeFirst();
    if (!result) {
      throw new AppError("NOT_FOUND", 404, "Debate not found");
    }

    return toListItem(normalizeDebateRow(result));
  } catch (error) {
    if (isMissingColumnError(error, "is_shared")) {
      throw new AppError("MIGRATION_REQUIRED", 500, "Missing debates.is_shared column");
    }
    throw error;
  }
}

export async function ignoreDebateRuntimeError(id: string, input: unknown) {
  const session = await requireSessionUser();
  ignoreDebateRuntimeErrorSchema.parse(input);
  const db = await ensureDb();
  const current = await db
    .selectFrom("debates")
    .select(["last_error_code", "last_error_message"])
    .where("id", "=", id)
    .where("user_id", "=", session.userId)
    .executeTakeFirst();
  if (!current) {
    throw new AppError("NOT_FOUND", 404, "Debate not found");
  }

  const signature = buildRuntimeErrorSignature(
    current.last_error_code ? String(current.last_error_code) : null,
    current.last_error_message ? String(current.last_error_message) : null
  );
  if (!signature) {
    return getDebateDetail(id);
  }

  const now = new Date().toISOString();
  await db
    .updateTable("debates")
    .set({
      ignored_runtime_error_signature: signature,
      ignored_runtime_error_at: now,
      updated_at: now
    })
    .where("id", "=", id)
    .where("user_id", "=", session.userId)
    .executeTakeFirst();

  return getDebateDetail(id);
}

export async function updateDebateAutoRecover(id: string, input: unknown) {
  const session = await requireSessionUser();
  const data = updateDebateAutoRecoverSchema.parse(input);
  const now = new Date().toISOString();
  async function executeUpdate() {
    const db = await ensureDb();
    return db
      .updateTable("debates")
      .set({
        auto_recover_once_on_failed: data.autoRecoverOnceOnFailed,
        auto_recover_once_used_at: data.autoRecoverOnceOnFailed ? null : sql`auto_recover_once_used_at`,
        updated_at: now
      })
      .where("id", "=", id)
      .where("user_id", "=", session.userId)
      .returningAll()
      .executeTakeFirst();
  }

  let result;
  try {
    result = await executeUpdate();
  } catch (error) {
    if (isMissingColumnError(error, "auto_recover_once_on_failed")) {
      await ensureDebateAutoRecoverColumns();
      result = await executeUpdate();
    } else {
      throw error;
    }
  }
  if (!result) {
    throw new AppError("NOT_FOUND", 404, "Debate not found");
  }
  return getDebateDetail(id);
}

export async function deleteDebate(id: string) {
  const session = await requireSessionUser();

  const db = await ensureDb();
  const existing = await db
    .selectFrom("debates")
    .select("status")
    .where("id", "=", id)
    .where("user_id", "=", session.userId)
    .executeTakeFirst();
  if (!existing) {
    throw new AppError("NOT_FOUND", 404, "Debate not found");
  }
  if (["pending", "running", "paused"].includes(String(existing.status))) {
    throw new AppError("CONFLICT", 409, "Please stop the debate before deleting");
  }

  await db
    .deleteFrom("debates")
    .where("id", "=", id)
    .where("user_id", "=", session.userId)
    .execute();
  return { id };
}

export async function deleteStoppedDebates(options?: { maxCompletedRounds?: number | null }) {
  const session = await requireSessionUser();
  const maxCompletedRounds =
    typeof options?.maxCompletedRounds === "number" && Number.isFinite(options.maxCompletedRounds)
      ? Math.max(0, Math.floor(options.maxCompletedRounds))
      : null;
  const db = await ensureDb();
  const result = await db.executeQuery<{ id: string }>(sql`
    with target as (
      select d.id
        from debates d
       where d.user_id = ${session.userId}
         and d.status in ('stopped', 'failed')
         and (
           ${maxCompletedRounds}::int is null
           or floor(
             d.current_turn::numeric
             / greatest(
                 1,
                 coalesce(
                   (
                     select count(*)::int
                       from debate_agents da
                      where da.debate_id = d.id
                   ),
                   0
                 )
               )::numeric
           ) < ${maxCompletedRounds}::int
         )
    )
    delete from debates d
    using target t
    where d.id = t.id
    returning d.id
  `.compile(db));
  return {
    deletedCount: result.rows.length,
    ids: result.rows.map((row) => String(row.id))
  };
}

export async function listDebateTurns(
  id: string,
  options?: {
    afterTurnNumber?: number;
    beforeTurnNumber?: number;
    limit?: number;
    mode?: "summary" | "full";
  }
) {
  const session = await requireSessionUser();
  const { debate } = await getDebateForView(id, session.userId);
  const roleAssignments = await loadDebateParticipantRoleTypes(session.userId, debate.id);
  const db = await ensureDb();
  const afterRaw = options?.afterTurnNumber ?? null;
  const afterTurnNumber = typeof afterRaw === "number" && Number.isFinite(afterRaw) && afterRaw >= 0 ? Math.floor(afterRaw) : null;
  const beforeRaw = options?.beforeTurnNumber ?? null;
  const beforeTurnNumber =
    typeof beforeRaw === "number" && Number.isFinite(beforeRaw) && beforeRaw > 0 ? Math.floor(beforeRaw) : null;
  const limitRaw = options?.limit ?? null;
  const requestedLimit = typeof limitRaw === "number" && Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : null;
  const limit = requestedLimit ? Math.min(requestedLimit, 500) : null;
  const mode = options?.mode === "full" ? "full" : "summary";
  const previewChars = 220;
  const isBackfill = beforeTurnNumber !== null;
  const isInitialRecentWindow = afterTurnNumber === null && beforeTurnNumber === null && limit !== null;
  const shouldQueryDescending = isBackfill || isInitialRecentWindow;
  const countResult = await db
    .selectFrom("debate_agents")
    .select(sql<number>`count(*)::int`.as("count"))
    .where("debate_id", "=", debate.id)
    .executeTakeFirst();
  const participantCount = Math.max(1, Number(countResult?.count ?? 0) || 1);
  const voteRoundRows = await db
    .selectFrom("debate_files")
    .select("path")
    .where("debate_id", "=", debate.id)
    .where("path", "like", "votes/round-%")
    .execute();
  const closedVoteRounds = new Set<number>();
  for (const row of voteRoundRows) {
    const match = String(row.path ?? "").replace(/\\/g, "/").match(/^votes\/round-([0-9]{1,6})\.json$/);
    if (!match) continue;
    const round = Number(match[1]);
    if (Number.isFinite(round) && round > 0) closedVoteRounds.add(Math.floor(round));
  }
  let turnQuery = db
    .selectFrom("debate_turns as t")
    .innerJoin("ai_agents as a", "a.id", "t.ai_agent_id")
    .leftJoin("debate_agents as da", "da.id", "t.debate_agent_id")
    .selectAll("t")
    .select([
      sql<string>`coalesce(da.display_name, a.name)`.as("agent_name"),
      "a.provider as agent_provider",
      sql<string>`left(t.content, ${previewChars})`.as("content_preview"),
      sql<number>`char_length(t.content)`.as("content_length"),
      sql<boolean>`(t.structured_output is not null)`.as("has_structured_output")
    ])
    .where("t.debate_id", "=", debate.id);
  if (afterTurnNumber !== null) {
    turnQuery = turnQuery.where("t.turn_number", ">", afterTurnNumber);
  }
  if (beforeTurnNumber !== null) {
    turnQuery = turnQuery.where("t.turn_number", "<", beforeTurnNumber);
  }
  turnQuery = turnQuery.orderBy("t.turn_number", shouldQueryDescending ? "desc" : "asc");
  if (limit) {
    turnQuery = turnQuery.limit(limit + 1);
  }
  let rows = await turnQuery.execute();
  const hasMore = limit ? rows.length > limit : false;
  if (limit && rows.length > limit) rows = rows.slice(0, limit);
  if (shouldQueryDescending) rows = rows.reverse();

  function mapSpeechRoundIndexToActualRound(speechRoundIndex: number) {
    if (!Number.isFinite(speechRoundIndex) || speechRoundIndex <= 0) return 1;
    let actualRound = 0;
    let spokenRounds = 0;
    while (spokenRounds < speechRoundIndex) {
      actualRound += 1;
      if (closedVoteRounds.has(actualRound)) continue;
      spokenRounds += 1;
    }
    return actualRound;
  }

  const items = rows.map((turn) => {
    const turnNumber = Number(turn.turn_number);
    const speechRoundIndex = Math.floor((turnNumber - 1) / participantCount) + 1;
    const roundNumber = mapSpeechRoundIndexToActualRound(speechRoundIndex);
    const base = {
      id: String(turn.id),
      turnNumber,
      roundNumber,
      preview: String(turn.content_preview ?? ""),
      contentLength: Number(turn.content_length ?? 0),
      hasStructuredOutput: Boolean(turn.has_structured_output),
      parseStatus: String(turn.parse_status),
      tokenUsed: Number(turn.token_used),
      createdAt: String(turn.created_at),
      debateAgentId: turn.debate_agent_id ? String(turn.debate_agent_id) : null,
      seatNumber: turn.seat_number === null || turn.seat_number === undefined ? null : Number(turn.seat_number),
      agent: {
        name: turn.agent_name ? String(turn.agent_name) : "Unknown",
        baseRoleName: turn.debate_agent_id
          ? getDebateParticipantRoleType(roleAssignments, String(turn.debate_agent_id))
          : "Participant",
        provider: turn.agent_provider ? String(turn.agent_provider) : "openai"
      }
    };
    if (mode === "summary") return base;
    return {
      ...base,
      content: String(turn.content),
      structuredOutput: (turn.structured_output as Record<string, unknown> | null) ?? null
    };
  });

  return {
    items,
    hasMore
  };
}

export async function getDebateTurnDetail(id: string, turnNumber: number) {
  const session = await requireSessionUser();
  const { debate } = await getDebateForView(id, session.userId);
  const roleAssignments = await loadDebateParticipantRoleTypes(session.userId, debate.id);
  const db = await ensureDb();
  if (!Number.isFinite(turnNumber) || turnNumber <= 0) {
    throw new AppError("VALIDATION_ERROR", 400, "Invalid turn number");
  }
  const safeTurnNumber = Math.max(1, Math.floor(turnNumber));
  const countResult = await db
    .selectFrom("debate_agents")
    .select(sql<number>`count(*)::int`.as("count"))
    .where("debate_id", "=", debate.id)
    .executeTakeFirst();
  const participantCount = Math.max(1, Number(countResult?.count ?? 0) || 1);
  const voteRoundRows = await db
    .selectFrom("debate_files")
    .select("path")
    .where("debate_id", "=", debate.id)
    .where("path", "like", "votes/round-%")
    .execute();
  const closedVoteRounds = new Set<number>();
  for (const voteRow of voteRoundRows) {
    const match = String(voteRow.path ?? "").replace(/\\/g, "/").match(/^votes\/round-([0-9]{1,6})\.json$/);
    if (!match) continue;
    const round = Number(match[1]);
    if (Number.isFinite(round) && round > 0) closedVoteRounds.add(Math.floor(round));
  }
  const speechRoundIndex = Math.floor((safeTurnNumber - 1) / participantCount) + 1;
  let actualRoundNumber = 0;
  let spokenRounds = 0;
  while (spokenRounds < speechRoundIndex) {
    actualRoundNumber += 1;
    if (closedVoteRounds.has(actualRoundNumber)) continue;
    spokenRounds += 1;
  }
  const result = await db
    .selectFrom("debate_turns as t")
    .innerJoin("ai_agents as a", "a.id", "t.ai_agent_id")
    .leftJoin("debate_agents as da", "da.id", "t.debate_agent_id")
    .selectAll("t")
    .select([
      sql<string>`coalesce(da.display_name, a.name)`.as("agent_name"),
      "a.provider as agent_provider",
      sql<string>`left(t.content, 220)`.as("content_preview"),
      sql<number>`char_length(t.content)`.as("content_length"),
      sql<boolean>`(t.structured_output is not null)`.as("has_structured_output")
    ])
    .where("t.debate_id", "=", debate.id)
    .where("t.turn_number", "=", safeTurnNumber)
    .limit(1)
    .executeTakeFirst();
  if (!result) {
    throw new AppError("NOT_FOUND", 404, "Turn not found");
  }
  const row = result;
  return {
    id: String(row.id),
    turnNumber: safeTurnNumber,
    roundNumber: actualRoundNumber,
    preview: String(row.content_preview ?? ""),
    contentLength: Number(row.content_length ?? 0),
    hasStructuredOutput: Boolean(row.has_structured_output),
    content: String(row.content),
    structuredOutput: (row.structured_output as Record<string, unknown> | null) ?? null,
    parseStatus: String(row.parse_status),
    tokenUsed: Number(row.token_used),
    createdAt: String(row.created_at),
    debateAgentId: row.debate_agent_id ? String(row.debate_agent_id) : null,
    seatNumber: row.seat_number === null || row.seat_number === undefined ? null : Number(row.seat_number),
    agent: {
      name: row.agent_name ? String(row.agent_name) : "Unknown",
      baseRoleName: row.debate_agent_id
        ? getDebateParticipantRoleType(roleAssignments, String(row.debate_agent_id))
        : "Participant",
      provider: row.agent_provider ? String(row.agent_provider) : "openai"
    }
  };
}

export type DebateAllFileEntry =
  | {
      scope: "debate";
      path: string;
      updatedAt: string | null;
    }
  | {
      scope: "agent";
      debateAgentId: string;
      turnOrder: number | null;
      agentName: string;
      path: string;
      updatedAt: string | null;
    };

export async function listDebateAllFiles(debateId: string): Promise<DebateAllFileEntry[]> {
  const session = await requireSessionUser();
  const { isOwner } = await getDebateForView(debateId, session.userId);
  if (!isOwner) {
    throw new AppError("NOT_FOUND", 404, "Debate not found");
  }

  const entries: DebateAllFileEntry[] = [];
  const db = await ensureDb();

  try {
    const debateFiles = await db
      .selectFrom("debate_files as f")
      .select(["f.path", "f.updated_at"])
      .where("f.debate_id", "=", debateId)
      .orderBy("f.path", "asc")
      .limit(5000)
      .execute();
    for (const row of debateFiles) {
      entries.push({
        scope: "debate",
        path: String(row.path),
        updatedAt: row.updated_at ? String(row.updated_at) : null
      });
    }
  } catch (error) {
    if (isMissingTableError(error, "debate_files")) {
      throw new AppError("MIGRATION_REQUIRED", 500, "Missing debate_files table");
    }
    throw error;
  }

  try {
    const agentFiles = await db
      .selectFrom("debate_agent_files as f")
      .innerJoin("debate_agents as da", "da.id", "f.debate_agent_id")
      .select([
        "da.id as debate_agent_id",
        "da.turn_order as turn_order",
        "da.display_name as display_name",
        "f.path as path",
        "f.updated_at as updated_at"
      ])
      .where("da.debate_id", "=", debateId)
      .orderBy("da.turn_order", "asc")
      .orderBy(sql`da.display_name`, "asc")
      .orderBy("f.path", "asc")
      .limit(20000)
      .execute();
    for (const row of agentFiles) {
      entries.push({
        scope: "agent",
        debateAgentId: String(row.debate_agent_id),
        turnOrder: row.turn_order === null ? null : Number(row.turn_order),
        agentName: row.display_name ? String(row.display_name) : "Unknown",
        path: String(row.path),
        updatedAt: row.updated_at ? String(row.updated_at) : null
      });
    }
  } catch (error) {
    if (isMissingTableError(error, "debate_agent_files")) {
      // Keep debate files available even if agent files table doesn't exist yet.
      return entries;
    }
    throw error;
  }

  return entries;
}

export async function listDebateFiles(id: string, prefix?: string) {
  const session = await requireSessionUser();
  const { isOwner } = await getDebateForView(id, session.userId);
  if (!isOwner) {
    throw new AppError("NOT_FOUND", 404, "Debate not found");
  }

  try {
    const db = await ensureDb();
    const result = await db
      .selectFrom("debate_files as f")
      .select("f.path")
      .where("f.debate_id", "=", id)
      .where("f.path", "like", `${(prefix ?? "").trim()}%`)
      .orderBy("f.path", "asc")
      .limit(500)
      .execute();
    return result.map((row) => String(row.path));
  } catch (error) {
    if (isMissingTableError(error, "debate_files")) {
      throw new AppError("MIGRATION_REQUIRED", 500, "Missing debate_files table");
    }
    throw error;
  }
}

export async function readDebateFile(id: string, path: string) {
  const session = await requireSessionUser();
  const { isOwner } = await getDebateForView(id, session.userId);
  if (!isOwner) {
    throw new AppError("NOT_FOUND", 404, "Debate not found");
  }

  try {
    const db = await ensureDb();
    const result = await db
      .selectFrom("debate_files as f")
      .select(["f.content", "f.updated_at", "f.version"])
      .where("f.debate_id", "=", id)
      .where("f.path", "=", path)
      .limit(1)
      .executeTakeFirst();
    if (!result) {
      throw new AppError("NOT_FOUND", 404, "File not found");
    }
    return {
      path,
      content: String(result.content ?? ""),
      updatedAt: String(result.updated_at ?? ""),
      version: Number(result.version ?? 1) || 1
    };
  } catch (error) {
    if (isMissingTableError(error, "debate_files")) {
      throw new AppError("MIGRATION_REQUIRED", 500, "Missing debate_files table");
    }
    throw error;
  }
}

export async function listDebateAgentFiles(debateId: string, debateAgentId: string, prefix?: string) {
  const session = await requireSessionUser();
  const { isOwner } = await getDebateForView(debateId, session.userId);
  if (!isOwner) {
    throw new AppError("NOT_FOUND", 404, "Debate not found");
  }

  try {
    const db = await ensureDb();
    const result = await db
      .selectFrom("debate_agent_files as f")
      .innerJoin("debate_agents as da", "da.id", "f.debate_agent_id")
      .select("f.path")
      .where("da.debate_id", "=", debateId)
      .where("f.debate_agent_id", "=", debateAgentId)
      .where("f.path", "like", `${(prefix ?? "").trim()}%`)
      .orderBy("f.path", "asc")
      .limit(500)
      .execute();
    return result.map((row) => String(row.path));
  } catch (error) {
    if (isMissingTableError(error, "debate_agent_files")) {
      throw new AppError("MIGRATION_REQUIRED", 500, "Missing debate_agent_files table");
    }
    throw error;
  }
}

export async function readDebateAgentFile(debateId: string, debateAgentId: string, path: string) {
  const session = await requireSessionUser();
  const { isOwner } = await getDebateForView(debateId, session.userId);
  if (!isOwner) {
    throw new AppError("NOT_FOUND", 404, "Debate not found");
  }

  try {
    const db = await ensureDb();
    const result = await db
      .selectFrom("debate_agent_files as f")
      .innerJoin("debate_agents as da", "da.id", "f.debate_agent_id")
      .select(["f.content", "f.updated_at"])
      .where("da.debate_id", "=", debateId)
      .where("f.debate_agent_id", "=", debateAgentId)
      .where("f.path", "=", path)
      .limit(1)
      .executeTakeFirst();
    if (!result) {
      throw new AppError("NOT_FOUND", 404, "File not found");
    }
    return {
      path,
      content: String(result.content ?? ""),
      updatedAt: String(result.updated_at ?? "")
    };
  } catch (error) {
    if (isMissingTableError(error, "debate_agent_files")) {
      throw new AppError("MIGRATION_REQUIRED", 500, "Missing debate_agent_files table");
    }
    throw error;
  }
}

export async function listDebateFileActivity(
  debateId: string,
  options?: {
    action?: DebateFileActivityFilter;
    path?: string;
    debateAgentId?: string;
    roundNumber?: number;
    turnNumber?: number;
    limit?: number;
    beforeId?: string;
  }
) {
  const session = await requireSessionUser();
  const { isOwner } = await getDebateForView(debateId, session.userId);
  if (!isOwner) {
    throw new AppError("NOT_FOUND", 404, "Debate not found");
  }

  const requestedLimit = typeof options?.limit === "number" && Number.isFinite(options.limit) ? Math.floor(options.limit) : 40;
  const limit = Math.min(Math.max(requestedLimit, 1), 100);
  const action =
    options?.action === "read" || options?.action === "write" || options?.action === "summarizer_write" ? options.action : null;
  const path = typeof options?.path === "string" && options.path.trim() ? options.path.trim() : null;
  const debateAgentId = typeof options?.debateAgentId === "string" && options.debateAgentId.trim() ? options.debateAgentId.trim() : null;
  const roundNumber = typeof options?.roundNumber === "number" && Number.isFinite(options.roundNumber) ? Math.floor(options.roundNumber) : null;
  const turnNumber = typeof options?.turnNumber === "number" && Number.isFinite(options.turnNumber) ? Math.floor(options.turnNumber) : null;
  const beforeId = typeof options?.beforeId === "string" && options.beforeId.trim() ? options.beforeId.trim() : null;

  try {
    const db = await ensureDb();
    const result = await db.executeQuery<{
      id: string;
      action: DebateFileActivityAction;
      scope: DebateFileActivityScope;
      path: string;
      debate_agent_id: string;
      target_debate_agent_id: string | null;
      turn_number: number;
      round_number: number;
      created_at: string;
      write_mode: string | null;
      before_version: number | null;
      after_version: number | null;
      before_content: string | null;
      after_content: string | null;
      target_heading: string | null;
      reason: string | null;
      actor_name: string | null;
      actor_seat_name: string | null;
      target_seat_name: string | null;
    }>(sql`
      with cursor_row as (
        select created_at, id
          from debate_file_activity_logs
         where id = ${beforeId}
         limit 1
      )
      select
        l.id,
        l.action,
        l.scope,
        l.path,
        l.debate_agent_id,
        l.target_debate_agent_id,
        l.turn_number,
        l.round_number,
        l.created_at,
        l.write_mode,
        l.before_version,
        l.after_version,
        l.before_content,
        l.after_content,
        l.target_heading,
        l.reason,
        a.name as actor_name,
        da.display_name as actor_seat_name,
        target_da.display_name as target_seat_name
      from debate_file_activity_logs l
      join debate_agents da on da.id = l.debate_agent_id
      join ai_agents a on a.id = da.ai_agent_id
      left join debate_agents target_da on target_da.id = l.target_debate_agent_id
      where l.debate_id = ${debateId}
        and (
          ${action}::text is null
          or (${action}::text = 'write' and l.action = 'write' and (l.reason is null or l.reason not like 'summarizer:%'))
          or (${action}::text = 'summarizer_write' and l.action = 'write' and l.reason like 'summarizer:%')
          or (${action}::text = 'read' and l.action <> 'write')
        )
        and (${path}::text is null or l.path = ${path}::text)
        and (${debateAgentId}::uuid is null or l.debate_agent_id = ${debateAgentId}::uuid)
        and (${roundNumber}::int is null or l.round_number = ${roundNumber}::int)
        and (${turnNumber}::int is null or l.turn_number = ${turnNumber}::int)
        and (
          ${beforeId}::uuid is null
          or exists (
            select 1
              from cursor_row c
             where (l.created_at, l.id) < (c.created_at, c.id)
          )
        )
      order by l.created_at desc, l.id desc
      limit ${limit + 1}
    `.compile(db));

    const countsResult = await db.executeQuery<{ action: string; count: number }>(sql`
      select
        case
          when action = 'write' and reason like 'summarizer:%' then 'summarizer_write'
          when action = 'write' then 'write'
          else 'read'
        end as action,
        count(*)::int as count
        from debate_file_activity_logs
       where debate_id = ${debateId}
       group by
        case
          when action = 'write' and reason like 'summarizer:%' then 'summarizer_write'
          when action = 'write' then 'write'
          else 'read'
        end
    `.compile(db));

    const hasMore = result.rows.length > limit;
    const rows = hasMore ? result.rows.slice(0, limit) : result.rows;
    const counts = { read: 0, write: 0, summarizerWrite: 0 };
    const roleAssignments = await loadDebateParticipantRoleTypes(session.userId, debateId);
    for (const row of countsResult.rows) {
      if (row.action === "read") counts.read = Number(row.count ?? 0);
      if (row.action === "write") counts.write = Number(row.count ?? 0);
      if (row.action === "summarizer_write") counts.summarizerWrite = Number(row.count ?? 0);
    }
    return {
      items: rows.map((row) => {
        const beforeContent = String(row.before_content ?? "");
        const afterContent = String(row.after_content ?? "");
        const summary =
          row.action === "write"
            ? summarizeLineDiffRows(
                buildLineDiffRows(beforeContent, afterContent)
              )
            : { added: 0, deleted: 0, changed: 0 };
        const actorRoleType = getDebateParticipantRoleType(roleAssignments, String(row.debate_agent_id));
        const isSummarizer = isSummarizerActivityReason(row.reason ? String(row.reason) : null);
        return {
          id: String(row.id),
          action: row.action,
          scope: row.scope,
          path: String(row.path),
          debateAgentId: String(row.debate_agent_id),
          targetDebateAgentId: row.target_debate_agent_id ? String(row.target_debate_agent_id) : null,
          targetSeatName: row.target_seat_name ? String(row.target_seat_name) : null,
          turnNumber: Number(row.turn_number),
          roundNumber: Number(row.round_number),
          createdAt: String(row.created_at),
          writeMode: row.write_mode ? String(row.write_mode) : null,
          beforeVersion: row.before_version === null ? null : Number(row.before_version),
          afterVersion: row.after_version === null ? null : Number(row.after_version),
          targetHeading: row.target_heading ? String(row.target_heading) : null,
          reason: row.reason ? String(row.reason) : null,
          agentName: isSummarizer ? "独立总结器" : row.actor_seat_name ? String(row.actor_seat_name) : String(row.actor_name ?? "Unknown"),
          actorRoleType: isSummarizer ? "Summarizer" : actorRoleType,
          diagnosticLabels:
            row.action === "write"
              ? buildFileActivityDiagnosticLabels({
                  actorRoleType,
                  summary,
                  beforeContent,
                  afterContent,
                  writeMode: row.write_mode ? String(row.write_mode) : null
                })
              : [],
          summary
        };
      }),
      hasMore,
      counts
    };
  } catch (error) {
    if (isMissingTableError(error, "debate_file_activity_logs")) {
      throw new AppError("MIGRATION_REQUIRED", 500, "Missing debate_file_activity_logs table");
    }
    throw error;
  }
}

export async function listDebateFileActivityNav(debateId: string, options?: { action?: DebateFileActivityFilter }) {
  const session = await requireSessionUser();
  const { isOwner } = await getDebateForView(debateId, session.userId);
  if (!isOwner) {
    throw new AppError("NOT_FOUND", 404, "Debate not found");
  }

  const action =
    options?.action === "read" || options?.action === "write" || options?.action === "summarizer_write" ? options.action : null;

  try {
    const db = await ensureDb();
    const result = await db.executeQuery<{
      debate_agent_id: string;
      round_number: number;
      turn_number: number;
      count: number;
      reason: string | null;
      actor_name: string | null;
      actor_seat_name: string | null;
    }>(sql`
      select
        l.debate_agent_id,
        l.round_number,
        l.turn_number,
        count(*)::int as count,
        max(l.reason) as reason,
        max(a.name) as actor_name,
        max(da.display_name) as actor_seat_name
      from debate_file_activity_logs l
      join debate_agents da on da.id = l.debate_agent_id
      join ai_agents a on a.id = da.ai_agent_id
      where l.debate_id = ${debateId}
        and (
          ${action}::text is null
          or (${action}::text = 'write' and l.action = 'write' and (l.reason is null or l.reason not like 'summarizer:%'))
          or (${action}::text = 'summarizer_write' and l.action = 'write' and l.reason like 'summarizer:%')
          or (${action}::text = 'read' and l.action <> 'write')
        )
      group by l.debate_agent_id, l.round_number, l.turn_number
      order by max(da.display_name) asc, l.round_number desc, l.turn_number desc
    `.compile(db));
    const countsResult = await db.executeQuery<{ action: string; count: number }>(sql`
      select
        case
          when action = 'write' and reason like 'summarizer:%' then 'summarizer_write'
          when action = 'write' then 'write'
          else 'read'
        end as action,
        count(*)::int as count
        from debate_file_activity_logs
       where debate_id = ${debateId}
       group by
        case
          when action = 'write' and reason like 'summarizer:%' then 'summarizer_write'
          when action = 'write' then 'write'
          else 'read'
        end
    `.compile(db));

    const roleAssignments = await loadDebateParticipantRoleTypes(session.userId, debateId);
    const counts = { read: 0, write: 0, summarizerWrite: 0 };
    for (const row of countsResult.rows) {
      if (row.action === "read") counts.read = Number(row.count ?? 0);
      if (row.action === "write") counts.write = Number(row.count ?? 0);
      if (row.action === "summarizer_write") counts.summarizerWrite = Number(row.count ?? 0);
    }
    const agentMap = new Map<
      string,
      {
        key: string;
        debateAgentId: string;
        agentName: string;
        actorRoleType: string;
        count: number;
        rounds: Map<number, { key: string; roundNumber: number; count: number; turns: Map<number, { key: string; turnNumber: number; count: number; entries: never[] }> }>;
      }
    >();

    for (const row of result.rows) {
      const debateAgentId = String(row.debate_agent_id);
      const isSummarizer = isSummarizerActivityReason(row.reason ? String(row.reason) : null);
      const agentName = isSummarizer ? "独立总结器" : row.actor_seat_name ? String(row.actor_seat_name) : String(row.actor_name ?? "Unknown");
      const actorRoleType = isSummarizer ? "Summarizer" : getDebateParticipantRoleType(roleAssignments, debateAgentId);
      const agentKey = `${debateAgentId || "unknown"}:${agentName || "Unknown AI"}`;
      const roundNumber = Number(row.round_number);
      const turnNumber = Number(row.turn_number);
      const count = Number(row.count ?? 0);

      let agent = agentMap.get(agentKey);
      if (!agent) {
        agent = {
          key: agentKey,
          debateAgentId,
          agentName,
          actorRoleType,
          count: 0,
          rounds: new Map()
        };
        agentMap.set(agentKey, agent);
      }
      agent.count += count;

      let round = agent.rounds.get(roundNumber);
      if (!round) {
        round = {
          key: `${agentKey}:round:${roundNumber}`,
          roundNumber,
          count: 0,
          turns: new Map()
        };
        agent.rounds.set(roundNumber, round);
      }
      round.count += count;

      round.turns.set(turnNumber, {
        key: `${agentKey}:round:${roundNumber}:turn:${turnNumber}`,
        turnNumber,
        count,
        entries: []
      });
    }

    const groups = Array.from(agentMap.values())
      .sort((a, b) => a.agentName.localeCompare(b.agentName, undefined, { numeric: true, sensitivity: "base" }))
      .map((agent) => ({
        key: agent.key,
        debateAgentId: agent.debateAgentId,
        agentName: agent.agentName,
        actorRoleType: agent.actorRoleType,
        count: agent.count,
        rounds: Array.from(agent.rounds.values())
          .sort((a, b) => b.roundNumber - a.roundNumber)
          .map((round) => ({
            key: round.key,
            roundNumber: round.roundNumber,
            count: round.count,
            turns: Array.from(round.turns.values()).sort((a, b) => b.turnNumber - a.turnNumber)
          }))
      }));
    return { groups, counts };
  } catch (error) {
    if (isMissingTableError(error, "debate_file_activity_logs")) {
      throw new AppError("MIGRATION_REQUIRED", 500, "Missing debate_file_activity_logs table");
    }
    throw error;
  }
}

export async function getDebateFileActivityDetail(debateId: string, entryId: string) {
  const session = await requireSessionUser();
  const { isOwner } = await getDebateForView(debateId, session.userId);
  if (!isOwner) {
    throw new AppError("NOT_FOUND", 404, "Debate not found");
  }

  try {
    const db = await ensureDb();
    const result = await db.executeQuery<{
      id: string;
      action: DebateFileActivityAction;
      scope: DebateFileActivityScope;
      path: string;
      debate_agent_id: string;
      target_debate_agent_id: string | null;
      turn_number: number;
      round_number: number;
      created_at: string;
      write_mode: string | null;
      before_version: number | null;
      after_version: number | null;
      before_content: string | null;
      after_content: string | null;
      target_heading: string | null;
      reason: string | null;
      actor_name: string | null;
      actor_seat_name: string | null;
      target_seat_name: string | null;
    }>(sql`
      select
        l.id,
        l.action,
        l.scope,
        l.path,
        l.debate_agent_id,
        l.target_debate_agent_id,
        l.turn_number,
        l.round_number,
        l.created_at,
        l.write_mode,
        l.before_version,
        l.after_version,
        l.before_content,
        l.after_content,
        l.target_heading,
        l.reason,
        a.name as actor_name,
        da.display_name as actor_seat_name,
        target_da.display_name as target_seat_name
      from debate_file_activity_logs l
      join debate_agents da on da.id = l.debate_agent_id
      join ai_agents a on a.id = da.ai_agent_id
      left join debate_agents target_da on target_da.id = l.target_debate_agent_id
      where l.debate_id = ${debateId}
        and l.id = ${entryId}
      limit 1
    `.compile(db));
    if ((result.rows.length ?? 0) !== 1) {
      throw new AppError("NOT_FOUND", 404, "File activity not found");
    }
    const row = result.rows[0];
    const beforeContent = String(row.before_content ?? "");
    const afterContent = String(row.after_content ?? "");
    const diffRows = row.action === "write" ? buildLineDiffRows(beforeContent, afterContent) : [];
    const summary = summarizeLineDiffRows(diffRows);
    const roleAssignments = await loadDebateParticipantRoleTypes(session.userId, debateId);
    const actorRoleType = getDebateParticipantRoleType(roleAssignments, String(row.debate_agent_id));
    const isSummarizer = isSummarizerActivityReason(row.reason ? String(row.reason) : null);

    return {
      id: String(row.id),
      action: row.action,
      scope: row.scope,
      path: String(row.path),
      debateAgentId: String(row.debate_agent_id),
      targetDebateAgentId: row.target_debate_agent_id ? String(row.target_debate_agent_id) : null,
      targetSeatName: row.target_seat_name ? String(row.target_seat_name) : null,
      turnNumber: Number(row.turn_number),
      roundNumber: Number(row.round_number),
      createdAt: String(row.created_at),
      writeMode: row.write_mode ? String(row.write_mode) : null,
      beforeVersion: row.before_version === null ? null : Number(row.before_version),
      afterVersion: row.after_version === null ? null : Number(row.after_version),
      beforeContent,
      afterContent,
      targetHeading: row.target_heading ? String(row.target_heading) : null,
      reason: row.reason ? String(row.reason) : null,
      agentName: isSummarizer ? "独立总结器" : row.actor_seat_name ? String(row.actor_seat_name) : String(row.actor_name ?? "Unknown"),
      actorRoleType: isSummarizer ? "Summarizer" : actorRoleType,
      diagnosticLabels:
        row.action === "write"
          ? buildFileActivityDiagnosticLabels({
              actorRoleType,
              summary,
              beforeContent,
              afterContent,
              writeMode: row.write_mode ? String(row.write_mode) : null
            })
          : [],
      diffRows,
      summary
    };
  } catch (error) {
    if (isMissingTableError(error, "debate_file_activity_logs")) {
      throw new AppError("MIGRATION_REQUIRED", 500, "Missing debate_file_activity_logs table");
    }
    throw error;
  }
}

export async function startDebateSegment(id: string, input: unknown) {
  const session = await requireSessionUser();
  const body = input as { reason?: unknown };
  const reason = typeof body?.reason === "string" ? body.reason.trim() : "";

  const db = await ensureDb();
  const debateRes = await db
    .selectFrom("debates")
    .select(["status", "current_turn", "question"])
    .where("id", "=", id)
    .where("user_id", "=", session.userId)
    .executeTakeFirst();
  if (!debateRes) {
    throw new AppError("NOT_FOUND", 404, "Debate not found");
  }

  const status = String(debateRes.status ?? "");
  const currentTurn = Number(debateRes.current_turn ?? 0);
  const question = String(debateRes.question ?? "");
  if (status !== "paused") {
    throw new AppError("CONFLICT", 409, "Please pause the debate before starting a new segment");
  }

  const participants = await db
    .selectFrom("debate_agents as da")
    .select(["da.id as debate_agent_id", "da.turn_order", "da.display_name as display_name"])
    .where("da.debate_id", "=", id)
    .orderBy("da.turn_order", "asc")
    .execute();
  const participantCount = participants.length;
  if (participantCount < 2) {
    throw new AppError("VALIDATION_ERROR", 400, "Debate requires at least 2 agents");
  }
  if (participantCount > 0 && currentTurn % participantCount !== 0) {
    throw new AppError("CONFLICT", 409, "Please start a new segment at a round boundary (after a full round ends)");
  }

  const now = new Date().toISOString();
  const completedRounds = Math.floor(currentTurn / participantCount);
  const minTurnNumber = currentTurn + 1;

  let workflow: ReturnType<typeof normalizeDebateWorkflow> | null = null;
  try {
    const workflowRes = await db
      .selectFrom("debate_files")
      .select("content")
      .where("debate_id", "=", id)
      .where("path", "=", "workflow.json")
      .limit(1)
      .executeTakeFirst();
    const workflowRaw = workflowRes ? String(workflowRes.content ?? "") : "";
    workflow = workflowRaw ? normalizeDebateWorkflow(JSON.parse(workflowRaw) as unknown) : null;
  } catch {
    workflow = null;
  }

  let directive = "";
  try {
    const directiveRes = await db
      .selectFrom("debate_files")
      .select("content")
      .where("debate_id", "=", id)
      .where("path", "=", "votes/decision.md")
      .limit(1)
      .executeTakeFirst();
    directive = directiveRes ? String(directiveRes.content ?? "") : "";
  } catch {
    directive = "";
  }

  const checkpointPrefix = "context/checkpoints/seg-";
  const existing = await db
    .selectFrom("debate_files")
    .select("path")
    .where("debate_id", "=", id)
    .where("path", "like", `${checkpointPrefix}%`)
    .orderBy("path", "asc")
    .limit(200)
    .execute();
  const nextIndex = existing.length + 1;
  const pad = (n: number) => String(n).padStart(4, "0");
  const seg = `seg-${pad(nextIndex)}`;
  const checkpointPath = `${checkpointPrefix}${pad(nextIndex)}.md`;

  const lines: string[] = [];
  lines.push(`# Segment Checkpoint · ${seg}`);
  lines.push("");
  lines.push(`- At: ${now}`);
  lines.push(`- Completed rounds: ${completedRounds}`);
  lines.push(`- Current turn: ${currentTurn}`);
  lines.push(`- Context window reset: next model calls will inject recent turns from Turn >= ${minTurnNumber}.`);
  if (reason) lines.push(`- Reason: ${reason}`);
  lines.push("");
  lines.push("## Question");
  lines.push(question ? question : "(empty)");
  lines.push("");
  lines.push("## Seats (current order)");
  for (const row of participants) {
    lines.push(`- Seat-${Number(row.turn_order)}: ${String(row.display_name ?? `Seat-${Number(row.turn_order)}`)}`);
  }

  lines.push("");
  lines.push("## Rules (summary)");
  if (!workflow?.enabled) {
    lines.push("- disabled (no workflow.json or enabled=false)");
  } else {
    appendWorkflowSummaryLines(lines, workflow);
  }

  if (directive.trim()) {
    lines.push("");
    lines.push("## Latest official directive");
    lines.push(directive.trim());
  }

  lines.push("");
  lines.push("## Notes");
  lines.push("- This checkpoint is injected to all seats as a shared segment context.");
  lines.push("- Long-term memory (per seat) and shared facts (if enabled) are still used.");

  const checkpointContent = lines.join("\n").trim() + "\n";

  try {
    const windowContent = JSON.stringify({ enabled: true, minTurnNumber, at: now, seg, reason }, null, 2);
    await db
      .insertInto("debate_files")
      .values({
        debate_id: id,
        path: "context/window.json",
        content: windowContent,
        created_at: now,
        updated_at: now
      })
      .onConflict((oc) =>
        oc.columns(["debate_id", "path"]).doUpdateSet({
          content: windowContent,
          updated_at: now
        })
      )
      .execute();
    await db
      .insertInto("debate_files")
      .values({
        debate_id: id,
        path: "context/segment.md",
        content: checkpointContent,
        created_at: now,
        updated_at: now
      })
      .onConflict((oc) =>
        oc.columns(["debate_id", "path"]).doUpdateSet({
          content: checkpointContent,
          updated_at: now
        })
      )
      .execute();
    await db
      .insertInto("debate_files")
      .values({
        debate_id: id,
        path: checkpointPath,
        content: checkpointContent,
        created_at: now,
        updated_at: now
      })
      .onConflict((oc) =>
        oc.columns(["debate_id", "path"]).doUpdateSet({
          content: checkpointContent,
          updated_at: now
        })
      )
      .execute();
  } catch (error) {
    if (isMissingTableError(error, "debate_files")) {
      throw new AppError("MIGRATION_REQUIRED", 500, "Missing debate_files table");
    }
    throw error;
  }

  return { ok: true, seg, minTurnNumber, checkpointPath };
}

export async function startDebate(id: string) {
  const session = await requireSessionUser();

  const db = await ensureDb();
  const before = await db
    .selectFrom("debates")
    .select(["status", "current_turn"])
    .where("id", "=", id)
    .where("user_id", "=", session.userId)
    .executeTakeFirst();
  if (!before) {
    throw new AppError("NOT_FOUND", 404, "Debate not found");
  }
  const beforeStatus = String(before.status ?? "");
  const beforeTurn = Number(before.current_turn ?? 0);

  const now = new Date().toISOString();
  const result = await db
    .updateTable("debates")
    .set({
      status: "running",
      started_at: sql`coalesce(started_at, ${now})`,
      runtime_notice_kind: null,
      runtime_notice_message: null,
      runtime_notice_at: null,
      last_error_code: null,
      last_error_message: null,
      ignored_runtime_error_signature: null,
      ignored_runtime_error_at: null,
      updated_at: now
    })
    .where("id", "=", id)
    .where("user_id", "=", session.userId)
    .where("status", "in", ["pending", "paused"])
    .returningAll()
    .executeTakeFirst();
  if (!result) {
    throw new AppError("CONFLICT", 409, "Debate cannot be started");
  }

  // Safety: older versions could accidentally seed memory/* into a brand-new debate (via strategy role files).
  // Ensure a new debate starts with a fresh context.
  if (beforeStatus === "pending" && beforeTurn === 0) {
    await db.executeQuery(sql`
      delete from debate_agent_files f
      using debate_agents da
      where f.debate_agent_id = da.id
        and da.debate_id = ${id}
        and lower(replace(f.path, '\\\\', '/')) like 'memory/%'
    `.compile(db));

    // Also clean any other debate-internal files that should never be seeded from strategy role files.
    await db.executeQuery(sql`
      delete from debate_agent_files f
      using debate_agents da
      where f.debate_agent_id = da.id
        and da.debate_id = ${id}
        and (
          lower(replace(f.path, '\\\\', '/')) like 'debate/%'
          or (
            lower(replace(f.path, '\\\\', '/')) like 'context/%'
            and lower(replace(f.path, '\\\\', '/')) <> 'context/base_role.json'
          )
          or lower(replace(f.path, '\\\\', '/')) like 'facts/%'
          or lower(replace(f.path, '\\\\', '/')) like 'votes/%'
          or lower(replace(f.path, '\\\\', '/')) like 'question/%'
        )
    `.compile(db));

    await db
      .deleteFrom("debate_files")
      .where("debate_id", "=", id)
      .where("path", "=", "facts/board.md")
      .execute();
    await db.executeQuery(sql`
      delete from debate_files
       where debate_id = ${id}
         and (
           lower(replace(path, '\\\\', '/')) like 'context/%'
           or lower(replace(path, '\\\\', '/')) like 'facts/%'
           or lower(replace(path, '\\\\', '/')) like 'votes/%'
           or lower(replace(path, '\\\\', '/')) like 'question/%'
         )
    `.compile(db));
  }

  void runDebate(id, session.userId);
  return toListItem(normalizeDebateRow(result));
}

export async function pauseDebate(id: string) {
  const session = await requireSessionUser();
  const now = new Date().toISOString();
  const db = await ensureDb();
  const result = await db
    .updateTable("debates")
    .set({
      status: "paused",
      updated_at: now
    })
    .where("id", "=", id)
    .where("user_id", "=", session.userId)
    .where("status", "=", "running")
    .returningAll()
    .executeTakeFirst();
  if (!result) {
    throw new AppError("CONFLICT", 409, "Only running debates can be paused");
  }
  return toListItem(normalizeDebateRow(result));
}

export async function resumeDebate(id: string) {
  const session = await requireSessionUser();
  const now = new Date().toISOString();
  const db = await ensureDb();
  const result = await db
    .updateTable("debates")
    .set({
      status: "running",
      runtime_notice_kind: null,
      runtime_notice_message: null,
      runtime_notice_at: null,
      ignored_runtime_error_signature: null,
      ignored_runtime_error_at: null,
      updated_at: now
    })
    .where("id", "=", id)
    .where("user_id", "=", session.userId)
    .where("status", "=", "paused")
    .returningAll()
    .executeTakeFirst();
  if (!result) {
    throw new AppError("CONFLICT", 409, "Only paused debates can be resumed");
  }
  void runDebate(id, session.userId);
  return toListItem(normalizeDebateRow(result));
}

export async function repairDebate(id: string) {
  const session = await requireSessionUser();
  const now = new Date().toISOString();
  const db = await ensureDb();
  const result = await db
    .updateTable("debates")
    .set({
      status: "paused",
      finished_at: null,
      stopped_reason: null,
      runtime_notice_kind: "interrupted",
      runtime_notice_message: "该辩论已从 failed 修复为 paused；请确认状态后手动恢复运行",
      runtime_notice_at: now,
      last_error_code: null,
      last_error_message: null,
      ignored_runtime_error_signature: null,
      ignored_runtime_error_at: null,
      updated_at: now
    })
    .where("id", "=", id)
    .where("user_id", "=", session.userId)
    .where("status", "=", "failed")
    .returningAll()
    .executeTakeFirst();
  if (!result) {
    throw new AppError("CONFLICT", 409, "Only failed debates can be repaired");
  }
  return toListItem(normalizeDebateRow(result));
}

export async function stopDebate(id: string, reason: string) {
  const session = await requireSessionUser();
  const now = new Date().toISOString();
  const db = await ensureDb();
  const result = await db
    .updateTable("debates")
    .set({
      status: "stopped",
      stopped_reason: reason,
      finished_at: now,
      updated_at: now
    })
    .where("id", "=", id)
    .where("user_id", "=", session.userId)
    .where("status", "in", ["pending", "running", "paused"])
    .returningAll()
    .executeTakeFirst();
  if (!result) {
    throw new AppError("CONFLICT", 409, "Debate is already finished");
  }
  return toListItem(normalizeDebateRow(result));
}

export async function appendAgentToDebate(id: string, agentId: string) {
  const { session, debate } = await getDebate(id);
  if (!["running", "paused"].includes(debate.status)) {
    throw new AppError("CONFLICT", 409, "Only running/paused debates can add new agents");
  }

  const db = await ensureDb();
  const agent = await db
    .selectFrom("ai_agents")
    .select("id")
    .where("user_id", "=", session.userId)
    .where("deleted_at", "is", null)
    .where("id", "=", agentId)
    .executeTakeFirst();
  if (!agent) {
    throw new AppError("NOT_FOUND", 404, "Agent not found");
  }

  const maxOrderResult = await db
    .selectFrom("debate_agents")
    .select(sql<number>`coalesce(max(turn_order), 0)::int`.as("max"))
    .where("debate_id", "=", debate.id)
    .executeTakeFirst();
  const maxOrder = maxOrderResult?.max ?? 0;
  const existingDisplayNames = await db
    .selectFrom("debate_agents")
    .select("display_name")
    .where("debate_id", "=", debate.id)
    .execute();
  const usedDisplayNames = new Set(
    existingDisplayNames.map((row) => (row.display_name ? String(row.display_name) : "")).filter(Boolean)
  );
  const now = new Date().toISOString();

  await db
    .insertInto("debate_agents")
    .values({
      debate_id: debate.id,
      ai_agent_id: agentId,
      display_name: createUniqueDisplayName(usedDisplayNames),
      turn_order: maxOrder + 1,
      turn_count: 0,
      created_at: now
    })
    .execute();

  await db
    .updateTable("debates")
    .set({ updated_at: now })
    .where("id", "=", debate.id)
    .execute();

  return getDebateDetail(debate.id);
}
