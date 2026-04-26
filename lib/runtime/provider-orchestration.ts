import { decryptSecret } from "@/lib/crypto";
import { ensureDb } from "@/lib/db";
import { getDebateParticipantRoleType, loadDebateParticipantRoleTypes, type DebateParticipantRoleType } from "@/lib/debate-role-types";
import { emitDebateLiveEvent, setDebateLiveProgress } from "@/lib/debate-live";
import { AppError } from "@/lib/http";
import { ensureQuotaReservationOrDelay, type QuotaReservationInput } from "@/lib/quota-control";
import { retrieveRelevantHistory } from "@/lib/retrieval";
import { PROMPT_HARD_MAX_CHARS_ANTHROPIC } from "@/lib/runtime/constants";
import {
  buildContextAccessSummaryLines,
  buildRelevantHistoryInline,
  getPromptHardMaxChars,
  hasContextAccessRules,
  isContextPathReadable,
  planPromptContext
} from "@/lib/runtime/context-inline";
import {
  loadLatestVote,
  loadOfficialDecisionInline,
  loadOpenVote,
  loadOpenVoteInline,
  loadQuestionDiffInline,
  loadVoteAnnouncementInline
} from "@/lib/runtime/tools";
import {
  openAiChatOnce,
  openAiChatStream,
  openAiUsageProbe,
  resolveChatUrl
} from "@/lib/runtime/provider-openai";
import {
  buildBaseSystemPrompt,
  buildResponseFormatInstructions,
  clipMessagesToInputLimit,
  describeRuntimeError,
  emitChunks,
  estimatePromptTokensFromChars,
  logRuntimeEvent,
  looksLikeToolsUnsupported,
  summarizeOptionText
} from "@/lib/runtime/provider-shared";
import {
  buildRuntimeActionInstructions,
  buildRuntimeActionWorkingSetInline,
  classifyPhase2LedgerTarget,
  detectRuntimeActionLoop,
  executeRuntimeHarnessAction,
  hasWorkingSetReadForPath,
  loadRuntimeSeatWorkingSet,
  makeRuntimeActionLoopRecord,
  mergeRuntimeSharedFilesIntoWorkingSet,
  parseRuntimeHarnessAction,
  pushRuntimeActionLoopRecord,
  rollbackRuntimeTurnMutationsByIds,
  resolveRuntimeActionPolicy,
  type RuntimeHarnessAction,
  type RuntimeActionLoopState,
  type Phase2LedgerState,
  type RuntimeSeatWorkingSet
} from "@/lib/runtime/runtime-action-harness";
import {
  getWorkflowOutputMaxTokens,
  isOfficialVotingAllowed,
  listMissingRequiredDeliverables,
  loadDebateWorkflow,
  resolveCurrentWorkflowPhase,
  resolveRequestedMaxTokens,
  withOptionalMaxTokens
} from "@/lib/runtime/workflow-phase";
import type { AgentRecord, DebateRecord } from "@/lib/types";
import type { WorkflowPhaseKind } from "@/lib/workflow";
import {
  buildWorkflowPhaseInline,
  formatRecentTurnsInline,
  loadContextAccessAutoReadInline,
  loadContextWindowMinTurnNumberForDebateAgent,
  loadDebateAgentFilesInline,
  loadDebateAgentMemoryInline,
  loadDebateAgentSegmentInline,
  loadDebateAgentSystemPrompt,
  loadDebateParticipantsInline,
  loadDebateSeatInline,
  loadRecentTurnRows,
  loadSharedFactsBoardInline,
  loadWorkflowIdeaBankInline,
  recordImplicitFileReads,
  resolveDebateIdeaBankPaths,
  type DebateFileActivityAudit
} from "@/lib/runtime-main";

const OPENAI_COMPAT_MAX_INPUT_CHARS = 180_000;

async function getWorkflowAllowedOutputPaths(input: {
  workflow: Awaited<ReturnType<typeof loadDebateWorkflow>>;
  userId: string;
  debateId: string;
}) {
  const { workflow } = input;
  const paths = new Set(workflow?.deliverables.allowedPaths ?? ["final/", "outputs/"]);
  const ideaBank = await resolveDebateIdeaBankPaths({
    workflow,
    userId: input.userId,
    debateId: input.debateId
  });
  for (const path of Object.values(ideaBank.derivedFiles)) {
    if (path) paths.add(path);
  }
  return Array.from(paths);
}

async function getWorkflowPhasePreferredWritablePaths(input: {
  workflow: Awaited<ReturnType<typeof loadDebateWorkflow>>;
  userId: string;
  debateId: string;
  currentPhaseKind: WorkflowPhaseKind | null;
}) {
  if (!input.workflow?.enabled || !input.currentPhaseKind) return [] as string[];
  const ideaBank = await resolveDebateIdeaBankPaths({
    workflow: input.workflow,
    userId: input.userId,
    debateId: input.debateId
  });
  const derived = ideaBank.derivedFiles;
  if (input.currentPhaseKind === "deliberation") {
    return [
      derived.currentBattlefieldPath,
      derived.selectedSTierPath,
      derived.eventMappingsPath,
      derived.selectedATierPath,
      derived.rejectedOrMergedPath,
      derived.newlyInventedIdeasPath
    ].filter((item): item is string => Boolean(item));
  }
  if (input.currentPhaseKind === "finalization_vote" || input.currentPhaseKind === "finalization") {
    return [derived.currentBattlefieldPath, derived.selectedSTierPath, derived.eventMappingsPath, derived.selectedATierPath].filter(
      (item): item is string => Boolean(item)
    );
  }
  return [] as string[];
}

async function getWorkflowReadableSharedPaths(input: {
  workflow: Awaited<ReturnType<typeof loadDebateWorkflow>>;
  userId: string;
  debateId: string;
  currentPhaseKind: WorkflowPhaseKind | null;
  allowedOutputPaths: string[];
}) {
  const paths = new Set(input.allowedOutputPaths.map((item) => normalizeRuntimePath(item)).filter(Boolean));
  const db = await ensureDb();
  const rows = await db
    .selectFrom("debate_files as f")
    .innerJoin("debates as d", "d.id", "f.debate_id")
    .select(["f.path"])
    .where("f.debate_id", "=", input.debateId)
    .where("d.user_id", "=", input.userId)
    .orderBy("f.path", "asc")
    .execute();
  for (const row of rows) {
    const path = normalizeRuntimePath(String(row.path ?? ""));
    if (!path) continue;
    if (isContextPathReadable(input.workflow, input.currentPhaseKind, "shared", path)) {
      paths.add(path);
    }
  }
  return Array.from(paths);
}

type RuntimePromptSharedFile = {
  path: string;
  content: string;
  version: number | null;
  updatedAt: string | null;
};

function normalizeRuntimePath(path: string | null | undefined) {
  return String(path ?? "").replace(/\\/g, "/").replace(/^\/+/, "").trim();
}

