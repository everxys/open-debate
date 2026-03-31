import { decryptSecret } from "@/lib/crypto";
import { getDebateParticipantRoleType, loadDebateParticipantRoleTypes, type DebateParticipantRoleType } from "@/lib/debate-role-types";
import { emitDebateLiveEvent, setDebateLiveProgress } from "@/lib/debate-live";
import { AppError } from "@/lib/http";
import { retrieveRelevantHistory } from "@/lib/retrieval";
import {
  MAX_TOOL_ROUNDS,
  PROMPT_HARD_MAX_CHARS_ANTHROPIC
} from "@/lib/runtime/constants";
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
  loadOfficialDirectiveInline,
  loadOpenVote,
  loadOpenVoteInline,
  loadQuestionDiffInline,
  loadVoteAnnouncementInline,
  toolVoteCast,
  toolVoteClose,
  toolVoteOpen
} from "@/lib/runtime/tools";
import {
  openAiChatOnce,
  openAiChatStream,
  openAiUsageProbe,
  resolveChatUrl
} from "@/lib/runtime/provider-openai";
import {
  buildAnthropicTools,
  buildBaseSystemPrompt,
  buildDemoResponse,
  buildFileToolInstructions,
  buildOpenAiTools,
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
  getWorkflowElectionStartRound,
  getWorkflowOutputMaxTokens,
  isOfficialVotingAllowed,
  listMissingRequiredDeliverables,
  loadDebateWorkflow,
  type OfficialVote,
  resolveCurrentWorkflowPhase,
  resolveRequestedMaxTokens,
  withOptionalMaxTokens
} from "@/lib/runtime/workflow-phase";
import type { AgentRecord, DebateRecord } from "@/lib/types";
import {
  buildWorkflowOpeningInline,
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
  maybeGenerateVoteAnnouncementWithSeat1,
  recordImplicitFileReads,
  toolDebateFilesStat,
  toolDebateFilesWrite,
  toolListFiles,
  toolReadDebateFile,
  toolReadFile,
  toolSearchFiles,
  type DebateFileActivityAudit
} from "@/lib/runtime-main";

const OPENAI_COMPAT_MAX_INPUT_CHARS = 180_000;

type ProviderUsageSummary = {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
} | null;

type ElectionBallotSummary = {
  selections: Record<string, string>;
  reason: string | null;
  voterSeat: string | null;
} | null;

type ProviderExecutionResult = {
  raw: string;
  usage: ProviderUsageSummary;
  promptChars: number;
  estimatedPromptTokens: number | null;
  electionBallotSummary: ElectionBallotSummary;
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
  requiredDeliverables: NonNullable<Awaited<ReturnType<typeof loadDebateWorkflow>>>["deliverables"]["requiredFiles"] | [];
  pendingDeliverables: Awaited<ReturnType<typeof listMissingRequiredDeliverables>>;
  contextAccessLines: string[];
  responseFormatPolicy: {
    requireMarkdown: boolean;
    forbidRawJson: boolean;
  };
  prompt: string;
  implicitReadAudit: DebateFileActivityAudit;
};

