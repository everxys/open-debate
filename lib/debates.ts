import { randomUUID } from "crypto";

import { requireSessionUser } from "@/lib/auth";
import { getDebateParticipantRoleType, loadDebateParticipantRoleTypes, type DebateParticipantRoleType } from "@/lib/debate-role-types";
import { query } from "@/lib/db";
import { AppError } from "@/lib/http";
import { buildLineDiffRows, summarizeLineDiffRows } from "@/lib/line-diff";
import { runDebate } from "@/lib/runtime";
import type { DebateRecord } from "@/lib/types";
import { createDebateSchema, updateDebateQuestionSchema, updateDebateSharingSchema } from "@/lib/validation";
import {
  createDefaultDebateWorkflowConfig,
  formatRequiredDeliverableSummary,
  normalizeDebateWorkflow,
  toCanonicalWorkflowConfig
} from "@/lib/workflow";

const DISPLAY_NAME_ADJECTIVES = ["青", "赤", "白", "玄", "金", "银", "苍", "墨", "紫", "绿", "蓝", "橙"];
const DISPLAY_NAME_NOUNS = ["狐", "狼", "鹰", "鲸", "蛇", "虎", "鹿", "鸦", "猫", "犬", "熊", "龙", "雀"];
const MAX_DISPLAY_NAME_ATTEMPTS = 80;

function pickRandomElement<T>(items: T[]) {
  if (items.length === 0) throw new Error("pickRandomElement: empty list");
  return items[Math.floor(Math.random() * items.length)] as T;
}

function createUniqueDisplayName(used: Set<string>) {
  for (let attempt = 0; attempt < MAX_DISPLAY_NAME_ATTEMPTS; attempt += 1) {
    const name = `${pickRandomElement(DISPLAY_NAME_ADJECTIVES)}${pickRandomElement(DISPLAY_NAME_NOUNS)}`;
    if (!used.has(name)) {
      used.add(name);
      return name;
    }
  }
  const fallback = `席位-${randomUUID().slice(0, 8)}`;
  used.add(fallback);
  return fallback;
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

const DEFAULT_WORKFLOW_JSON = JSON.stringify(createDefaultDebateWorkflowConfig(), null, 2);

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
    startedAt: (row.started_at as string | null) ?? null,
    finishedAt: (row.finished_at as string | null) ?? null,
    stoppedReason: (row.stopped_reason as string | null) ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
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
  const result = await query<Record<string, unknown>>(
    "select * from debates where id = $1 and user_id = $2",
    [id, session.userId]
  );
  if ((result.rowCount ?? 0) !== 1) {
    throw new AppError("NOT_FOUND", 404, "Debate not found");
  }
  return { session, debate: normalizeDebateRow(result.rows[0]) };
}