function formatRuntimeTimestamp(value: unknown) {
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  return null;
}

function isRuntimeWritableSharedPath(input: {
  path: string;
  workflow: Awaited<ReturnType<typeof loadDebateWorkflow>>;
}) {
  const normalized = normalizeRuntimePath(input.path);
  if (!normalized.startsWith("debate/")) return false;
  if (normalized.startsWith("debate/answers/")) return false;
  if (normalized.startsWith("debate/turn_summaries/")) return false;
  if (normalized.startsWith("debate/round_summaries/")) return false;
  if (normalized.split("/").pop() === "raw-idea-bank.md") return false;
  const configuredRawIdeaBankPath = normalizeRuntimePath(input.workflow?.ideaBank.rawIdeaBankPath ?? null);
  if (configuredRawIdeaBankPath && normalized === configuredRawIdeaBankPath) return false;
  return true;
}

function buildRuntimeAllowedOutputPaths(input: {
  baseAllowedOutputPaths: string[];
  workingSet: RuntimeSeatWorkingSet;
  workflow: Awaited<ReturnType<typeof loadDebateWorkflow>>;
}) {
  const paths = new Set(input.baseAllowedOutputPaths.map((item) => normalizeRuntimePath(item)));
  for (const ref of [
    ...input.workingSet.recentlyWrittenFiles,
    ...input.workingSet.canonicalSourceFiles,
    ...input.workingSet.recentlyReadFiles
  ]) {
    if (ref.source !== "shared") continue;
    if (!isRuntimeWritableSharedPath({ path: ref.path, workflow: input.workflow })) continue;
    paths.add(normalizeRuntimePath(ref.path));
  }
  return Array.from(paths).filter(Boolean);
}

function buildRuntimeReadableSharedPaths(input: {
  baseReadableSharedPaths: string[];
  workingSet: RuntimeSeatWorkingSet;
}) {
  const paths = new Set(input.baseReadableSharedPaths.map((item) => normalizeRuntimePath(item)).filter(Boolean));
  for (const ref of [
    ...input.workingSet.recentlyWrittenFiles,
    ...input.workingSet.canonicalSourceFiles,
    ...input.workingSet.recentlyReadFiles
  ]) {
    if (ref.source !== "shared") continue;
    paths.add(normalizeRuntimePath(ref.path));
  }
  return Array.from(paths).filter(Boolean);
}

type ProviderUsageSummary = {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
} | null;

type ProviderExecutionResult = {
  raw: string;
  usage: ProviderUsageSummary;
  promptChars: number;
  estimatedPromptTokens: number | null;
  mutationJournalIds: string[];
  diagnostics: {
    provider: string;
    model: string;
    requestedMaxTokens: number;
    finishReason: string | null;
    toolCallsCount: number;
  };
};

type ProviderCallInput = {
  debate: DebateRecord;
  agent: AgentRecord;
  messageNumber: number;
  roundNumber: number;
  participantCount: number;
  userId: string;
  debateAgentId: string;
  eventAgentName: string;
  baseRoleName: string;
};

type ProviderPromptContext = ProviderCallInput & {
  apiKey: string;
  url: string;
  workflow: Awaited<ReturnType<typeof loadDebateWorkflow>>;
  openVote: Awaited<ReturnType<typeof loadOpenVote>>;
  latestVote: Awaited<ReturnType<typeof loadLatestVote>>;
  currentPhase: ReturnType<typeof resolveCurrentWorkflowPhase>;
  currentRoleType: DebateParticipantRoleType;
  requestedMaxTokens: number;
  currentOutputMaxTokens: number | null;
  enableVotingTools: boolean;
  allowedOutputPaths: string[];
  readableSharedPaths: string[];
  requiredDeliverables: NonNullable<Awaited<ReturnType<typeof loadDebateWorkflow>>>["deliverables"]["requiredFiles"] | [];
  pendingDeliverables: Awaited<ReturnType<typeof listMissingRequiredDeliverables>>;
  phasePreferredWritablePaths: string[];
  contextAccessLines: string[];
  prompt: string;
  implicitReadAudit: DebateFileActivityAudit;
};

type ProviderTextAssertionContext = {
  provider: string;
  model: string;
  stage: string;
  finishReason?: string | null;
  toolCallsCount?: number;
};

function buildDebateQuotaRequest(context: ProviderPromptContext): QuotaReservationInput {
  return {
    userId: context.userId,
    usageControlMode: context.agent.usageControlMode,
    quotaProfileId: context.agent.quotaProfileId,
    requestKind: "debate_runtime",
    agentId: context.agent.id,
    agentName: context.agent.name,
    debateId: context.debate.id,
    debateAgentId: context.debateAgentId
  };
}

export function assertProviderApiKeyEnabled(apiKey: string) {
  if (apiKey.startsWith("demo-")) {
    throw new AppError("AI_DEMO_KEY_DISABLED", 400, "Demo API keys are disabled for runtime generation.");
  }
}

export function assertNonEmptyProviderText(
  text: string | null | undefined,
  context: ProviderTextAssertionContext
) {
  const normalized = String(text ?? "").trim();
  if (normalized) return normalized;
  const finishReason = context.finishReason?.trim() ? ` finish_reason=${context.finishReason}.` : "";
  const toolCallsCount =
    typeof context.toolCallsCount === "number" && Number.isFinite(context.toolCallsCount)
      ? ` tool_calls=${context.toolCallsCount}.`
      : "";
  throw new AppError(
    "AI_EMPTY_RESPONSE",
    502,
    `Provider returned empty content during ${context.stage}. provider=${context.provider} model=${context.model}.${finishReason}${toolCallsCount}`.trim()
  );
}

function createLiveStageUpdater(input: ProviderCallInput) {
  return (stage: "calling_model" | "running_tools" | "parsing" | "saving", message: string) => {
    setDebateLiveProgress({
      debateId: input.debate.id,
      roundNumber: input.roundNumber,
      messageNumber: input.messageNumber,
      debateAgentId: input.debateAgentId,
      aiAgentId: input.agent.id,
      agentName: input.eventAgentName,
      baseRoleName: input.baseRoleName,
      stage
    });
    emitDebateLiveEvent(input.debate.id, {
      type: "status",
      debateId: input.debate.id,
      message,
      at: new Date().toISOString()
    });
  };
}

function normalizeOpenAiUsage(usage: unknown): ProviderUsageSummary {
  if (!usage || typeof usage !== "object") return null;
  const objectUsage = usage as Record<string, unknown>;
  const promptTokens = typeof objectUsage.prompt_tokens === "number" ? objectUsage.prompt_tokens : null;
  const completionTokens = typeof objectUsage.completion_tokens === "number" ? objectUsage.completion_tokens : null;
  const totalTokens = typeof objectUsage.total_tokens === "number" ? objectUsage.total_tokens : null;
  if (promptTokens === null && completionTokens === null && totalTokens === null) return null;
  return { promptTokens, completionTokens, totalTokens };
}