function createLiveStageUpdater(input: ProviderCallInput) {
  return (stage: "calling_model" | "running_tools" | "parsing" | "saving", message: string) => {
    setDebateLiveProgress({
      debateId: input.debate.id,
      roundNumber: input.roundNumber,
      messageNumber: input.messageNumber,
      debateAgentId: input.debateAgentId,
      aiAgentId: input.agent.id,
      agentName: input.eventAgentName,
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

function extractElectionBallotSummaryFromToolResult(result: unknown): ElectionBallotSummary {
  if (!(result && typeof result === "object" && (result as { ok?: unknown }).ok)) return null;
  const ballot = (result as { ballot?: unknown }).ballot;
  const rawSelections =
    ballot && typeof ballot === "object" && (ballot as { selections?: unknown }).selections
      ? ((ballot as { selections?: unknown }).selections as Record<string, unknown>)
      : {};
  return {
    selections: Object.fromEntries(
      Object.entries(rawSelections)
        .filter(([, value]) => typeof value === "string" && Boolean(String(value).trim()))
        .map(([role, value]) => [String(role), String(value).trim()])
    ),
    reason:
      ballot && typeof ballot === "object" && typeof (ballot as { reason?: unknown }).reason === "string"
        ? String((ballot as { reason: string }).reason)
        : null,
    voterSeat:
      ballot && typeof ballot === "object" && typeof (ballot as { voterSeat?: unknown }).voterSeat === "string"
        ? String((ballot as { voterSeat: string }).voterSeat)
        : null
  };
}

async function handleVoteCloseSideEffects(context: ProviderCallInput, result: unknown) {
  const closedVote =
    result && typeof result === "object" && "closed" in result && (result as { closed?: unknown }).closed
      ? ((result as { closed: OfficialVote }).closed as OfficialVote)
      : null;
  if (!closedVote) return;
  try {
    await maybeGenerateVoteAnnouncementWithSeat1({
      userId: context.userId,
      debate: context.debate,
      participantCount: context.participantCount,
      closed: closedVote
    });
  } catch (error) {
    await logRuntimeEvent("warn", "vote announce after close failed", { error: describeRuntimeError(error) });
  }
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
  const allowedOutputPaths = workflow?.deliverables.allowedPaths ?? ["final/", "outputs/"];
  const requiredDeliverables = workflow?.deliverables.requiredFiles ?? [];
  const pendingDeliverables = await listMissingRequiredDeliverables({
    userId: input.userId,
    debateId: input.debate.id,
    workflow
  });
  const roleAssignments = await loadDebateParticipantRoleTypes(input.userId, input.debate.id);
  const currentRoleType = getDebateParticipantRoleType(roleAssignments, input.debateAgentId);
  const responseFormatPolicy = workflow?.promptPolicies.responseFormat ?? {
    requireMarkdown: true,
    forbidRawJson: true
  };

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
  const currentOutputMaxTokens = getWorkflowOutputMaxTokens(workflow, currentPhase?.kind ?? null, input.agent.maxOutputTokens);
  const contextAccessLines = buildContextAccessSummaryLines({
    workflow,
    currentPhaseKind: currentPhase?.kind ?? null
  });
  const requestedMaxTokens = resolveRequestedMaxTokens(currentOutputMaxTokens);
  const workflowPhaseInline = buildWorkflowPhaseInline({
    workflow,
    debate: input.debate,
    roundNumber: input.roundNumber,
    openVote,
    latestVote
  });
  const workflowOpeningInline = buildWorkflowOpeningInline({ workflow, roundNumber: input.roundNumber });
  const workflowIdeaBankInline = await loadWorkflowIdeaBankInline({
    workflow,
    phaseKind: currentPhase?.kind ?? null,
    userId: input.userId,
    debateId: input.debate.id
  });
  const openVoteInline = await loadOpenVoteInline(input.userId, input.debate.id, `${input.debateAgentId}:${openVote?.roundNumber ?? 0}`);
  const directiveInline = await loadOfficialDirectiveInline(input.userId, input.debate.id);
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
  const electionStartRound = getWorkflowElectionStartRound(workflow);
  const votingRuleInline = workflow?.enabled
    ? `- Official voting: enabled by workflow.json. startRound=${electionStartRound}. roles=[${(workflow.election.roles ?? []).join(", ")}].`
    : null;
  const alreadyVoted =
    openVote && openVote.status === "open"
      ? Boolean((openVote.ballots ?? []).some((ballot) => (ballot as { debateAgentId?: unknown }).debateAgentId === input.debateAgentId))
      : false;
  const votingActionInline =
    openVote && openVote.status === "open" && !alreadyVoted
      ? openVote.kind === "election"
        ? [
            "VOTING REQUIRED: An official election vote is open and you haven't voted yet.",
            "- Call tool debate_vote_cast with { selections: { <role>: 'Seat-X', ... }, reason?: '...' }.",
            "- Do not add any extra analysis, argument, or commentary in this election round."
          ].join("\n")
        : [
            "VOTING REQUIRED: An official vote is open and you haven't voted yet.",
            "- First: call tool debate_vote_cast with { choice: '<one option exactly>', reason?: '...' }.",
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
      { key: "workflowOpening", priority: 0, category: "core", preferredMaxChars: 12_000, content: workflowOpeningInline },
      { key: "workflowPhase", priority: 0, category: "core", preferredMaxChars: 14_000, content: workflowPhaseInline },
      { key: "workflowIdeaBank", priority: 2, category: "optional", preferredMaxChars: 8_000, content: workflowIdeaBankInline },
      { key: "votingRule", priority: 0, category: "core", preferredMaxChars: 1_500, content: votingRuleInline },
      {
        key: "round1Fairness",
        priority: 0,
        category: "core",
        preferredMaxChars: 1_200,
        content:
          input.messageNumber <= input.participantCount && (workflow?.promptPolicies.round1Fairness ?? true)
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
        key: "electionSilence",
        priority: 0,
        category: "core",
        preferredMaxChars: 800,
        content:
          openVote?.kind === "election"
            ? "Election silence rule: this round is vote-only. Do not provide extra discussion content beyond casting your ballot."
            : null
      },
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
    requiredDeliverables,
    pendingDeliverables,
    contextAccessLines,
    responseFormatPolicy,
    prompt,
    implicitReadAudit
  };
}

async function buildSharedSystemParts(context: ProviderPromptContext, overrideSystemPrompt: string | null) {
  const systemParts = [
    buildBaseSystemPrompt(context.agent, overrideSystemPrompt),
    buildFileToolInstructions({
      enableVoting: context.enableVotingTools,
      allowedOutputPaths: context.allowedOutputPaths,
      requiredFiles: context.requiredDeliverables,
      currentRoleType: context.currentRoleType,
      pendingRequiredFiles: context.pendingDeliverables,
      contextAccessLines: context.contextAccessLines
    })
  ];
  const inline = hasContextAccessRules(context.workflow)
    ? await loadContextAccessAutoReadInline({
        userId: context.userId,
        debateId: context.debate.id,
        debateAgentId: context.debateAgentId,
        agentId: context.agent.id,
        workflow: context.workflow,
        currentPhaseKind: context.currentPhase?.kind ?? null,
        audit: context.implicitReadAudit
      })
    : await loadDebateAgentFilesInline(context.userId, context.debateAgentId, context.agent.id, 18_000, context.implicitReadAudit);
  if (inline) systemParts.push(inline);
  if (context.messageNumber > context.participantCount) {
    const memoryInline = await loadDebateAgentMemoryInline(context.userId, context.debateAgentId, 10_000, context.implicitReadAudit);
    if (memoryInline) systemParts.push(memoryInline);
    if (context.debate.enableSharedFacts) {
      const sharedInline = await loadSharedFactsBoardInline(context.userId, context.debate.id, 10_000, context.implicitReadAudit);
      if (sharedInline) systemParts.push(sharedInline);
    }
  }
  systemParts.push(buildResponseFormatInstructions(context.responseFormatPolicy));
  return systemParts;
}

async function executeProviderToolCall(input: {
  provider: "openai" | "anthropic";
  toolName: string;
  rawArgs: unknown;
  toolCallId?: string;
  context: ProviderPromptContext;
  updateLiveStage: ReturnType<typeof createLiveStageUpdater>;
}) {
  input.updateLiveStage("running_tools", `执行工具：${input.toolName}`);

  let result: unknown;
  let electionBallotSummary: ElectionBallotSummary = null;
  const toolNow = new Date().toISOString();
  const toolPolicy = {
    workflow: input.context.workflow,
    currentPhaseKind: input.context.currentPhase?.kind ?? null
  };
  const toolAudit = {
    debateId: input.context.debate.id,
    turnNumber: input.context.messageNumber,
    roundNumber: input.context.roundNumber,
    now: toolNow
  };

  if (input.toolName === "agent_files_list") {
    const prefix = typeof (input.rawArgs as { prefix?: unknown }).prefix === "string" ? String((input.rawArgs as { prefix: string }).prefix) : undefined;
    result = await toolListFiles(
      input.context.userId,
      input.context.debateAgentId,
      input.context.agent.id,
      prefix,
      toolAudit,
      toolPolicy
    );
  } else if (input.toolName === "agent_files_read") {
    const path = String((input.rawArgs as { path?: unknown }).path ?? "");
    result = await toolReadFile(
      input.context.userId,
      input.context.debateAgentId,
      input.context.agent.id,
      path,
      toolAudit,
      toolPolicy
    );
  } else if (input.toolName === "agent_files_search") {
    const queryText = String((input.rawArgs as { query?: unknown }).query ?? "");
    result = await toolSearchFiles(
      input.context.userId,
      input.context.debateAgentId,
      input.context.agent.id,
      queryText,
      toolAudit,
      toolPolicy
    );
  } else if (input.toolName === "debate_files_read") {
    const path = String((input.rawArgs as { path?: unknown }).path ?? "");
    result = await toolReadDebateFile(
      input.context.userId,
      input.context.debateAgentId,
      input.context.debate.id,
      path,
      toolNow,
      input.context.messageNumber,
      input.context.roundNumber,
      toolPolicy
    );
  } else if (input.toolName === "debate_files_stat") {
    const path = String((input.rawArgs as { path?: unknown }).path ?? "");
    result = await toolDebateFilesStat({
      debateAgentId: input.context.debateAgentId,
      debateId: input.context.debate.id,
      turnNumber: input.context.messageNumber,
      roundNumber: input.context.roundNumber,
      path,
      now: toolNow,
      allowedOutputPaths: input.context.allowedOutputPaths
    });
  } else if (input.toolName === "debate_files_write") {
    const path = String((input.rawArgs as { path?: unknown }).path ?? "");
    const content = String((input.rawArgs as { content?: unknown }).content ?? "");
    const rawMode = (input.rawArgs as { mode?: unknown }).mode;
    const rawBaseVersion = (input.rawArgs as { baseVersion?: unknown }).baseVersion;
    const rawBaseUpdatedAt = (input.rawArgs as { baseUpdatedAt?: unknown }).baseUpdatedAt;
    const rawReason = (input.rawArgs as { reason?: unknown }).reason;
    const rawTargetHeading = (input.rawArgs as { targetHeading?: unknown }).targetHeading;
    const rawAllowShrink = (input.rawArgs as { allowShrink?: unknown }).allowShrink;
    result = await toolDebateFilesWrite({
      userId: input.context.userId,
      debateAgentId: input.context.debateAgentId,
      debateId: input.context.debate.id,
      turnNumber: input.context.messageNumber,
      roundNumber: input.context.roundNumber,
      path,
      content,
      mode: typeof rawMode === "string" ? rawMode : null,
      baseVersion: typeof rawBaseVersion === "number" ? rawBaseVersion : null,
      baseUpdatedAt: typeof rawBaseUpdatedAt === "string" ? rawBaseUpdatedAt : null,
      reason: typeof rawReason === "string" ? rawReason : null,
      targetHeading: typeof rawTargetHeading === "string" ? rawTargetHeading : null,
      allowShrink: rawAllowShrink === true,
      now: toolNow,
      allowedOutputPaths: input.context.allowedOutputPaths
    });
  } else if (input.toolName === "debate_vote_open") {
    const kind = String((input.rawArgs as { kind?: unknown }).kind ?? "custom");
    const title = String((input.rawArgs as { title?: unknown }).title ?? "投票");
    const promptText =
      typeof (input.rawArgs as { prompt?: unknown }).prompt === "string"
        ? String((input.rawArgs as { prompt: string }).prompt)
        : undefined;
    const options = Array.isArray((input.rawArgs as { options?: unknown }).options)
      ? ((input.rawArgs as { options: unknown[] }).options as unknown[]).map((item) => String(item))
      : undefined;
    result = await toolVoteOpen({
      userId: input.context.userId,
      debateId: input.context.debate.id,
      participantCount: input.context.participantCount,
      roundNumber: input.context.roundNumber,
      title,
      kind: kind === "election" ? "election" : kind === "finalization" ? "finalization" : "custom",
      prompt: promptText,
      options
    });
  } else if (input.toolName === "debate_vote_cast") {
    const selections =
      (input.rawArgs as { selections?: unknown }).selections && typeof (input.rawArgs as { selections?: unknown }).selections === "object"
        ? ((input.rawArgs as { selections: Record<string, unknown> }).selections as Record<string, unknown>)
        : undefined;
    const choice =
      typeof (input.rawArgs as { choice?: unknown }).choice === "string"
        ? String((input.rawArgs as { choice: string }).choice)
        : undefined;
    const reason =
      typeof (input.rawArgs as { reason?: unknown }).reason === "string"
        ? String((input.rawArgs as { reason: string }).reason)
        : undefined;
    result = await toolVoteCast({
      userId: input.context.userId,
      debateId: input.context.debate.id,
      participantCount: input.context.participantCount,
      debateAgentId: input.context.debateAgentId,
      voterName: input.context.agent.name,
      selections,
      choice,
      reason
    });
    electionBallotSummary = extractElectionBallotSummaryFromToolResult(result);
  } else if (input.toolName === "debate_vote_close") {
    result = await toolVoteClose({
      userId: input.context.userId,
      debateId: input.context.debate.id,
      participantCount: input.context.participantCount
    });
    await handleVoteCloseSideEffects(input.context, result);
  } else {
    result = { error: `Unknown tool: ${input.toolName}` };
  }

  const serialized = typeof result === "string" ? result : JSON.stringify(result);
  const toolMessage =
    input.provider === "openai"
      ? { role: "tool", tool_call_id: String(input.toolCallId ?? ""), content: serialized }
      : { type: "tool_result", tool_use_id: String(input.toolCallId ?? ""), content: serialized };

  return { result, toolMessage, electionBallotSummary };
}

async function runOpenAiProviderLoop(
  context: ProviderPromptContext,
  updateLiveStage: ReturnType<typeof createLiveStageUpdater>,
  overrideSystemPrompt: string | null
): Promise<ProviderExecutionResult> {
  let totalToolCalls = 0;
  let electionBallotSummary: ElectionBallotSummary = null;
  const tools = buildOpenAiTools({
    enableVoting: context.enableVotingTools,
    allowedOutputPaths: context.allowedOutputPaths
  });
  const systemParts = await buildSharedSystemParts(context, overrideSystemPrompt);
  const systemInline = systemParts.join("\n\n");
  const promptChars = systemInline.length + context.prompt.length;
  const estimatedPromptTokens = estimatePromptTokensFromChars(promptChars);
  const rawMessages: Array<Record<string, unknown>> = [
    { role: "system", content: systemInline },
    { role: "user", content: context.prompt }
  ];
  const effectiveMaxInputTokens = context.agent.maxInputTokens ?? context.agent.contextLength;
  const messages = clipMessagesToInputLimit(rawMessages, effectiveMaxInputTokens, OPENAI_COMPAT_MAX_INPUT_CHARS);

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
    updateLiveStage(
      round === 0 ? "calling_model" : "running_tools",
      round === 0 ? `请求模型：${context.eventAgentName}` : `继续生成（工具轮次 ${round}）：${context.eventAgentName}`
    );

    let streamed:
      | {
          content: string;
          toolCalls: Array<{ id: string; function: { name: string; arguments: string } }>;
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
        url: context.url,
        apiKey: context.apiKey,
        body: withOptionalMaxTokens(
          {
            model: context.agent.model,
            tools,
            tool_choice: "auto",
            messages
          },
          context.currentOutputMaxTokens
        )
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error ?? "");
      if (looksLikeToolsUnsupported(message)) break;
      throw error;
    }

    const toolCalls = streamed.toolCalls;
    const assistantContent = streamed.content ?? "";
    const usage =
      normalizeOpenAiUsage(streamed.usage) ??
      normalizeOpenAiUsage(
        await openAiUsageProbe({
          url: context.url,
          apiKey: context.apiKey,
          body: { model: context.agent.model, tools, tool_choice: "auto", messages }
        }).catch(() => null)
      );

    if (streamed.finishReason === "tool_calls" && (!toolCalls || toolCalls.length === 0)) {
      updateLiveStage("parsing", `检测到伪工具调用，转纯文本重试：${context.eventAgentName}`);
      const noToolRetry = await openAiChatOnce({
        url: context.url,
        apiKey: context.apiKey,
        body: withOptionalMaxTokens(
          {
            model: context.agent.model,
            messages
          },
          context.currentOutputMaxTokens
        )
      }).catch(() => null);
      const retryText = String(noToolRetry?.content ?? "").trim();
      if (retryText) {
        return {
          raw: retryText.length >= assistantContent.length ? retryText : assistantContent,
          usage: normalizeOpenAiUsage(noToolRetry?.usage) ?? usage,
          promptChars,
          estimatedPromptTokens,
          electionBallotSummary,
          diagnostics: {
            provider: context.agent.provider,
            model: context.agent.model,
            requestedMaxTokens: context.requestedMaxTokens,
            finishReason: noToolRetry?.finishReason ?? "tool_calls_retry_none",
            toolCallsCount: totalToolCalls
          }
        };
      }
    }

    if (!toolCalls || toolCalls.length === 0) {
      return {
        raw: assistantContent || buildDemoResponse(context.debate, context.agent, context.messageNumber),
        usage,
        promptChars,
        estimatedPromptTokens,
        electionBallotSummary,
        diagnostics: {
          provider: context.agent.provider,
          model: context.agent.model,
          requestedMaxTokens: context.requestedMaxTokens,
          finishReason: streamed.finishReason ?? (assistantContent ? null : "demo_fallback"),
          toolCallsCount: totalToolCalls
        }
      };
    }

    totalToolCalls += toolCalls.length;
    messages.push({ role: "assistant", tool_calls: toolCalls, content: assistantContent });

    for (const call of toolCalls) {
      let parsedArgs: unknown = {};
      try {
        parsedArgs = JSON.parse(call.function.arguments || "{}");
      } catch {
      }
      const execution = await executeProviderToolCall({
        provider: "openai",
        toolName: call.function.name,
        rawArgs: parsedArgs,
        toolCallId: call.id,
        context,
        updateLiveStage
      });
      if (execution.electionBallotSummary) {
        electionBallotSummary = execution.electionBallotSummary;
      }
      messages.push(execution.toolMessage);
    }
  }

  updateLiveStage("calling_model", `模型重试（无工具模式）：${context.eventAgentName}`);
  const fallback = await openAiChatStream({
    debateId: context.debate.id,
    messageNumber: context.messageNumber,
    roundNumber: context.roundNumber,
    agentName: context.eventAgentName,
    url: context.url,
    apiKey: context.apiKey,
    body: withOptionalMaxTokens({ model: context.agent.model, messages }, context.currentOutputMaxTokens)
  });
  const usage =
    normalizeOpenAiUsage(fallback.usage) ??
    normalizeOpenAiUsage(
      await openAiUsageProbe({
        url: context.url,
        apiKey: context.apiKey,
        body: { model: context.agent.model, messages }
      }).catch(() => null)
    );
  return {
    raw: fallback.content || buildDemoResponse(context.debate, context.agent, context.messageNumber),
    usage,
    promptChars,
    estimatedPromptTokens,
    electionBallotSummary,
    diagnostics: {
      provider: context.agent.provider,
      model: context.agent.model,
      requestedMaxTokens: context.requestedMaxTokens,
      finishReason: fallback.finishReason ?? (fallback.content ? null : "demo_fallback"),
      toolCallsCount: totalToolCalls
    }
  };
}

async function runAnthropicProviderLoop(
  context: ProviderPromptContext,
  updateLiveStage: ReturnType<typeof createLiveStageUpdater>,
  overrideSystemPrompt: string | null
): Promise<ProviderExecutionResult> {
  let totalToolCalls = 0;
  let electionBallotSummary: ElectionBallotSummary = null;
  const tools = buildAnthropicTools({
    enableVoting: context.enableVotingTools,
    allowedOutputPaths: context.allowedOutputPaths
  });
  const systemParts = await buildSharedSystemParts(context, overrideSystemPrompt);
  const systemInline = systemParts.join("\n\n");
  const promptChars = systemInline.length + context.prompt.length;
  const estimatedPromptTokens = estimatePromptTokensFromChars(promptChars);
  const rawMessages: Array<Record<string, unknown>> = [{ role: "user", content: context.prompt }];
  const effectiveMaxInputTokens = context.agent.maxInputTokens ?? context.agent.contextLength;
  const messages = clipMessagesToInputLimit(rawMessages, effectiveMaxInputTokens, PROMPT_HARD_MAX_CHARS_ANTHROPIC);

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
    updateLiveStage(
      round === 0 ? "calling_model" : "running_tools",
      round === 0 ? `请求模型：${context.eventAgentName}` : `继续生成（工具轮次 ${round}）：${context.eventAgentName}`
    );
    updateLiveStage("calling_model", `等待模型返回：${context.eventAgentName}`);
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
            tools,
            messages
          },
          context.currentOutputMaxTokens
        )
      )
    });
    const payload = await response.json();

    if (!response.ok) {
      const text = JSON.stringify(payload).slice(0, 400);
      if (looksLikeToolsUnsupported(text)) break;
      throw new AppError("AI_API_ERROR", 502, text);
    }

    const contentBlocks = (payload.content ?? []) as Array<Record<string, unknown>>;
    const toolUses = contentBlocks.filter((block) => block.type === "tool_use") as Array<{
      id: string;
      name: string;
      input: unknown;
    }>;

    if (toolUses.length === 0) {
      const textBlock = contentBlocks.find((block) => block.type === "text") as { text?: string } | undefined;
      const content = textBlock?.text ?? buildDemoResponse(context.debate, context.agent, context.messageNumber);
      await emitChunks(context.debate.id, context.messageNumber, context.agent.name, content);
      return {
        raw: content,
        usage: normalizeAnthropicUsage(payload?.usage ?? null),
        promptChars,
        estimatedPromptTokens,
        electionBallotSummary,
        diagnostics: {
          provider: context.agent.provider,
          model: context.agent.model,
          requestedMaxTokens: context.requestedMaxTokens,
          finishReason: typeof payload?.stop_reason === "string" ? payload.stop_reason : null,
          toolCallsCount: totalToolCalls
        }
      };
    }

    totalToolCalls += toolUses.length;
    messages.push({ role: "assistant", content: contentBlocks });

    const toolResults: Array<Record<string, unknown>> = [];
    for (const use of toolUses) {
      const execution = await executeProviderToolCall({
        provider: "anthropic",
        toolName: use.name,
        rawArgs: use.input,
        toolCallId: use.id,
        context,
        updateLiveStage
      });
      if (execution.electionBallotSummary) {
        electionBallotSummary = execution.electionBallotSummary;
      }
      toolResults.push(execution.toolMessage);
    }
    messages.push({ role: "user", content: toolResults });
  }

  const fallbackResponse = await fetch(context.url, {
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
          messages: [{ role: "user", content: context.prompt }]
        },
        context.currentOutputMaxTokens
      )
    )
  });
  const fallbackPayload = await fallbackResponse.json();
  if (!fallbackResponse.ok) {
    throw new AppError("AI_API_ERROR", 502, JSON.stringify(fallbackPayload).slice(0, 400));
  }
  const content = fallbackPayload.content?.[0]?.text ?? buildDemoResponse(context.debate, context.agent, context.messageNumber);
  await emitChunks(context.debate.id, context.messageNumber, context.agent.name, content);
  return {
    raw: content,
    usage: normalizeAnthropicUsage(fallbackPayload?.usage ?? null),
    promptChars,
    estimatedPromptTokens,
    electionBallotSummary,
    diagnostics: {
      provider: context.agent.provider,
      model: context.agent.model,
      requestedMaxTokens: context.requestedMaxTokens,
      finishReason: typeof fallbackPayload?.stop_reason === "string" ? fallbackPayload.stop_reason : null,
      toolCallsCount: totalToolCalls
    }
  };
}