async function getDebateForView(id: string, userId: string) {
  try {
    const result = await query<Record<string, unknown>>(
      `
        select d.*,
               (d.user_id = $2) as is_owner
          from debates d
         where d.id = $1
           and (d.user_id = $2 or d.is_shared = true)
      `,
      [id, userId]
    );
    if ((result.rowCount ?? 0) !== 1) {
      throw new AppError("NOT_FOUND", 404, "Debate not found");
    }
    return {
      debate: normalizeDebateRow(result.rows[0]),
      isOwner: Boolean((result.rows[0] as { is_owner?: unknown }).is_owner)
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
      const result = await query<Record<string, unknown>>(
        `
          select d.*,
                 (d.user_id = $1) as is_owner,
                 (select count(*)::int from debate_agents da where da.debate_id = d.id) as agent_count
            from debates d
           where d.is_shared = true
           order by d.updated_at desc
           limit 200
        `,
        [session.userId]
      );
      return result.rows.map((row: Record<string, unknown>) => ({
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

  const result = await query<Record<string, unknown>>(
    `
      select d.*,
             true as is_owner,
             (select count(*)::int from debate_agents da where da.debate_id = d.id) as agent_count
        from debates d
       where d.user_id = $1
       order by d.created_at desc
    `,
    [session.userId]
  );
  return result.rows.map((row: Record<string, unknown>) => ({
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
  now: string;
}) {
  const insertedDebate = await query<Record<string, unknown>>(
    `insert into debates (
      user_id, question, status, max_turns, current_turn, token_budget, token_used, enable_shared_facts,
      consensus_reached, consensus_summary, workflow_phase_kind, workflow_phase_title, workflow_phase_round, last_error_code, last_error_message,
      runtime_notice_kind, runtime_notice_message, runtime_notice_at,
      started_at, finished_at, stopped_reason, created_at, updated_at
    ) values (
      $1,$2,'pending',$3,0,null,0,$4,
      false,null,null,null,null,null,null,
      null,null,null,
      null,null,null,$5,$5
    )
    returning *`,
    [input.userId, input.question, input.maxTurns, input.enableSharedFacts, input.now]
  );
  return normalizeDebateRow(insertedDebate.rows[0]);
}

async function insertDebateAgent(input: {
  debateId: string;
  agentId: string;
  displayName: string;
  turnOrder: number;
  now: string;
}) {
  return query<{ id: string }>(
    `insert into debate_agents (debate_id, ai_agent_id, display_name, turn_order, turn_count, created_at)
     values ($1,$2,$3,$4,0,$5)
     returning id`,
    [input.debateId, input.agentId, input.displayName, input.turnOrder, input.now]
  );
}

async function ensureDefaultDebateWorkflow(debateId: string, now: string) {
  // Ensure workflow.json exists so debate flow is deterministic.
  try {
    await query(
      `
        insert into debate_files (debate_id, path, content, created_at, updated_at)
        values ($1, 'workflow.json', $2, $3, $3)
        on conflict (debate_id, path) do nothing
      `,
      [debateId, DEFAULT_WORKFLOW_JSON, now]
    );
  } catch {
    // backward-compat: older DBs may not have debate_files yet.
  }
}

async function validateOwnedAgents(userId: string, agentIds: string[]) {
  const agents = await query<{ id: string }>(
    "select id from ai_agents where user_id = $1 and deleted_at is null and id = any($2::uuid[])",
    [userId, agentIds]
  );
  if ((agents.rowCount ?? 0) !== agentIds.length) {
    throw new AppError("VALIDATION_ERROR", 400, "Selected agents are invalid");
  }
}

async function loadVisibleStrategy(strategyId: string, userId: string) {
  try {
    const strategyResult = await query<{ id: string }>(
      "select id from strategies where id = $1 and (owner_user_id = $2 or is_shared = true)",
      [strategyId, userId]
    );
    return strategyResult.rows[0] ?? null;
  } catch (error) {
    if (isMissingTableError(error, "strategies")) {
      throw new AppError("MIGRATION_REQUIRED", 500, "Missing strategies tables");
    }
    throw error;
  }
}

async function loadStrategyRolesMap(strategyId: string, roleIds: string[]) {
  try {
    const roleResult = await query<Record<string, unknown>>(
      "select id, name, system_prompt from strategy_roles where strategy_id = $1 and id = any($2::uuid[])",
      [strategyId, roleIds]
    );
    return new Map(
      roleResult.rows.map((row) => [
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
  debateId: string,
  roleIds: string[],
  now: string,
  options?: { summaryAgentId?: string | null }
) {
  const workflow = await query<{ content: string }>(
    `
      select content
        from strategy_role_files
       where strategy_role_id = any($1::uuid[])
         and lower(path) = 'debate/workflow.json'
       limit 1
    `,
    [roleIds]
  );
  const workflowContent =
    (workflow.rowCount ?? 0) >= 1 ? String(workflow.rows[0]?.content ?? "").trim() : "";
  const canonicalWorkflowContent = (() => {
    if (!workflowContent) return DEFAULT_WORKFLOW_JSON;
    try {
      const parsed = JSON.parse(workflowContent) as unknown;
      const canonical = (toCanonicalWorkflowConfig(parsed) ?? parsed) as Record<string, unknown>;
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
      return DEFAULT_WORKFLOW_JSON;
    }
  })();
  await query(
    `
      insert into debate_files (debate_id, path, content, created_at, updated_at)
      values ($1, 'workflow.json', $2, $3, $3)
      on conflict (debate_id, path)
      do update set content = excluded.content, updated_at = excluded.updated_at
    `,
    [debateId, canonicalWorkflowContent, now]
  );

  const sharedDebateFiles = await query<{ path: string; content: string }>(
    `
      select distinct on (lower(path)) path, content
        from strategy_role_files
       where strategy_role_id = any($1::uuid[])
         and lower(path) like 'debate/ideas/%'
       order by lower(path), strategy_role_id asc
    `,
    [roleIds]
  );
  for (const file of sharedDebateFiles.rows) {
    const sourcePath = String(file.path ?? "");
    const normalizedPath = sourcePath.replace(/\\/g, "/").replace(/^\/+/, "").trim();
    const debatePath = normalizedPath.replace(/^debate\//i, "");
    if (!debatePath) continue;
    await query(
      `
        insert into debate_files (debate_id, path, content, created_at, updated_at)
        values ($1, $2, $3, $4, $4)
        on conflict (debate_id, path)
        do update set content = excluded.content, updated_at = excluded.updated_at
      `,
      [debateId, debatePath, String(file.content ?? ""), now]
    );
  }
}

async function copyStrategyRoleFilesToDebateAgent(input: {
  roleId: string;
  debateAgentId: string;
  roleName?: string | null;
  now: string;
}) {
  const roleFiles = await query<{ path: string; content: string }>(
    "select path, content from strategy_role_files where strategy_role_id = $1 order by path asc",
    [input.roleId]
  );

  for (const file of roleFiles.rows) {
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
    await query(
      `insert into debate_agent_files (id, debate_agent_id, path, content, created_at, updated_at)
       values ($1,$2,$3,$4,$5,$5)`,
      [randomUUID(), input.debateAgentId, path, file.content ?? "", input.now]
    );
  }

  await query(
    `insert into debate_agent_files (id, debate_agent_id, path, content, created_at, updated_at)
     values ($1,$2,$3,$4,$5,$5)
     on conflict (debate_agent_id, path)
     do update set content = excluded.content, updated_at = excluded.updated_at`,
    [
      randomUUID(),
      input.debateAgentId,
      "context/base_role.json",
      JSON.stringify({ baseRole: input.roleName?.trim() || "Participant" }, null, 2),
      input.now
    ]
  );
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

  await ensureDefaultDebateWorkflow(debate.id, now);
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
      bindings: Array<{ roleId: string; agentId: string }>;
      summaryAgentId?: string | null;
    };
  }
) {
  const bindings = data.strategy.bindings;
  const roleIds = bindings.map((binding) => binding.roleId);
  const uniqueRoleIds = Array.from(new Set(roleIds));
  const uniqueAgentIds = Array.from(
    new Set([
      ...bindings.map((binding) => binding.agentId),
      ...(typeof data.strategy.summaryAgentId === "string" && data.strategy.summaryAgentId.trim()
        ? [data.strategy.summaryAgentId.trim()]
        : [])
    ])
  );

  const strategyVisible = await loadVisibleStrategy(data.strategy.strategyId, userId);
  if (!strategyVisible) {
    throw new AppError("NOT_FOUND", 404, "Strategy not found");
  }

  await validateOwnedAgents(userId, uniqueAgentIds);
  const rolesById = await loadStrategyRolesMap(data.strategy.strategyId, roleIds);
  if (rolesById.size !== uniqueRoleIds.length) {
    throw new AppError("VALIDATION_ERROR", 400, "Selected strategy roles are invalid");
  }

  const now = new Date().toISOString();
  const debate = await insertPendingDebate({
    userId,
    question: data.question,
    maxTurns: data.maxTurns,
    enableSharedFacts: data.enableSharedFacts,
    now
  });

  try {
    const usedDisplayNames = new Set<string>();
    await copyStrategyDebateFiles(debate.id, uniqueRoleIds, now, {
      summaryAgentId: data.strategy.summaryAgentId ?? null
    });

    for (let index = 0; index < bindings.length; index += 1) {
      const binding = bindings[index];
      const insertParticipant = await insertDebateAgent({
        debateId: debate.id,
        agentId: binding.agentId,
        displayName: createUniqueDisplayName(usedDisplayNames),
        turnOrder: index + 1,
        now
      });

      const debateAgentId = insertParticipant.rows[0]?.id;
      if (!debateAgentId) {
        throw new AppError("INTERNAL_ERROR", 500, "Failed to create debate agent");
      }

      const role = rolesById.get(binding.roleId);
      await query(
        `insert into debate_agent_overrides (debate_agent_id, system_prompt, created_at, updated_at)
         values ($1,$2,$3,$3)`,
        [debateAgentId, role?.systemPrompt ?? null, now]
      );
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
  const agentRows = await query<Record<string, unknown>>(
    `
      select da.id as debate_agent_id,
             da.ai_agent_id,
             da.display_name as display_name,
             da.turn_order,
             da.turn_count,
             a.name as agent_name,
             a.provider as agent_provider,
             a.context_length as context_length,
             a.max_input_tokens as max_input_tokens,
             a.max_output_tokens as max_output_tokens
        from debate_agents da
        join ai_agents a on a.id = da.ai_agent_id
       where da.debate_id = $1
       order by da.turn_order asc
    `,
    [debate.id]
  );

  const agents = agentRows.rows.map((item) => ({
    id: String(item.ai_agent_id),
    debateAgentId: String(item.debate_agent_id),
    displayName: item.display_name ? String(item.display_name) : `Seat-${Number(item.turn_order)}`,
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
    lastErrorCode: debate.lastErrorCode,
    lastErrorMessage: debate.lastErrorMessage,
    stoppedReason: debate.stoppedReason,
    agents
  };
}

export async function updateDebateQuestion(id: string, input: unknown) {
  const session = await requireSessionUser();
  const data = updateDebateQuestionSchema.parse(input);
  const now = new Date().toISOString();

  const existing = await query<{ status: string; question: string }>(
    "select status, question from debates where id = $1 and user_id = $2",
    [id, session.userId]
  );
  if ((existing.rowCount ?? 0) !== 1) {
    throw new AppError("NOT_FOUND", 404, "Debate not found");
  }
  const status = String(existing.rows[0].status ?? "");
  const previousQuestion = String(existing.rows[0].question ?? "");
  if (status === "running") {
    throw new AppError("CONFLICT", 409, "Please pause the debate before editing the question");
  }
  if (!["pending", "paused"].includes(status)) {
    throw new AppError("CONFLICT", 409, "Debate question cannot be edited in current status");
  }

  const result = await query<Record<string, unknown>>(
    `update debates
        set question = $3,
            updated_at = $4
      where id = $1 and user_id = $2 and status in ('pending','paused')
      returning *`,
    [id, session.userId, data.question, now]
  );
  if ((result.rowCount ?? 0) !== 1) {
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

    const historyRes = await query<{ content: string }>(
      "select content from debate_files where debate_id = $1 and path = $2 limit 1",
      [id, historyPath]
    );
    let history: HistoryItem[] = [];
    if ((historyRes.rowCount ?? 0) === 1) {
      try {
        const parsed = JSON.parse(String(historyRes.rows[0].content ?? "")) as unknown;
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
      await query(
        `
          insert into debate_files (debate_id, path, content, created_at, updated_at)
          values ($1, $2, $3, $4, $4)
          on conflict (debate_id, path)
          do update set content = excluded.content, updated_at = excluded.updated_at
        `,
        [id, seededPath, previousQuestion, now]
      );
      history.push({ version: 1, path: seededPath, at: now });
    }

    const previousVersion = history[history.length - 1]?.version ?? 1;
    const nextVersion = previousVersion + 1;
    const nextVersionPath = `${versionPrefix}v${pad(nextVersion)}.md`;

    await query(
      `
        insert into debate_files (debate_id, path, content, created_at, updated_at)
        values ($1, $2, $3, $4, $4)
        on conflict (debate_id, path)
        do update set content = excluded.content, updated_at = excluded.updated_at
      `,
      [id, nextVersionPath, data.question, now]
    );
    history.push({ version: nextVersion, path: nextVersionPath, at: now });

    await query(
      `
        insert into debate_files (debate_id, path, content, created_at, updated_at)
        values ($1, $2, $3, $4, $4)
        on conflict (debate_id, path)
        do update set content = excluded.content, updated_at = excluded.updated_at
      `,
      [id, historyPath, JSON.stringify(history, null, 2), now]
    );

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

    await query(
      `
        insert into debate_files (debate_id, path, content, created_at, updated_at)
        values ($1, $2, $3, $4, $4)
        on conflict (debate_id, path)
        do update set content = excluded.content, updated_at = excluded.updated_at
      `,
      [id, "question/latest_diff.md", diffMarkdown, now]
    );
  } catch (error) {
    if (!isMissingTableError(error, "debate_files")) throw error;
  }

  return toListItem(normalizeDebateRow(result.rows[0]));
}

export async function updateDebateSharing(id: string, input: unknown) {
  const session = await requireSessionUser();
  const data = updateDebateSharingSchema.parse(input);
  const now = new Date().toISOString();

  try {
    const result = await query<Record<string, unknown>>(
      `update debates
          set is_shared = $3,
              updated_at = $4
        where id = $1 and user_id = $2
        returning *`,
      [id, session.userId, data.isShared, now]
    );

    if ((result.rowCount ?? 0) !== 1) {
      throw new AppError("NOT_FOUND", 404, "Debate not found");
    }

    return toListItem(normalizeDebateRow(result.rows[0]));
  } catch (error) {
    if (isMissingColumnError(error, "is_shared")) {
      throw new AppError("MIGRATION_REQUIRED", 500, "Missing debates.is_shared column");
    }
    throw error;
  }
}

export async function deleteDebate(id: string) {
  const session = await requireSessionUser();

  const existing = await query<{ status: string }>(
    "select status from debates where id = $1 and user_id = $2",
    [id, session.userId]
  );
  if ((existing.rowCount ?? 0) !== 1) {
    throw new AppError("NOT_FOUND", 404, "Debate not found");
  }
  if (["pending", "running", "paused"].includes(String(existing.rows[0].status))) {
    throw new AppError("CONFLICT", 409, "Please stop the debate before deleting");
  }

  await query("delete from debates where id = $1 and user_id = $2", [id, session.userId]);
  return { id };
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
  const countResult = await query<{ count: number }>(
    "select count(*)::int as count from debate_agents where debate_id = $1",
    [debate.id]
  );
  const participantCount = Math.max(1, Number(countResult.rows[0]?.count ?? 0) || 1);
  const voteRoundRows = await query<{ path: string }>(
    `
      select path
        from debate_files
       where debate_id = $1
         and path like 'votes/round-%'
    `,
    [debate.id]
  );
  const closedVoteRounds = new Set<number>();
  for (const row of voteRoundRows.rows) {
    const match = String(row.path ?? "").replace(/\\/g, "/").match(/^votes\/round-([0-9]{1,6})\.json$/);
    if (!match) continue;
    const round = Number(match[1]);
    if (Number.isFinite(round) && round > 0) closedVoteRounds.add(Math.floor(round));
  }
  const turnRows = await query<Record<string, unknown>>(
    `
      select t.*,
             coalesce(da.display_name, a.name) as agent_name,
             a.provider as agent_provider,
             left(t.content, $4::int) as content_preview,
             char_length(t.content) as content_length,
             (t.structured_output is not null) as has_structured_output
       from debate_turns t
       join ai_agents a on a.id = t.ai_agent_id
       left join debate_agents da on da.id = t.debate_agent_id
       where t.debate_id = $1
         and ($2::int is null or t.turn_number > $2::int)
         and ($3::int is null or t.turn_number < $3::int)
       order by t.turn_number ${shouldQueryDescending ? "desc" : "asc"}
       ${limit ? `limit $5::int` : ""}
    `,
    limit
      ? [debate.id, afterTurnNumber, beforeTurnNumber, previewChars, limit + 1]
      : [debate.id, afterTurnNumber, beforeTurnNumber, previewChars]
  );

  let rows = turnRows.rows;
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
  if (!Number.isFinite(turnNumber) || turnNumber <= 0) {
    throw new AppError("VALIDATION_ERROR", 400, "Invalid turn number");
  }
  const safeTurnNumber = Math.max(1, Math.floor(turnNumber));
  const countResult = await query<{ count: number }>(
    "select count(*)::int as count from debate_agents where debate_id = $1",
    [debate.id]
  );
  const participantCount = Math.max(1, Number(countResult.rows[0]?.count ?? 0) || 1);
  const voteRoundRows = await query<{ path: string }>(
    `
      select path
        from debate_files
       where debate_id = $1
         and path like 'votes/round-%'
    `,
    [debate.id]
  );
  const closedVoteRounds = new Set<number>();
  for (const voteRow of voteRoundRows.rows) {
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
  const result = await query<Record<string, unknown>>(
    `
      select t.*,
             coalesce(da.display_name, a.name) as agent_name,
             a.provider as agent_provider,
             left(t.content, $3::int) as content_preview,
             char_length(t.content) as content_length,
             (t.structured_output is not null) as has_structured_output
        from debate_turns t
        join ai_agents a on a.id = t.ai_agent_id
        left join debate_agents da on da.id = t.debate_agent_id
       where t.debate_id = $1
         and t.turn_number = $2
       limit 1
    `,
    [debate.id, safeTurnNumber, 220]
  );
  if ((result.rowCount ?? 0) !== 1) {
    throw new AppError("NOT_FOUND", 404, "Turn not found");
  }
  const row = result.rows[0];
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

  try {
    const debateFiles = await query<{ path: string; updated_at: string | null }>(
      `
        select f.path, f.updated_at
          from debate_files f
         where f.debate_id = $1
         order by f.path asc
         limit 5000
      `,
      [debateId]
    );
    for (const row of debateFiles.rows) {
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
    const agentFiles = await query<{ debate_agent_id: string; turn_order: number | null; display_name: string | null; path: string; updated_at: string | null }>(
      `
        select da.id as debate_agent_id,
               da.turn_order as turn_order,
               da.display_name as display_name,
               f.path as path,
               f.updated_at as updated_at
          from debate_agent_files f
          join debate_agents da on da.id = f.debate_agent_id
         where da.debate_id = $1
         order by da.turn_order asc nulls last, da.display_name asc nulls last, f.path asc
         limit 20000
      `,
      [debateId]
    );
    for (const row of agentFiles.rows) {
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
    const result = await query<{ path: string }>(
      `
        select f.path
          from debate_files f
         where f.debate_id = $1
           and f.path like $2
         order by f.path asc
         limit 500
      `,
      [id, `${(prefix ?? "").trim()}%`]
    );
    return result.rows.map((row) => String(row.path));
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
    const result = await query<{ content: string; updated_at: string; version: number }>(
      `
        select f.content, f.updated_at, f.version
          from debate_files f
         where f.debate_id = $1
           and f.path = $2
         limit 1
      `,
      [id, path]
    );
    if ((result.rowCount ?? 0) !== 1) {
      throw new AppError("NOT_FOUND", 404, "File not found");
    }
    return {
      path,
      content: String(result.rows[0].content ?? ""),
      updatedAt: String(result.rows[0].updated_at ?? ""),
      version: Number(result.rows[0].version ?? 1) || 1
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
    const result = await query<{ path: string }>(
      `
        select f.path
          from debate_agent_files f
          join debate_agents da on da.id = f.debate_agent_id
         where da.debate_id = $1
           and f.debate_agent_id = $2
           and f.path like $3
         order by f.path asc
         limit 500
      `,
      [debateId, debateAgentId, `${(prefix ?? "").trim()}%`]
    );
    return result.rows.map((row) => String(row.path));
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
    const result = await query<{ content: string; updated_at: string }>(
      `
        select f.content, f.updated_at
          from debate_agent_files f
          join debate_agents da on da.id = f.debate_agent_id
         where da.debate_id = $1
           and f.debate_agent_id = $2
           and f.path = $3
         limit 1
      `,
      [debateId, debateAgentId, path]
    );
    if ((result.rowCount ?? 0) !== 1) {
      throw new AppError("NOT_FOUND", 404, "File not found");
    }
    return {
      path,
      content: String(result.rows[0].content ?? ""),
      updatedAt: String(result.rows[0].updated_at ?? "")
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
  const beforeId = typeof options?.beforeId === "string" && options.beforeId.trim() ? options.beforeId.trim() : null;

  try {
    const result = await query<{
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
    }>(
      `
        with cursor_row as (
          select created_at, id
            from debate_file_activity_logs
           where id = $4
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
        where l.debate_id = $1
          and (
            $2::text is null
            or ($2::text = 'write' and l.action = 'write' and (l.reason is null or l.reason not like 'summarizer:%'))
            or ($2::text = 'summarizer_write' and l.action = 'write' and l.reason like 'summarizer:%')
            or ($2::text = 'read' and l.action <> 'write')
          )
          and ($3::text is null or l.path = $3::text)
          and (
            $4::uuid is null
            or exists (
              select 1
                from cursor_row c
               where (l.created_at, l.id) < (c.created_at, c.id)
            )
          )
        order by l.created_at desc, l.id desc
        limit $5
      `,
      [debateId, action, path, beforeId, limit + 1]
    );

    const countsResult = await query<{ action: string; count: number }>(
      `
        select
          case
            when action = 'write' and reason like 'summarizer:%' then 'summarizer_write'
            when action = 'write' then 'write'
            else 'read'
          end as action,
          count(*)::int as count
          from debate_file_activity_logs
         where debate_id = $1
         group by
          case
            when action = 'write' and reason like 'summarizer:%' then 'summarizer_write'
            when action = 'write' then 'write'
            else 'read'
          end
      `,
      [debateId]
    );

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

export async function getDebateFileActivityDetail(debateId: string, entryId: string) {
  const session = await requireSessionUser();
  const { isOwner } = await getDebateForView(debateId, session.userId);
  if (!isOwner) {
    throw new AppError("NOT_FOUND", 404, "Debate not found");
  }

  try {
    const result = await query<{
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
    }>(
      `
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
        where l.debate_id = $1
          and l.id = $2
        limit 1
      `,
      [debateId, entryId]
    );
    if ((result.rowCount ?? 0) !== 1) {
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

  const debateRes = await query<{ status: string; current_turn: number; question: string }>(
    "select status, current_turn, question from debates where id = $1 and user_id = $2",
    [id, session.userId]
  );
  if ((debateRes.rowCount ?? 0) !== 1) {
    throw new AppError("NOT_FOUND", 404, "Debate not found");
  }

  const status = String(debateRes.rows[0].status ?? "");
  const currentTurn = Number(debateRes.rows[0].current_turn ?? 0);
  const question = String(debateRes.rows[0].question ?? "");
  if (status !== "paused") {
    throw new AppError("CONFLICT", 409, "Please pause the debate before starting a new segment");
  }

  const participants = await query<{ debate_agent_id: string; turn_order: number; display_name: string | null }>(
    `
      select da.id as debate_agent_id,
             da.turn_order,
             da.display_name as display_name
        from debate_agents da
       where da.debate_id = $1
       order by da.turn_order asc
    `,
    [id]
  );
  const participantCount = participants.rows.length;
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
    const workflowRes = await query<{ content: string }>(
      "select content from debate_files where debate_id = $1 and path = 'workflow.json' limit 1",
      [id]
    );
    const workflowRaw = (workflowRes.rowCount ?? 0) === 1 ? String(workflowRes.rows[0]?.content ?? "") : "";
    workflow = workflowRaw ? normalizeDebateWorkflow(JSON.parse(workflowRaw) as unknown) : null;
  } catch {
    workflow = null;
  }

  let directive = "";
  try {
    const directiveRes = await query<{ content: string }>(
      "select content from debate_files where debate_id = $1 and path = 'votes/decision.md' limit 1",
      [id]
    );
    directive = (directiveRes.rowCount ?? 0) === 1 ? String(directiveRes.rows[0]?.content ?? "") : "";
  } catch {
    directive = "";
  }

  const checkpointPrefix = "context/checkpoints/seg-";
  const existing = await query<{ path: string }>(
    "select path from debate_files where debate_id = $1 and path like $2 order by path asc limit 200",
    [id, `${checkpointPrefix}%`]
  );
  const nextIndex = (existing.rowCount ?? 0) + 1;
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
  for (const row of participants.rows) {
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
    await query(
      `
        insert into debate_files (debate_id, path, content, created_at, updated_at)
        values ($1, $2, $3, $4, $4)
        on conflict (debate_id, path)
        do update set content = excluded.content, updated_at = excluded.updated_at
      `,
      [id, "context/window.json", JSON.stringify({ enabled: true, minTurnNumber, at: now, seg, reason }, null, 2), now]
    );
    await query(
      `
        insert into debate_files (debate_id, path, content, created_at, updated_at)
        values ($1, $2, $3, $4, $4)
        on conflict (debate_id, path)
        do update set content = excluded.content, updated_at = excluded.updated_at
      `,
      [id, "context/segment.md", checkpointContent, now]
    );
    await query(
      `
        insert into debate_files (debate_id, path, content, created_at, updated_at)
        values ($1, $2, $3, $4, $4)
        on conflict (debate_id, path)
        do update set content = excluded.content, updated_at = excluded.updated_at
      `,
      [id, checkpointPath, checkpointContent, now]
    );
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

  const before = await query<{ status: string; current_turn: number }>(
    "select status, current_turn from debates where id = $1 and user_id = $2",
    [id, session.userId]
  );
  if ((before.rowCount ?? 0) !== 1) {
    throw new AppError("NOT_FOUND", 404, "Debate not found");
  }
  const beforeStatus = String(before.rows[0].status ?? "");
  const beforeTurn = Number(before.rows[0].current_turn ?? 0);

  const now = new Date().toISOString();
  const result = await query<Record<string, unknown>>(
    `update debates
        set status = 'running',
            started_at = coalesce(started_at, $3),
            runtime_notice_kind = null,
            runtime_notice_message = null,
            runtime_notice_at = null,
            updated_at = $3
      where id = $1 and user_id = $2 and status in ('pending','paused')
      returning *`,
    [id, session.userId, now]
  );
  if ((result.rowCount ?? 0) !== 1) {
    throw new AppError("CONFLICT", 409, "Debate cannot be started");
  }

  // Safety: older versions could accidentally seed memory/* into a brand-new debate (via strategy role files).
  // Ensure a new debate starts with a fresh context.
  if (beforeStatus === "pending" && beforeTurn === 0) {
    await query(
      `
        delete from debate_agent_files f
        using debate_agents da
        where f.debate_agent_id = da.id
          and da.debate_id = $1
          and lower(replace(f.path, '\\\\', '/')) like 'memory/%'
      `,
      [id]
    );

    // Also clean any other debate-internal files that should never be seeded from strategy role files.
    await query(
      `
        delete from debate_agent_files f
        using debate_agents da
        where f.debate_agent_id = da.id
          and da.debate_id = $1
          and (
            lower(replace(f.path, '\\\\', '/')) like 'debate/%'
            or lower(replace(f.path, '\\\\', '/')) like 'context/%'
            or lower(replace(f.path, '\\\\', '/')) like 'facts/%'
            or lower(replace(f.path, '\\\\', '/')) like 'votes/%'
            or lower(replace(f.path, '\\\\', '/')) like 'question/%'
          )
      `,
      [id]
    );

    await query("delete from debate_files where debate_id = $1 and path = $2", [id, "facts/board.md"]);
    await query(
      `
        delete from debate_files
         where debate_id = $1
           and (
             lower(replace(path, '\\\\', '/')) like 'context/%'
             or lower(replace(path, '\\\\', '/')) like 'facts/%'
             or lower(replace(path, '\\\\', '/')) like 'votes/%'
             or lower(replace(path, '\\\\', '/')) like 'question/%'
           )
      `,
      [id]
    );
  }

  void runDebate(id, session.userId);
  return toListItem(normalizeDebateRow(result.rows[0]));
}

export async function pauseDebate(id: string) {
  const session = await requireSessionUser();
  const result = await query<Record<string, unknown>>(
    `update debates
        set status = 'paused',
            updated_at = $3
      where id = $1 and user_id = $2 and status = 'running'
      returning *`,
    [id, session.userId, new Date().toISOString()]
  );
  if ((result.rowCount ?? 0) !== 1) {
    throw new AppError("CONFLICT", 409, "Only running debates can be paused");
  }
  return toListItem(normalizeDebateRow(result.rows[0]));
}

export async function resumeDebate(id: string) {
  const session = await requireSessionUser();
  const result = await query<Record<string, unknown>>(
    `update debates
        set status = 'running',
            runtime_notice_kind = null,
            runtime_notice_message = null,
            runtime_notice_at = null,
            updated_at = $3
      where id = $1 and user_id = $2 and status = 'paused'
      returning *`,
    [id, session.userId, new Date().toISOString()]
  );
  if ((result.rowCount ?? 0) !== 1) {
    throw new AppError("CONFLICT", 409, "Only paused debates can be resumed");
  }
  void runDebate(id, session.userId);
  return toListItem(normalizeDebateRow(result.rows[0]));
}

export async function repairDebate(id: string) {
  const session = await requireSessionUser();
  const now = new Date().toISOString();
  const result = await query<Record<string, unknown>>(
    `update debates
        set status = 'paused',
            finished_at = null,
            stopped_reason = null,
            runtime_notice_kind = 'interrupted',
            runtime_notice_message = $3,
            runtime_notice_at = $4,
            updated_at = $4
      where id = $1 and user_id = $2 and status = 'failed'
      returning *`,
    [id, session.userId, "该辩论已从 failed 修复为 paused；请确认状态后手动恢复运行", now]
  );
  if ((result.rowCount ?? 0) !== 1) {
    throw new AppError("CONFLICT", 409, "Only failed debates can be repaired");
  }
  return toListItem(normalizeDebateRow(result.rows[0]));
}

export async function stopDebate(id: string, reason: string) {
  const session = await requireSessionUser();
  const now = new Date().toISOString();
  const result = await query<Record<string, unknown>>(
    `update debates
        set status = 'stopped',
            stopped_reason = $3,
            finished_at = $4,
            updated_at = $4
      where id = $1 and user_id = $2 and status in ('pending','running','paused')
      returning *`,
    [id, session.userId, reason, now]
  );
  if ((result.rowCount ?? 0) !== 1) {
    throw new AppError("CONFLICT", 409, "Debate is already finished");
  }
  return toListItem(normalizeDebateRow(result.rows[0]));
}

export async function appendAgentToDebate(id: string, agentId: string) {
  const { session, debate } = await getDebate(id);
  if (!["running", "paused"].includes(debate.status)) {
    throw new AppError("CONFLICT", 409, "Only running/paused debates can add new agents");
  }

  const agent = await query<{ id: string }>(
    "select id from ai_agents where user_id = $1 and deleted_at is null and id = $2",
    [session.userId, agentId]
  );
  if ((agent.rowCount ?? 0) !== 1) {
    throw new AppError("NOT_FOUND", 404, "Agent not found");
  }

  const maxOrderResult = await query<{ max: number }>(
    "select coalesce(max(turn_order), 0)::int as max from debate_agents where debate_id = $1",
    [debate.id]
  );
  const maxOrder = maxOrderResult.rows[0]?.max ?? 0;
  const existingDisplayNames = await query<{ display_name: string | null }>(
    "select display_name from debate_agents where debate_id = $1",
    [debate.id]
  );
  const usedDisplayNames = new Set(
    existingDisplayNames.rows.map((row) => (row.display_name ? String(row.display_name) : "")).filter(Boolean)
  );
  const now = new Date().toISOString();

  await query(
    `insert into debate_agents (debate_id, ai_agent_id, display_name, turn_order, turn_count, created_at)
     values ($1,$2,$3,$4,0,$5)`,
    [debate.id, agentId, createUniqueDisplayName(usedDisplayNames), maxOrder + 1, now]
  );

  await query("update debates set updated_at = $2 where id = $1", [debate.id, now]);

  return getDebateDetail(debate.id);
}