function normalizeAnthropicUsage(usage: unknown): ProviderUsageSummary {
  if (!usage || typeof usage !== "object") return null;
  const objectUsage = usage as Record<string, unknown>;
  const promptTokens = typeof objectUsage.input_tokens === "number" ? objectUsage.input_tokens : null;
  const completionTokens = typeof objectUsage.output_tokens === "number" ? objectUsage.output_tokens : null;
  const totalTokens =
    typeof promptTokens === "number" && typeof completionTokens === "number" ? promptTokens + completionTokens : null;
  if (promptTokens === null && completionTokens === null && totalTokens === null) return null;
  return { promptTokens, completionTokens, totalTokens };
}

async function buildProviderPromptContext(input: ProviderCallInput): Promise<ProviderPromptContext> {
  const updateLiveStage = createLiveStageUpdater(input);
  updateLiveStage("calling_model", `整理上下文：${input.eventAgentName}`);

  const apiKey = decryptSecret(input.agent.apiKeyEncrypted);
  const promptHardMaxChars = getPromptHardMaxChars(input.agent);
  const recentTurnMin = await loadContextWindowMinTurnNumberForDebateAgent(input.userId, input.debate.id, input.debateAgentId);
  const recentTurnLimit = Math.max(
    Math.max(1, input.participantCount),
    Math.min(8, Math.max(4, Math.max(1, input.participantCount)))
  );
  const recentTurnRows = await loadRecentTurnRows(
    input.userId,
    input.debate.id,
    input.participantCount,
    recentTurnLimit,
    recentTurnMin
  );
  const recentTurnsInline = formatRecentTurnsInline(recentTurnRows, input.participantCount, recentTurnMin);
  const seatInline = await loadDebateSeatInline(input.userId, input.debate.id, input.debateAgentId);
  const participantsInline =
    input.messageNumber <= input.participantCount ? null : await loadDebateParticipantsInline(input.userId, input.debate.id);
  const workflow = await loadDebateWorkflow(input.userId, input.debate.id);
  const allowedOutputPaths = await getWorkflowAllowedOutputPaths({
    workflow,
    userId: input.userId,
    debateId: input.debate.id
  });
  const requiredDeliverables = workflow?.deliverables.requiredFiles ?? [];
  const pendingDeliverables = await listMissingRequiredDeliverables({
    userId: input.userId,
    debateId: input.debate.id,
    workflow
  });
  const roleAssignments = await loadDebateParticipantRoleTypes(input.userId, input.debate.id);
  const currentRoleType = getDebateParticipantRoleType(roleAssignments, input.debateAgentId);

  updateLiveStage("calling_model", `读取规则与记忆：${input.eventAgentName}`);
  const openVote = await loadOpenVote(input.userId, input.debate.id);
  const latestVote = await loadLatestVote(input.userId, input.debate.id);
  const currentPhase = resolveCurrentWorkflowPhase({
    workflow,
    roundNumber: input.roundNumber,
    openVote,
    latestVote,
    persistedPhaseKind: input.debate.workflowPhaseKind
  });
  const readableSharedPaths = await getWorkflowReadableSharedPaths({
    workflow,
    userId: input.userId,
    debateId: input.debate.id,
    currentPhaseKind: currentPhase?.kind ?? null,
    allowedOutputPaths
  });
  const phasePreferredWritablePaths = await getWorkflowPhasePreferredWritablePaths({
    workflow,
    userId: input.userId,
    debateId: input.debate.id,
    currentPhaseKind: currentPhase?.kind ?? null
  });
  const currentOutputMaxTokens = getWorkflowOutputMaxTokens(workflow, currentPhase?.kind ?? null, input.agent.maxOutputTokens);
  const contextAccessLines = buildContextAccessSummaryLines({
    workflow,
    currentPhaseKind: currentPhase?.kind ?? null
  });
  const requestedMaxTokens = resolveRequestedMaxTokens(currentOutputMaxTokens, input.agent.provider);
  const workflowPhaseInline = buildWorkflowPhaseInline({
    workflow,
    debate: input.debate,
    roundNumber: input.roundNumber,
    openVote,
    latestVote
  });
  const workflowIdeaBankInline = await loadWorkflowIdeaBankInline({
    workflow,
    phaseKind: currentPhase?.kind ?? null,
    userId: input.userId,
    debateId: input.debate.id
  });
  const openVoteInline = await loadOpenVoteInline(input.userId, input.debate.id, `${input.debateAgentId}:${openVote?.roundNumber ?? 0}`);
  const directiveInline = await loadOfficialDecisionInline(input.userId, input.debate.id);
  const announcementInline = await loadVoteAnnouncementInline(input.userId, input.debate.id);
  const questionDiffInline = await loadQuestionDiffInline(input.userId, input.debate.id);
  const implicitReadAudit: DebateFileActivityAudit = {
    debateId: input.debate.id,
    debateAgentId: input.debateAgentId,
    turnNumber: input.messageNumber,
    roundNumber: input.roundNumber,
    now: new Date().toISOString()
  };
  const segmentInline = await loadDebateAgentSegmentInline(
    input.userId,
    input.debate.id,
    input.debateAgentId,
    12_000,
    implicitReadAudit
  );
  const turnInRound = ((input.messageNumber - 1) % Math.max(1, input.participantCount)) + 1;
  const roundStart = (input.roundNumber - 1) * Math.max(1, input.participantCount) + 1;
  const roundEnd = input.roundNumber * Math.max(1, input.participantCount);
  const enableVotingTools = Boolean(openVoteInline) || isOfficialVotingAllowed(workflow, input.roundNumber);
  const votingRuleInline = workflow?.enabled
    ? "- Official voting: enabled by workflow.json for consolidation/custom decisions when needed."
    : null;
  const alreadyVoted =
    openVote && openVote.status === "open"
      ? Boolean((openVote.ballots ?? []).some((ballot) => (ballot as { debateAgentId?: unknown }).debateAgentId === input.debateAgentId))
      : false;
  const votingActionInline =
    openVote && openVote.status === "open" && !alreadyVoted
      ? [
          "VOTING REQUIRED: An official vote is open and you haven't voted yet.",
          '- First: emit one harness debate-action block like { "action": "vote_cast", "choice": "<one option exactly>", "reason": "optional" }.',
          "- Then: you may add a short message (1-3 sentences)."
        ].join("\n")
      : null;

  let relevantHistoryInline: string | null = null;
  try {
    const retrievalQuery = [
      input.debate.question,
      questionDiffInline ? summarizeOptionText(questionDiffInline, 1_200) : "",
      currentPhase?.title ?? "",
      currentPhase?.description ?? "",
      openVote?.title ?? "",
      directiveInline ? summarizeOptionText(directiveInline, 800) : "",
      seatInline ? summarizeOptionText(seatInline, 400) : "",
      summarizeOptionText(recentTurnsInline ?? "", 1_500)
    ]
      .filter(Boolean)
      .join("\n\n");
    const retrieved = await retrieveRelevantHistory({
      userId: input.userId,
      debateId: input.debate.id,
      queryText: retrievalQuery,
      limit: 6,
      minTurnNumber: await loadContextWindowMinTurnNumberForDebateAgent(input.userId, input.debate.id, input.debateAgentId),
      maxChars: 12_000
    });
    const gatedRetrieved = retrieved.filter((item) => {
      if (!hasContextAccessRules(workflow)) return true;
      if (!item.sourcePath) return true;
      if (item.sourceType === "deliverable_file" || item.sourceType === "shared_file" || item.sourceType === "idea_bank_file") {
        return isContextPathReadable(workflow, currentPhase?.kind ?? null, "shared", item.sourcePath);
      }
      if (item.sourceType === "agent_file") {
        return isContextPathReadable(workflow, currentPhase?.kind ?? null, "seat", item.sourcePath);
      }
      return true;
    });
    await recordImplicitFileReads({
      audit: implicitReadAudit,
      scope: "debate",
      paths: gatedRetrieved
        .filter((item) => Boolean(item.sourcePath))
        .filter((item) => item.sourceType !== "agent_file")
        .map((item) => String(item.sourcePath ?? ""))
    });
    await recordImplicitFileReads({
      audit: implicitReadAudit,
      scope: "agent",
      paths: gatedRetrieved.filter((item) => item.sourceType === "agent_file").map((item) => String(item.sourcePath ?? "")),
      targetDebateAgentId: input.debateAgentId
    });
    relevantHistoryInline = buildRelevantHistoryInline(gatedRetrieved);
  } catch (error) {
    await logRuntimeEvent("warn", "retrieval history failed", {
      debateId: input.debate.id,
      error: describeRuntimeError(error)
    });
    relevantHistoryInline = null;
  }

  updateLiveStage("calling_model", `组装提示词：${input.eventAgentName}`);
  const prompt = planPromptContext(
    [
      { key: "question", priority: 0, category: "core", preferredMaxChars: 24_000, content: `Question:\n${input.debate.question}` },
      { key: "questionDiff", priority: 0, category: "core", preferredMaxChars: 8_000, content: questionDiffInline },
      { key: "seat", priority: 0, category: "core", preferredMaxChars: 3_000, content: seatInline },
      {
        key: "roundSemantics",
        priority: 0,
        category: "core",
        preferredMaxChars: 2_500,
        content: [
          "Round semantics (IMPORTANT):",
          `- Seats: ${input.participantCount}`,
          `- 1 round = ${input.participantCount} messages (each seat speaks once in order).`,
          `- You are generating: Round ${input.roundNumber} · Turn ${turnInRound}/${input.participantCount} (global message #${input.messageNumber}).`,
          `- Round ${input.roundNumber} covers message #${roundStart} ~ #${roundEnd}.`,
          "- IMPORTANT: Do NOT treat global message # as a seat index."
        ].join("\n")
      },
      { key: "workflowPhase", priority: 0, category: "core", preferredMaxChars: 14_000, content: workflowPhaseInline },
      {
        key: "contextAccess",
        priority: 0,
        category: "core",
        preferredMaxChars: 4_000,
        content: contextAccessLines.length > 0 ? contextAccessLines.join("\n") : null
      },
      { key: "workflowIdeaBank", priority: 2, category: "optional", preferredMaxChars: 8_000, content: workflowIdeaBankInline },
      { key: "votingRule", priority: 0, category: "core", preferredMaxChars: 1_500, content: votingRuleInline },
      {
        key: "round1GroundRule",
        priority: 0,
        category: "core",
        preferredMaxChars: 1_200,
        content:
          input.messageNumber <= input.participantCount
            ? "Fairness (Round 1): You do not yet have full information about other seats. Do not pre-judge or claim you know other seats' views/roles before they speak."
            : null
      },
      { key: "participants", priority: 2, category: "optional", preferredMaxChars: 3_000, content: participantsInline },
      { key: "segment", priority: 0, category: "core", preferredMaxChars: 10_000, content: segmentInline },
      { key: "directive", priority: 0, category: "core", preferredMaxChars: 8_000, content: directiveInline },
      { key: "announcement", priority: 1, category: "optional", preferredMaxChars: 4_000, content: announcementInline },
      { key: "votingAction", priority: 0, category: "core", preferredMaxChars: 1_500, content: votingActionInline },
      { key: "openVote", priority: 0, category: "core", preferredMaxChars: 12_000, content: openVoteInline },
      { key: "relevantHistory", priority: 0, category: "retrieved", preferredMaxChars: 12_000, content: relevantHistoryInline },
      { key: "recentTurns", priority: 0, category: "recent", preferredMaxChars: 6_000, content: recentTurnsInline },
      {
        key: "responseRules",
        priority: 0,
        category: "core",
        preferredMaxChars: 700,
        content: [
          "Please respond in Markdown for humans. You may use headings, lists, and code blocks when helpful.",
          "Do not output a raw JSON object. If you were about to output JSON, convert it to readable Markdown instead."
        ].join("\n")
      }
    ],
    Math.max(24_000, promptHardMaxChars - 28_000)
  );

  return {
    ...input,
    apiKey,
    url: resolveChatUrl(input.agent),
    workflow,
    openVote,
    latestVote,
    currentPhase,
    currentRoleType,
    requestedMaxTokens,
    currentOutputMaxTokens,
    enableVotingTools,
    allowedOutputPaths,
    readableSharedPaths,
    requiredDeliverables,
    pendingDeliverables,
    phasePreferredWritablePaths,
    contextAccessLines,
    prompt,
    implicitReadAudit
  };
}