export async function callProvider(
  debate: DebateRecord,
  agent: AgentRecord,
  messageNumber: number,
  roundNumber: number,
  participantCount: number,
  userId: string,
  debateAgentId: string,
  eventAgentName: string
) {
  const input: ProviderCallInput = {
    debate,
    agent,
    messageNumber,
    roundNumber,
    participantCount,
    userId,
    debateAgentId,
    eventAgentName
  };
  const promptContext = await buildProviderPromptContext(input);
  const overrideSystemPrompt = await loadDebateAgentSystemPrompt(userId, debateAgentId);
  const updateLiveStage = createLiveStageUpdater(input);

  if (process.env.NODE_ENV !== "production" && promptContext.apiKey.startsWith("demo-")) {
    const estimatedPromptTokens = estimatePromptTokensFromChars(promptContext.prompt.length);
    return {
      raw: buildDemoResponse(debate, agent, messageNumber),
      usage: null,
      promptChars: promptContext.prompt.length,
      estimatedPromptTokens,
      electionBallotSummary: null,
      diagnostics: {
        provider: agent.provider,
        model: agent.model,
        requestedMaxTokens: promptContext.requestedMaxTokens,
        finishReason: "demo_fallback",
        toolCallsCount: 0
      }
    };
  }

  if (agent.provider === "openai") {
    return runOpenAiProviderLoop(promptContext, updateLiveStage, overrideSystemPrompt);
  }
  return runAnthropicProviderLoop(promptContext, updateLiveStage, overrideSystemPrompt);
}