async function loadPromptVisibleSharedFilesForTurn(context: ProviderPromptContext): Promise<RuntimePromptSharedFile[]> {
  const db = await ensureDb();
  const rows = await db
    .selectFrom("debate_file_activity_logs as log")
    .innerJoin("debates as d", "d.id", "log.debate_id")
    .innerJoin("debate_files as f", (join) => join.onRef("f.debate_id", "=", "log.debate_id").onRef("f.path", "=", "log.path"))
    .select(["log.path", "f.content", "f.version", "f.updated_at"])
    .where("log.debate_id", "=", context.debate.id)
    .where("d.user_id", "=", context.userId)
    .where("log.debate_agent_id", "=", context.debateAgentId)
    .where("log.turn_number", "=", context.messageNumber)
    .where("log.round_number", "=", context.roundNumber)
    .where("log.scope", "=", "debate")
    .where("log.action", "=", "read")
    .orderBy("log.created_at", "asc")
    .execute();
  const seen = new Set<string>();
  const result: RuntimePromptSharedFile[] = [];
  for (const row of rows) {
    const path = normalizeRuntimePath(row.path);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    result.push({
      path,
      content: String(row.content ?? ""),
      version: typeof row.version === "number" && Number.isFinite(row.version) ? Math.floor(row.version) : null,
      updatedAt: formatRuntimeTimestamp(row.updated_at)
    });
  }
  return result;
}

async function loadSharedSystemPromptParts(context: ProviderPromptContext) {
  const systemParts: string[] = [];
  const agentFilesInline = await loadDebateAgentFilesInline(
    context.userId,
    context.debateAgentId,
    context.agent.id,
    18_000,
    context.implicitReadAudit
  );
  if (agentFilesInline) systemParts.push(agentFilesInline);
  if (hasContextAccessRules(context.workflow)) {
    const contextAutoReadInline = await loadContextAccessAutoReadInline({
      userId: context.userId,
      debateId: context.debate.id,
      debateAgentId: context.debateAgentId,
      agentId: context.agent.id,
      workflow: context.workflow,
      currentPhaseKind: context.currentPhase?.kind ?? null,
      audit: context.implicitReadAudit
    });
    if (contextAutoReadInline) systemParts.push(contextAutoReadInline);
  }
  if (context.messageNumber > context.participantCount) {
    const memoryInline = await loadDebateAgentMemoryInline(context.userId, context.debateAgentId, 10_000, context.implicitReadAudit);
    if (memoryInline) systemParts.push(memoryInline);
    if (context.debate.enableSharedFacts) {
      const sharedInline = await loadSharedFactsBoardInline(context.userId, context.debate.id, 10_000, context.implicitReadAudit);
      if (sharedInline) systemParts.push(sharedInline);
    }
  }
  return systemParts;
}

function buildHarnessAuthorityInline() {
  return [
    "Harness authority (IMPORTANT):",
    "- Only the latest HARNESS_ACTION_RESULT is the source of truth for file state.",
    "- Do not claim a file was created or updated unless that result confirmed ok:true for the exact path.",
    "- If a harness write returns an error, treat the target file as unchanged and either retry with a new allowed action or explicitly say it was not written."
  ].join("\n");
}

function buildSharedSystemInline(input: {
  context: ProviderPromptContext;
  overrideSystemPrompt: string | null;
  workingSet: RuntimeSeatWorkingSet;
  actionPolicy: ReturnType<typeof resolveRuntimeActionPolicy>;
  allowedOutputPaths: string[];
  sharedPromptParts: string[];
}) {
  const systemParts = [
    buildBaseSystemPrompt(input.context.agent, input.overrideSystemPrompt),
    buildRuntimeActionInstructions({
      policy: input.actionPolicy,
      allowedOutputPaths: input.allowedOutputPaths
    })
  ];
  const workingSetInline = buildRuntimeActionWorkingSetInline(input.workingSet);
  if (workingSetInline) systemParts.push(workingSetInline);
  systemParts.push(buildHarnessAuthorityInline());
  systemParts.push(...input.sharedPromptParts);
  systemParts.push(buildResponseFormatInstructions());
  return systemParts.join("\n\n");
}

type RuntimeHarnessRecoveryAction = "read" | "write_replace";

type RuntimeHarnessRecoveryHint = {
  targetPath: string;
  nextAction: RuntimeHarnessRecoveryAction;
  failureCount: number;
  suppressWriteSection: boolean;
  error: string;
  existingHeading: string | null;
};

type RuntimeHarnessRecoveryState = {
  byPath: Record<string, RuntimeHarnessRecoveryHint>;
};

function normalizeRecoveryTargetPath(path: string | null | undefined) {
  return normalizeRuntimePath(path);
}

function getHarnessErrorText(result: unknown) {
  if (!result || typeof result !== "object" || !("error" in result)) return null;
  return typeof (result as { error?: unknown }).error === "string" ? String((result as { error?: unknown }).error) : null;
}

function extractSectionMergeHeading(error: string) {
  const match = error.match(/matching "([^"]+)"/i);
  return match ? match[1] : null;
}

function isHarnessRecoveryError(error: string) {
  return /section_merge content must start with a Markdown heading matching/i.test(error)
    || /TARGET_HEADING_NOT_FOUND/i.test(error)
    || /TARGET_FILE_NOT_FOUND/i.test(error);
}

function nextRecoveryActionForLedgerState(state: Phase2LedgerState, hasRead: boolean): RuntimeHarnessRecoveryAction {
  if (state === "missing" || state === "template_or_placeholder") return "write_replace";
  return hasRead ? "read" : "read";
}

function buildRecoveryPolicyOverrides(state: RuntimeHarnessRecoveryState) {
  const hints = Object.values(state.byPath);
  return {
    forcedReadPaths: hints.filter((item) => item.nextAction === "read").map((item) => item.targetPath),
    forcedReplacePaths: hints.filter((item) => item.nextAction === "write_replace").map((item) => item.targetPath),
    suppressedWriteSectionPaths: hints.filter((item) => item.suppressWriteSection).map((item) => item.targetPath)
  };
}

function updateRuntimeHarnessRecoveryState(input: {
  state: RuntimeHarnessRecoveryState;
  action: RuntimeHarnessAction;
  result: unknown;
  workingSet: RuntimeSeatWorkingSet;
}) {
  const next: RuntimeHarnessRecoveryState = {
    byPath: { ...input.state.byPath }
  };
  const targetPath =
    input.action.action === "read" || input.action.action === "write_replace" || input.action.action === "write_append" || input.action.action === "write_section"
      ? normalizeRecoveryTargetPath(input.action.path)
      : "";
  const ok = typeof input.result === "object" && input.result && "ok" in input.result && input.result.ok === true;
  if (targetPath && ok) {
    delete next.byPath[targetPath];
    return next;
  }
  if (input.action.action === "read" && targetPath) {
    return next;
  }
  if ((input.action.action !== "write_section" && input.action.action !== "write_replace" && input.action.action !== "write_append") || !targetPath) {
    return next;
  }
  const error = getHarnessErrorText(input.result);
  if (!error || !isHarnessRecoveryError(error)) return next;
  const existing = next.byPath[targetPath];
  const failureCount = (existing?.failureCount ?? 0) + 1;
  const ledgerState = classifyPhase2LedgerTarget(input.workingSet, targetPath);
  const hasRead = hasWorkingSetReadForPath(input.workingSet, targetPath);
  const nextAction =
    input.action.action === "write_section"
      ? nextRecoveryActionForLedgerState(ledgerState, hasRead)
      : "read";
  next.byPath[targetPath] = {
    targetPath,
    nextAction,
    failureCount,
    suppressWriteSection: failureCount >= 2,
    error,
    existingHeading: extractSectionMergeHeading(error)
  };
  return next;
}

function buildHarnessResultMessage(input: {
  action: RuntimeHarnessAction;
  result: unknown;
  allowedActions: string[];
  workingSet: RuntimeSeatWorkingSet;
  recoveryHint?: RuntimeHarnessRecoveryHint | null;
}) {
  const lines = ["HARNESS_ACTION_RESULT"];
  lines.push(typeof input.result === "string" ? input.result : JSON.stringify(input.result));
  if (input.action.action === "write_replace" || input.action.action === "write_append" || input.action.action === "write_section") {
    const ok = typeof input.result === "object" && input.result && "ok" in input.result && input.result.ok === true;
    lines.push(
      ok
        ? `AUTHORITATIVE_FILE_STATE: ${input.action.path} is confirmed written by the harness.`
        : `AUTHORITATIVE_FILE_STATE: ${input.action.path} is not confirmed written; treat it as unchanged.`
    );
  }
  if (input.recoveryHint) {
    lines.push(`RECOVERY_TARGET: ${input.recoveryHint.targetPath}`);
    if (input.recoveryHint.existingHeading) {
      lines.push(`EXISTING_TARGET_HEADING: ${input.recoveryHint.existingHeading}`);
    }
    lines.push(`NEXT_RECOVERY_ACTION: ${input.recoveryHint.nextAction}`);
    lines.push(
      input.recoveryHint.suppressWriteSection
        ? "SECTION_MERGE_LOCKED_THIS_TURN: yes"
        : "SECTION_MERGE_LOCKED_THIS_TURN: no"
    );
    lines.push(`RECOVERY_REASON: ${input.recoveryHint.error}`);
  }
  lines.push(`NEXT_ALLOWED_ACTIONS: ${input.allowedActions.join(", ") || "none"}`);
  const workingSetInline = buildRuntimeActionWorkingSetInline(input.workingSet);
  if (workingSetInline) {
    lines.push("UPDATED_WORKING_SET");
    lines.push(workingSetInline);
  }
  lines.push("Do not describe file writes beyond the authoritative state line above.");
  lines.push("If another action is needed, output exactly one new ```debate-action``` block. Otherwise return the final Markdown answer.");
  return lines.join("\n\n");
}

async function runOpenAiProviderLoop(
  context: ProviderPromptContext,
  updateLiveStage: ReturnType<typeof createLiveStageUpdater>,
  overrideSystemPrompt: string | null
): Promise<ProviderExecutionResult> {
  let totalToolCalls = 0;
  const mutationJournalIds: string[] = [];
  let workingSet = await loadRuntimeSeatWorkingSet({
    userId: context.userId,
    debateId: context.debate.id,
    debateAgentId: context.debateAgentId,
    agentId: context.agent.id,
    allowedOutputPaths: context.allowedOutputPaths
  });
  const sharedPromptParts = await loadSharedSystemPromptParts(context);
  const promptVisibleSharedFiles = await loadPromptVisibleSharedFilesForTurn(context);
  workingSet = mergeRuntimeSharedFilesIntoWorkingSet(workingSet, promptVisibleSharedFiles);
  let runtimeReadableSharedPaths = buildRuntimeReadableSharedPaths({
    baseReadableSharedPaths: context.readableSharedPaths,
    workingSet
  });
  let runtimeAllowedOutputPaths = buildRuntimeAllowedOutputPaths({
    baseAllowedOutputPaths: context.allowedOutputPaths,
    workingSet,
    workflow: context.workflow
  });
  let dynamicOpenVote = context.openVote;
  let recoveryState: RuntimeHarnessRecoveryState = { byPath: {} };
  let actionPolicy = resolveRuntimeActionPolicy({
    roleType: context.currentRoleType,
    currentPhaseKind: context.currentPhase?.kind ?? null,
    pendingDeliverables: context.pendingDeliverables,
    phasePreferredWritablePaths: context.phasePreferredWritablePaths,
    ...buildRecoveryPolicyOverrides(recoveryState),
    openVote: dynamicOpenVote,
    debateAgentId: context.debateAgentId,
    workingSet,
    readableSharedPaths: runtimeReadableSharedPaths,
    allowedOutputPaths: runtimeAllowedOutputPaths
  });
  const systemInline = buildSharedSystemInline({
    context,
    overrideSystemPrompt,
    workingSet,
    actionPolicy,
    allowedOutputPaths: runtimeAllowedOutputPaths,
    sharedPromptParts
  });
  const promptChars = systemInline.length + context.prompt.length;
  const estimatedPromptTokens = estimatePromptTokensFromChars(promptChars);
  const rawMessages: Array<Record<string, unknown>> = [
    { role: "system", content: systemInline },
    { role: "user", content: context.prompt }
  ];
  const effectiveMaxInputTokens = context.agent.maxInputTokens ?? context.agent.contextLength;
  const messages = clipMessagesToInputLimit(rawMessages, effectiveMaxInputTokens, OPENAI_COMPAT_MAX_INPUT_CHARS);
  let loopState: RuntimeActionLoopState = { records: [] };

  try {
    for (let round = 0; ; round += 1) {
      updateLiveStage(
        round === 0 ? "calling_model" : "running_tools",
        round === 0 ? `请求模型：${context.eventAgentName}` : `继续执行 harness action（第 ${round} 轮）：${context.eventAgentName}`
      );

      let streamed:
      | {
          content: string;
          toolCalls: Array<{ id: string; type?: string; function: { name: string; arguments: string } }>;
          usage: unknown;
          finishReason?: string | null;
        }
      | null = null;
      try {
        updateLiveStage("calling_model", `等待模型返回：${context.eventAgentName}`);
        streamed = await openAiChatStream({
        debateId: context.debate.id,
        messageNumber: context.messageNumber,
        roundNumber: context.roundNumber,
        agentName: context.eventAgentName,
        baseRoleName: context.baseRoleName,
        url: context.url,
        apiKey: context.apiKey,
        quotaRequest: buildDebateQuotaRequest(context),
        body: withOptionalMaxTokens(
          {
            model: context.agent.model,
            messages
          },
          context.currentOutputMaxTokens,
          context.agent.provider
        )
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error ?? "");
        if (looksLikeToolsUnsupported(message)) {
          throw new AppError("AI_API_ERROR", 502, `Provider does not support tool calling for this request. ${message}`.trim());
        }
        throw error;
      }

      const assistantContent = streamed.content ?? "";
      const usage =
        normalizeOpenAiUsage(streamed.usage) ??
        normalizeOpenAiUsage(
          await openAiUsageProbe({
            url: context.url,
            apiKey: context.apiKey,
            quotaRequest: buildDebateQuotaRequest(context),
            body: { model: context.agent.model, messages }
          }).catch(() => null)
        );

      const parsedAction = parseRuntimeHarnessAction(assistantContent, actionPolicy.allowedActions);
      if ("error" in parsedAction) {
        throw new AppError("AI_ACTION_PROTOCOL_ERROR", 502, String(parsedAction.error));
      }
      if (!parsedAction.action) {
        return {
          raw: assertNonEmptyProviderText(assistantContent, {
            provider: context.agent.provider,
            model: context.agent.model,
            stage: "openai.final_text_response",
            finishReason: streamed.finishReason ?? null,
            toolCallsCount: totalToolCalls
          }),
          usage,
          promptChars,
          estimatedPromptTokens,
          mutationJournalIds,
          diagnostics: {
            provider: context.agent.provider,
            model: context.agent.model,
            requestedMaxTokens: context.requestedMaxTokens,
            finishReason: streamed.finishReason ?? null,
            toolCallsCount: totalToolCalls
          }
        };
      }

      totalToolCalls += 1;
      const loopRecord = makeRuntimeActionLoopRecord(parsedAction.action);
      const repeatedPattern = detectRuntimeActionLoop(loopState, loopRecord);
      if (repeatedPattern) {
        throw new AppError("AI_TOOL_LOOP_DETECTED", 502, `Repeated harness action pattern detected: ${repeatedPattern}`);
      }
      loopState = pushRuntimeActionLoopRecord(loopState, loopRecord);
      messages.push({
        role: "assistant",
        content: assistantContent
      });
      updateLiveStage("running_tools", `执行 harness action：${parsedAction.action.action}`);
      const execution = await executeRuntimeHarnessAction({
        userId: context.userId,
        debateId: context.debate.id,
        debateAgentId: context.debateAgentId,
        agentId: context.agent.id,
        readableSharedPaths: runtimeReadableSharedPaths,
        allowedOutputPaths: runtimeAllowedOutputPaths,
        readTargetPaths: actionPolicy.knownTargetPaths,
        writeTargetPaths: actionPolicy.preferredWritableTargetPaths,
        action: parsedAction.action,
        participantCount: context.participantCount,
        voterName: context.agent.name,
        turnNumber: context.messageNumber,
        roundNumber: context.roundNumber,
        now: new Date().toISOString(),
        currentWorkingSet: workingSet,
        mutationSequenceNumber: totalToolCalls
      });
      workingSet = execution.workingSet;
      if (execution.mutationJournalId) {
        mutationJournalIds.push(execution.mutationJournalId);
      }
      if (parsedAction.action.action === "vote_cast" && typeof execution.result === "object" && execution.result) {
        dynamicOpenVote = ((execution.result as { vote?: unknown }).vote as typeof dynamicOpenVote) ?? dynamicOpenVote;
      }
      recoveryState = updateRuntimeHarnessRecoveryState({
        state: recoveryState,
        action: parsedAction.action,
        result: execution.result,
        workingSet
      });
      runtimeReadableSharedPaths = buildRuntimeReadableSharedPaths({
        baseReadableSharedPaths: context.readableSharedPaths,
        workingSet
      });
      runtimeAllowedOutputPaths = buildRuntimeAllowedOutputPaths({
        baseAllowedOutputPaths: context.allowedOutputPaths,
        workingSet,
        workflow: context.workflow
      });
      actionPolicy = resolveRuntimeActionPolicy({
        roleType: context.currentRoleType,
        currentPhaseKind: context.currentPhase?.kind ?? null,
        pendingDeliverables: context.pendingDeliverables,
        phasePreferredWritablePaths: context.phasePreferredWritablePaths,
        ...buildRecoveryPolicyOverrides(recoveryState),
        openVote: dynamicOpenVote,
        debateAgentId: context.debateAgentId,
        workingSet,
        readableSharedPaths: runtimeReadableSharedPaths,
        allowedOutputPaths: runtimeAllowedOutputPaths
      });
      messages.push({
        role: "user",
        content: buildHarnessResultMessage({
          action: parsedAction.action,
          result: execution.result,
          allowedActions: actionPolicy.allowedActions,
          workingSet,
          recoveryHint:
            "path" in parsedAction.action
              ? recoveryState.byPath[normalizeRecoveryTargetPath(parsedAction.action.path)]
              : null
        })
      });
    }
  } catch (error) {
    await rollbackRuntimeTurnMutationsByIds(mutationJournalIds, new Date().toISOString()).catch(() => null);
    throw error;
  }
}

async function runAnthropicProviderLoop(
  context: ProviderPromptContext,
  updateLiveStage: ReturnType<typeof createLiveStageUpdater>,
  overrideSystemPrompt: string | null
): Promise<ProviderExecutionResult> {
  let totalToolCalls = 0;
  const mutationJournalIds: string[] = [];
  let workingSet = await loadRuntimeSeatWorkingSet({
    userId: context.userId,
    debateId: context.debate.id,
    debateAgentId: context.debateAgentId,
    agentId: context.agent.id,
    allowedOutputPaths: context.allowedOutputPaths
  });
  const sharedPromptParts = await loadSharedSystemPromptParts(context);
  const promptVisibleSharedFiles = await loadPromptVisibleSharedFilesForTurn(context);
  workingSet = mergeRuntimeSharedFilesIntoWorkingSet(workingSet, promptVisibleSharedFiles);
  let runtimeReadableSharedPaths = buildRuntimeReadableSharedPaths({
    baseReadableSharedPaths: context.readableSharedPaths,
    workingSet
  });
  let runtimeAllowedOutputPaths = buildRuntimeAllowedOutputPaths({
    baseAllowedOutputPaths: context.allowedOutputPaths,
    workingSet,
    workflow: context.workflow
  });
  let dynamicOpenVote = context.openVote;
  let recoveryState: RuntimeHarnessRecoveryState = { byPath: {} };
  let actionPolicy = resolveRuntimeActionPolicy({
    roleType: context.currentRoleType,
    currentPhaseKind: context.currentPhase?.kind ?? null,
    pendingDeliverables: context.pendingDeliverables,
    phasePreferredWritablePaths: context.phasePreferredWritablePaths,
    ...buildRecoveryPolicyOverrides(recoveryState),
    openVote: dynamicOpenVote,
    debateAgentId: context.debateAgentId,
    workingSet,
    readableSharedPaths: runtimeReadableSharedPaths,
    allowedOutputPaths: runtimeAllowedOutputPaths
  });
  const systemInline = buildSharedSystemInline({
    context,
    overrideSystemPrompt,
    workingSet,
    actionPolicy,
    allowedOutputPaths: runtimeAllowedOutputPaths,
    sharedPromptParts
  });
  const promptChars = systemInline.length + context.prompt.length;
  const estimatedPromptTokens = estimatePromptTokensFromChars(promptChars);
  const rawMessages: Array<Record<string, unknown>> = [{ role: "user", content: context.prompt }];
  const effectiveMaxInputTokens = context.agent.maxInputTokens ?? context.agent.contextLength;
  const messages = clipMessagesToInputLimit(rawMessages, effectiveMaxInputTokens, PROMPT_HARD_MAX_CHARS_ANTHROPIC);
  let loopState: RuntimeActionLoopState = { records: [] };

  try {
    for (let round = 0; ; round += 1) {
    updateLiveStage(
      round === 0 ? "calling_model" : "running_tools",
      round === 0 ? `请求模型：${context.eventAgentName}` : `继续执行 harness action（第 ${round} 轮）：${context.eventAgentName}`
    );
    updateLiveStage("calling_model", `等待模型返回：${context.eventAgentName}`);
    await ensureQuotaReservationOrDelay(buildDebateQuotaRequest(context));
    const response = await fetch(context.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": context.apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify(
        withOptionalMaxTokens(
          {
            model: context.agent.model,
            system: systemInline,
            messages
          },
          context.currentOutputMaxTokens,
          context.agent.provider
        )
      )
    });
    const payload = await response.json();

    if (!response.ok) {
      const text = JSON.stringify(payload).slice(0, 400);
      if (looksLikeToolsUnsupported(text)) {
        throw new AppError("AI_API_ERROR", 502, `Provider does not support tool calling for this request. ${text}`.trim());
      }
      throw new AppError("AI_API_ERROR", 502, text);
    }

    const contentBlocks = (payload.content ?? []) as Array<Record<string, unknown>>;
    const text = contentBlocks
      .filter((block) => block.type === "text")
      .map((block) => String((block as { text?: unknown }).text ?? ""))
      .join("\n");
    const parsedAction = parseRuntimeHarnessAction(text, actionPolicy.allowedActions);
    if ("error" in parsedAction) {
      throw new AppError("AI_ACTION_PROTOCOL_ERROR", 502, String(parsedAction.error));
    }

      if (!parsedAction.action) {
        const content = assertNonEmptyProviderText(text, {
        provider: context.agent.provider,
        model: context.agent.model,
        stage: "anthropic.final_text_response",
        finishReason: typeof payload?.stop_reason === "string" ? payload.stop_reason : null,
        toolCallsCount: totalToolCalls
      });
      await emitChunks(context.debate.id, context.messageNumber, context.eventAgentName, context.baseRoleName, content);
        return {
        raw: content,
        usage: normalizeAnthropicUsage(payload?.usage ?? null),
        promptChars,
        estimatedPromptTokens,
        mutationJournalIds,
        diagnostics: {
          provider: context.agent.provider,
          model: context.agent.model,
          requestedMaxTokens: context.requestedMaxTokens,
          finishReason: typeof payload?.stop_reason === "string" ? payload.stop_reason : null,
          toolCallsCount: totalToolCalls
        }
        };
      }

      totalToolCalls += 1;
      const loopRecord = makeRuntimeActionLoopRecord(parsedAction.action);
      const repeatedPattern = detectRuntimeActionLoop(loopState, loopRecord);
      if (repeatedPattern) {
        throw new AppError("AI_TOOL_LOOP_DETECTED", 502, `Repeated harness action pattern detected: ${repeatedPattern}`);
      }
      loopState = pushRuntimeActionLoopRecord(loopState, loopRecord);
      messages.push({ role: "assistant", content: [{ type: "text", text }] });
      updateLiveStage("running_tools", `执行 harness action：${parsedAction.action.action}`);
      const execution = await executeRuntimeHarnessAction({
        userId: context.userId,
        debateId: context.debate.id,
        debateAgentId: context.debateAgentId,
        agentId: context.agent.id,
        readableSharedPaths: runtimeReadableSharedPaths,
        allowedOutputPaths: runtimeAllowedOutputPaths,
        readTargetPaths: actionPolicy.knownTargetPaths,
        writeTargetPaths: actionPolicy.preferredWritableTargetPaths,
        action: parsedAction.action,
        participantCount: context.participantCount,
        voterName: context.agent.name,
        turnNumber: context.messageNumber,
        roundNumber: context.roundNumber,
        now: new Date().toISOString(),
        currentWorkingSet: workingSet,
        mutationSequenceNumber: totalToolCalls
      });
      workingSet = execution.workingSet;
      if (execution.mutationJournalId) {
        mutationJournalIds.push(execution.mutationJournalId);
      }
      if (parsedAction.action.action === "vote_cast" && typeof execution.result === "object" && execution.result) {
        dynamicOpenVote = ((execution.result as { vote?: unknown }).vote as typeof dynamicOpenVote) ?? dynamicOpenVote;
      }
      recoveryState = updateRuntimeHarnessRecoveryState({
        state: recoveryState,
        action: parsedAction.action,
        result: execution.result,
        workingSet
      });
      runtimeReadableSharedPaths = buildRuntimeReadableSharedPaths({
        baseReadableSharedPaths: context.readableSharedPaths,
        workingSet
      });
      runtimeAllowedOutputPaths = buildRuntimeAllowedOutputPaths({
        baseAllowedOutputPaths: context.allowedOutputPaths,
        workingSet,
        workflow: context.workflow
      });
      actionPolicy = resolveRuntimeActionPolicy({
        roleType: context.currentRoleType,
        currentPhaseKind: context.currentPhase?.kind ?? null,
        pendingDeliverables: context.pendingDeliverables,
        phasePreferredWritablePaths: context.phasePreferredWritablePaths,
        ...buildRecoveryPolicyOverrides(recoveryState),
        openVote: dynamicOpenVote,
        debateAgentId: context.debateAgentId,
        workingSet,
        readableSharedPaths: runtimeReadableSharedPaths,
        allowedOutputPaths: runtimeAllowedOutputPaths
      });
      messages.push({
        role: "user",
        content: [
          {
            type: "text",
            text: buildHarnessResultMessage({
              action: parsedAction.action,
              result: execution.result,
              allowedActions: actionPolicy.allowedActions,
              workingSet,
              recoveryHint:
                "path" in parsedAction.action
                  ? recoveryState.byPath[normalizeRecoveryTargetPath(parsedAction.action.path)]
                  : null
            })
          }
        ]
      });
    }
  } catch (error) {
    await rollbackRuntimeTurnMutationsByIds(mutationJournalIds, new Date().toISOString()).catch(() => null);
    throw error;
  }
}

export async function callProvider(
  debate: DebateRecord,
  agent: AgentRecord,
  messageNumber: number,
  roundNumber: number,
  participantCount: number,
  userId: string,
  debateAgentId: string,
  eventAgentName: string,
  baseRoleName: string
) {
  const input: ProviderCallInput = {
    debate,
    agent,
    messageNumber,
    roundNumber,
    participantCount,
    userId,
    debateAgentId,
    eventAgentName,
    baseRoleName
  };
  const promptContext = await buildProviderPromptContext(input);
  const overrideSystemPrompt = await loadDebateAgentSystemPrompt(userId, debateAgentId);
  const updateLiveStage = createLiveStageUpdater(input);
  assertProviderApiKeyEnabled(promptContext.apiKey);

  if (agent.provider === "openai") {
    return runOpenAiProviderLoop(promptContext, updateLiveStage, overrideSystemPrompt);
  }
  return runAnthropicProviderLoop(promptContext, updateLiveStage, overrideSystemPrompt);
}
