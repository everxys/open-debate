import { randomUUID } from "node:crypto";
import { sql, type Kysely, type Transaction } from "kysely";

import { decryptSecret } from "@/lib/crypto";
import { getDebateParticipantRoleType, loadDebateParticipantRoleTypes, type DebateParticipantRoleType } from "@/lib/debate-role-types";
import { ensureDb } from "@/lib/db";
import type { OpenDebateDb } from "@/lib/db-schema";
import {
  clearDebateLiveProgress,
  clearDebateSummaryJob,
  emitDebateLiveEvent,
  setDebateLiveProgress,
  setDebateSummaryJob
} from "@/lib/debate-live";
import { AppError } from "@/lib/http";
import { indexDebateContextChunk, retrieveRelevantHistory, splitTextIntoRetrievalChunks } from "@/lib/retrieval";
import {
  ANSWERS_DIR,
  CONTEXT_GENERATION_DIAGNOSTICS_PATH,
  CONTEXT_SEGMENT_PATH,
  CONTEXT_USAGE_BASELINE_PATH,
  CONTEXT_USAGE_LOG_PATH,
  CONTEXT_USAGE_PATH,
  CONTEXT_USAGE_TOTALS_PATH,
  CONTEXT_WINDOW_PATH,
  DELIVERABLE_REPLACE_SHRINK_MIN_CHARS,
  DELIVERABLE_REPLACE_SHRINK_RATIO,
  ENABLE_DEBATE_MEMORY,
  MAX_TOOL_ROUNDS,
  MEMORY_LOG_COMPACT_THRESHOLD_CHARS,
  MEMORY_LOG_KEEP_LAST_LINES,
  MEMORY_LOG_PATH,
  MEMORY_SUMMARY_PATH,
  MEMORY_SUMMARY_REFRESH_EVERY_TURNS,
  PROMPT_HARD_MAX_CHARS_ANTHROPIC,
  QUESTION_LATEST_DIFF_PATH,
  ROUND_SUMMARY_DIR,
  SHARED_FACTS_PATH,
  TURN_SUMMARY_DIR,
  VOTE_ANNOUNCEMENT_PATH,
  VOTE_ANNOUNCEMENT_PREFIX,
  VOTE_DECISION_JSON_PATH,
  VOTE_DECISION_PATH,
  VOTE_OPEN_PATH,
  VOTE_RESULT_PREFIX,
  WORKFLOW_PATH
} from "@/lib/runtime/constants";
import {
  buildContextAccessSummaryLines,
  buildRelevantHistoryInline,
  clipPromptInlineContent,
  describeContextAccessDenied,
  getPhaseSnapshot,
  getPromptHardMaxChars,
  hasContextAccessRules,
  isContextPathReadable,
  isDirectChildPath,
  isMemoryPath,
  isPhaseUnlocked,
  matchContextAccessRule,
  normalizeContextPath,
  planPromptContext,
  resolveContextAccessRules,
  type PromptSection,
  type ResolvedContextAccessRule
} from "@/lib/runtime/context-inline";
import {
  readDebateAgentFile,
  readDebateFile,
  upsertDebateAgentFile,
  upsertDebateFile
} from "@/lib/runtime/file-store";
import {
  appendDebateFileContent,
  describeLegacyFinalWriteError,
  isFinalDebateOutputPath,
  loadDebatePhaseState,
  loadLatestVote,
  loadOfficialDecisionInline,
  loadOpenVote,
  loadOpenVoteInline,
  loadQuestionDiffInline,
  loadVoteAnnouncementInline,
  mergeMarkdownSectionByHeading,
  normalizeDebateFileWriteMode,
  normalizeDebateOutputPath,
  normalizeSeatLabel,
  shouldRejectDeliverableShrink,
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
  completeDebateSummaryJob,
  enqueueDebateSummaryJob,
  failDebateSummaryJob,
  markBlockedDebateSummaryJob,
  scheduleDebateSummaryJobRetry,
  type DebateSummaryJobKind,
  type DebateSummaryJobRecord
} from "@/lib/summary-jobs";
import {
  getDebateRunSnapshot,
  releaseDebateRun,
  touchDebateRun,
  tryAcquireDebateRun
} from "@/lib/runtime/run-registry";
import { appendServerLog } from "@/lib/server-log";
import type { AgentRecord, DebateRecord, DebateTurnRecord, StructuredOutput } from "@/lib/types";
import {
  formatRequiredDeliverableSummary,
  safeParseWorkflowJson,
  type NormalizedDebateWorkflow,
  type NormalizedWorkflowRequiredFile,
  type NormalizedWorkflowContextAccessRule,
  type WorkflowContextAccessScope,
  type WorkflowPhaseKind
} from "@/lib/workflow";
import {
  buildFinalizationVoteOptions,
  ClosedOfficialVote,
  FINALIZATION_VOTE_APPROVE,
  FINALIZATION_VOTE_REJECT,
  getWorkflowEarliestCompletionRound,
  getWorkflowEarliestDeliberationRound,
  getWorkflowEarliestFinalizationRound,
  getWorkflowEarliestFinalizationVoteRound,
  getWorkflowCompletionMode,
  getWorkflowMinimumAnalysisRounds,
  getWorkflowOutputMaxTokens,
  hasWorkflowPhase,
  getWorkflowPhaseMinRounds,
  getWorkflowPhaseByKind,
  isOfficialVotingAllowed,
  listClosedOfficialVoteRounds,
  listMissingRequiredDeliverables,
  loadDebateWorkflow,
  mapSpeechRoundIndexToActualRound,
  OfficialVote,
  OpenOfficialVote,
  resolveCurrentRoundNumberForWorkflow,
  resolveCurrentWorkflowPhase,
  resolveRequestedMaxTokens,
  requiresWorkflowFinalizationPhaseForCompletion,
  requiresWorkflowOutputsForCompletion,
  safeJsonParse,
  withOptionalMaxTokens
} from "@/lib/runtime/workflow-phase";

export {
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

export type DebateFileWriteMode = "replace" | "append" | "section_merge";
export type DebateFileActivityAction = "read" | "write" | "search" | "list" | "stat";
export type DebateFileActivityAudit = {
  debateId: string;
  debateAgentId: string;
  turnNumber: number;
  roundNumber: number;
  now: string;
};

type DbLike = Kysely<OpenDebateDb> | Transaction<OpenDebateDb>;

export function getPgErrorCode(error: unknown) {
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

export function truncateErrorMessage(message: string, maxChars = 1_500) {
  if (message.length <= maxChars) return message;
  return `${message.slice(0, maxChars - 1)}…`;
}

export function trimToChars(value: string, maxChars?: number | null) {
  if (maxChars === undefined || maxChars === null) return value;
  if (!Number.isFinite(maxChars) || maxChars <= 0) return value;
  if (value.length <= maxChars) return value;
  return value.slice(0, Math.floor(maxChars));
}

export function splitJsonLines(raw: string) {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function safeParseJsonLine(line: string) {
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function appendWithTrim(current: string, appended: string, maxChars?: number | null) {
  const next = (current ? `${current}\n` : "") + appended;
  if (maxChars === undefined || maxChars === null) return next;
  if (!Number.isFinite(maxChars) || maxChars <= 0) return next;
  if (next.length <= maxChars) return next;
  // keep tail when exceeding limit
  return next.slice(Math.max(0, next.length - maxChars));
}

export async function appendGenerationDiagnostics(input: {
  userId: string;
  debateId: string;
  now: string;
  entry: Record<string, unknown>;
}) {
  const current = (await readDebateFile(input.userId, input.debateId, CONTEXT_GENERATION_DIAGNOSTICS_PATH)) ?? "";
  const next = appendWithTrim(current, JSON.stringify(input.entry), 1_000_000);
  await upsertDebateFile(input.debateId, CONTEXT_GENERATION_DIAGNOSTICS_PATH, next, input.now);
}


export async function loadUsageBaselineByDebateAgentId(userId: string, debateId: string) {
  const raw = await readDebateFile(userId, debateId, CONTEXT_USAGE_BASELINE_PATH);
  if (!raw) return {};
  const parsed = safeJsonParse<{ byDebateAgentId?: unknown }>(raw);
  const by = parsed?.byDebateAgentId && typeof parsed.byDebateAgentId === "object" ? parsed.byDebateAgentId : null;
  if (!by) return {};
  return by as Record<string, unknown>;
}

export async function bumpUsageSessionForDebateAgent(input: {
  userId: string;
  debateId: string;
  debateAgentId: string;
  now: string;
  reason: string;
}) {
  const baselineRaw = await readDebateFile(input.userId, input.debateId, CONTEXT_USAGE_BASELINE_PATH);
  const baselineParsed = baselineRaw ? safeJsonParse<Record<string, unknown>>(baselineRaw) : null;
  const baselineByRaw =
    baselineParsed &&
    typeof baselineParsed === "object" &&
    (baselineParsed as any).byDebateAgentId &&
    typeof (baselineParsed as any).byDebateAgentId === "object"
      ? ((baselineParsed as any).byDebateAgentId as Record<string, unknown>)
      : {};

  const totalsRaw = await readDebateFile(input.userId, input.debateId, CONTEXT_USAGE_TOTALS_PATH);
  const totalsParsed = totalsRaw ? safeJsonParse<Record<string, unknown>>(totalsRaw) : null;
  const totalsByRaw =
    totalsParsed && typeof totalsParsed === "object" && (totalsParsed as any).byDebateAgentId && typeof (totalsParsed as any).byDebateAgentId === "object"
      ? ((totalsParsed as any).byDebateAgentId as Record<string, unknown>)
      : {};

  const totalsRow =
    totalsByRaw[input.debateAgentId] && typeof totalsByRaw[input.debateAgentId] === "object"
      ? (totalsByRaw[input.debateAgentId] as Record<string, unknown>)
      : null;
  const cumulative = totalsRow ? Number((totalsRow as any).cumulativePromptTokens) : 0;
  const cumulativePromptTokens = Number.isFinite(cumulative) && cumulative > 0 ? Math.floor(cumulative) : 0;

  const prevBaselineRow =
    baselineByRaw[input.debateAgentId] && typeof baselineByRaw[input.debateAgentId] === "object"
      ? (baselineByRaw[input.debateAgentId] as Record<string, unknown>)
      : null;
  const prevSessionId = prevBaselineRow ? Number((prevBaselineRow as any).sessionId) : 1;
  const sessionId = Number.isFinite(prevSessionId) && prevSessionId >= 1 ? Math.floor(prevSessionId) + 1 : 2;

  const nextBaselineBy = { ...baselineByRaw };
  nextBaselineBy[input.debateAgentId] = {
    ...(prevBaselineRow ? prevBaselineRow : {}),
    sessionId,
    baselineCumulativePromptTokens: cumulativePromptTokens,
    at: input.now,
    reason: input.reason
  };

  await upsertDebateFile(
    input.debateId,
    CONTEXT_USAGE_BASELINE_PATH,
    JSON.stringify({ updatedAt: input.now, byDebateAgentId: nextBaselineBy }, null, 2),
    input.now
  );

  if (totalsRow) {
    const contextLength = Number((totalsRow as any).contextLength);
    const safeContextLength = Number.isFinite(contextLength) && contextLength > 0 ? Math.floor(contextLength) : null;
    const nextTotalsBy = { ...totalsByRaw };
    nextTotalsBy[input.debateAgentId] = {
      ...totalsRow,
      sessionId,
      baselineCumulativePromptTokens: cumulativePromptTokens,
      sessionPromptTokens: 0,
      ratio: safeContextLength ? 0 : (totalsRow as any).ratio,
      updatedAt: input.now
    };
    await upsertDebateFile(
      input.debateId,
      CONTEXT_USAGE_TOTALS_PATH,
      JSON.stringify({ ...(totalsParsed ?? {}), updatedAt: input.now, byDebateAgentId: nextTotalsBy }, null, 2),
      input.now
    );
  }
}

export async function updateContextUsageFile(input: {
  userId: string;
  debateId: string;
  debateAgentId: string;
  agent: AgentRecord;
  usage: { promptTokens: number | null; completionTokens: number | null; totalTokens: number | null } | null;
  source?: "api" | "estimate";
  turnNumber: number;
  now: string;
}) {
  const promptTokens = input.usage?.promptTokens;
  const contextLength = input.agent.contextLength;
  if (promptTokens === null || typeof promptTokens !== "number" || promptTokens <= 0) return;
  const safeContextLength =
    contextLength !== null && typeof contextLength === "number" && Number.isFinite(contextLength) && contextLength > 0
      ? Math.floor(contextLength)
      : null;
  const ratio = safeContextLength ? promptTokens / safeContextLength : null;
  const existingRaw = await readDebateFile(input.userId, input.debateId, CONTEXT_USAGE_PATH);
  const existing = existingRaw ? safeJsonParse<Record<string, unknown>>(existingRaw) : null;
  const byDebateAgentIdRaw =
    existing && typeof existing === "object" && (existing as any).byDebateAgentId && typeof (existing as any).byDebateAgentId === "object"
      ? ((existing as any).byDebateAgentId as Record<string, unknown>)
      : {};

  const byDebateAgentId: Record<string, unknown> = { ...byDebateAgentIdRaw };
  byDebateAgentId[input.debateAgentId] = {
    promptTokens,
    contextLength: safeContextLength,
    ratio,
    at: input.now,
    turnNumber: input.turnNumber,
    source: input.source ?? "api",
    agentName: input.agent.name,
    provider: input.agent.provider,
    model: input.agent.model
  };

  const next = {
    updatedAt: input.now,
    byDebateAgentId
  };
  await upsertDebateFile(input.debateId, CONTEXT_USAGE_PATH, JSON.stringify(next, null, 2), input.now);
}

export async function appendContextUsageLogAndUpdateTotals(input: {
  userId: string;
  debateId: string;
  debateAgentId: string;
  seat: string;
  agent: AgentRecord;
  contextLength: number | null;
  apiPromptTokens: number | null;
  estimatedPromptTokens: number | null;
  usedPromptTokens: number;
  multiplier: number;
  source: "api" | "estimate";
  turnNumber: number;
  roundNumber: number;
  now: string;
}): Promise<{
  sessionId: number;
  contextLength: number | null;
  cumulativePromptTokens: number;
  sessionPromptTokens: number;
  ratio: number | null;
}> {
  const baselineBy = await loadUsageBaselineByDebateAgentId(input.userId, input.debateId);
  const baselineRow =
    baselineBy[input.debateAgentId] && typeof baselineBy[input.debateAgentId] === "object"
      ? (baselineBy[input.debateAgentId] as Record<string, unknown>)
      : null;
  const sessionId = baselineRow && Number.isFinite(Number(baselineRow.sessionId)) ? Math.floor(Number(baselineRow.sessionId)) : 1;

    // Append log.
    try {
      const prev = (await readDebateFile(input.userId, input.debateId, CONTEXT_USAGE_LOG_PATH)) ?? "";
      const line = JSON.stringify({
      at: input.now,
      sessionId,
      turnNumber: input.turnNumber,
      roundNumber: input.roundNumber,
      debateAgentId: input.debateAgentId,
      seat: input.seat,
      agentName: input.agent.name,
      model: input.agent.model,
      contextLength: input.contextLength,
      apiPromptTokens: input.apiPromptTokens,
      estimatedPromptTokens: input.estimatedPromptTokens,
      multiplier: input.multiplier,
      usedPromptTokens: input.usedPromptTokens,
      source: input.source
    });
    const next = appendWithTrim(prev, line);
    await upsertDebateFile(input.debateId, CONTEXT_USAGE_LOG_PATH, next.trim() + "\n", input.now);
  } catch (error) {
    await logRuntimeEvent("warn", "context usage log append failed", { error: describeRuntimeError(error) });
  }

  // Update totals (incremental; keep both cumulative and session delta).
  const totalsRaw = await readDebateFile(input.userId, input.debateId, CONTEXT_USAGE_TOTALS_PATH);
  const totalsParsed = totalsRaw ? safeJsonParse<Record<string, unknown>>(totalsRaw) : null;
  const byRaw =
    totalsParsed && typeof totalsParsed === "object" && (totalsParsed as any).byDebateAgentId && typeof (totalsParsed as any).byDebateAgentId === "object"
      ? ((totalsParsed as any).byDebateAgentId as Record<string, unknown>)
      : {};

  const prevTotalsRow =
    byRaw[input.debateAgentId] && typeof byRaw[input.debateAgentId] === "object"
      ? (byRaw[input.debateAgentId] as Record<string, unknown>)
      : null;
  const prevCumulative = prevTotalsRow ? Number(prevTotalsRow.cumulativePromptTokens) : 0;
  const baseCumulative = Number.isFinite(prevCumulative) && prevCumulative > 0 ? Math.floor(prevCumulative) : 0;
  const cumulativePromptTokens = baseCumulative + Math.max(0, Math.floor(input.usedPromptTokens));

  const prevContextLengthRaw = prevTotalsRow ? Number((prevTotalsRow as any).contextLength) : Number.NaN;
  const prevContextLength =
    Number.isFinite(prevContextLengthRaw) && prevContextLengthRaw > 0 ? Math.floor(prevContextLengthRaw) : null;
  const safeContextLength =
    input.contextLength !== null &&
    typeof input.contextLength === "number" &&
    Number.isFinite(input.contextLength) &&
    input.contextLength > 0
      ? Math.floor(input.contextLength)
      : prevContextLength;

  let baselineCumulativePromptTokens =
    baselineRow && Number.isFinite(Number(baselineRow.baselineCumulativePromptTokens))
      ? Math.floor(Number(baselineRow.baselineCumulativePromptTokens))
      : Number.NaN;
  if (!Number.isFinite(baselineCumulativePromptTokens) || baselineCumulativePromptTokens < 0) {
    baselineCumulativePromptTokens = baseCumulative;
    const nextBaselineBy = { ...baselineBy };
    nextBaselineBy[input.debateAgentId] = {
      sessionId,
      seat: input.seat,
      agentName: input.agent.name,
      model: input.agent.model,
      baselineCumulativePromptTokens,
      at: input.now,
      turnNumber: input.turnNumber
    };
    await upsertDebateFile(
      input.debateId,
      CONTEXT_USAGE_BASELINE_PATH,
      JSON.stringify({ updatedAt: input.now, byDebateAgentId: nextBaselineBy }, null, 2),
      input.now
    );
  }

  const sessionPromptTokens = Math.max(0, cumulativePromptTokens - baselineCumulativePromptTokens);
  const ratio = safeContextLength ? sessionPromptTokens / safeContextLength : null;

  const byDebateAgentId = { ...byRaw };
  byDebateAgentId[input.debateAgentId] = {
    seat: input.seat,
    agentName: input.agent.name,
    model: input.agent.model,
    contextLength: safeContextLength,
    sessionId,
    baselineCumulativePromptTokens,
    cumulativePromptTokens,
    sessionPromptTokens,
    ratio,
    updatedAt: input.now,
    turnNumber: input.turnNumber
  };

  const totals = {
    updatedAt: input.now,
    multiplier: input.multiplier,
    byDebateAgentId
  };
  await upsertDebateFile(input.debateId, CONTEXT_USAGE_TOTALS_PATH, JSON.stringify(totals, null, 2), input.now);
  return { sessionId, contextLength: safeContextLength, cumulativePromptTokens, sessionPromptTokens, ratio };
}

export function buildMemorySummaryMarkdown(input: {
  debateQuestion: string;
  agentName: string;
  updatedAt: string;
  entries: Array<{
    turnNumber: number;
    proposedSolution: string | null;
    agreementScore: number | null;
    arguments: Array<{ type: string; content: string }>;
    contentExcerpt: string;
  }>;
}) {
  const solutions: string[] = [];
  const scores: number[] = [];
  const recentArgs: Array<{ type: string; content: string }> = [];

  for (let i = input.entries.length - 1; i >= 0; i -= 1) {
    const entry = input.entries[i];
    if (entry.proposedSolution && !solutions.includes(entry.proposedSolution)) {
      solutions.push(entry.proposedSolution);
      if (solutions.length >= 6) break;
    }
  }

  for (const entry of input.entries.slice(-12)) {
    if (typeof entry.agreementScore === "number") scores.push(entry.agreementScore);
    for (const arg of entry.arguments) {
      recentArgs.push({ type: arg.type, content: arg.content });
      if (recentArgs.length >= 10) break;
    }
    if (recentArgs.length >= 10) break;
  }

  const excerpts = input.entries.slice(-8).map((entry) => ({
    turnNumber: entry.turnNumber,
    text: entry.contentExcerpt
  }));

  const lines: string[] = [];
  lines.push(`# Memory Summary · ${input.agentName}`);
  lines.push("");
  lines.push(`Updated: ${input.updatedAt}`);
  lines.push("");
  lines.push(`Question: ${input.debateQuestion}`);
  lines.push("");

  lines.push("## Recent Proposed Solutions");
  if (solutions.length === 0) lines.push("- (none)");
  for (const solution of solutions) lines.push(`- ${solution}`);
  lines.push("");

  lines.push("## Agreement Scores (recent)");
  if (scores.length === 0) {
    lines.push("- (none)");
  } else {
    const tail = scores.slice(-10);
    lines.push(`- ${tail.join(", ")}`);
  }
  lines.push("");

  lines.push("## Recent Arguments");
  if (recentArgs.length === 0) lines.push("- (none)");
  for (const arg of recentArgs) {
    const type = arg.type === "rebuttal" ? "rebuttal" : "support";
    lines.push(`- [${type}] ${trimToChars(arg.content.replace(/\s+/g, " ").trim(), 220)}`);
  }
  lines.push("");

  lines.push("## Recent Excerpts");
  if (excerpts.length === 0) lines.push("- (none)");
  for (const excerpt of excerpts) {
    lines.push(`- Turn ${excerpt.turnNumber}: ${trimToChars(excerpt.text.replace(/\s+/g, " ").trim(), 240)}`);
  }
  lines.push("");

  return lines.join("\n");
}

export async function refreshParticipantMemorySummary(input: {
  userId: string;
  debateId: string;
  debateAgentId: string;
  agentName: string;
  debateQuestion: string;
  now: string;
}) {
  const rawLog = (await readDebateAgentFile(input.userId, input.debateAgentId, MEMORY_LOG_PATH)) ?? "";
  const lines = splitJsonLines(rawLog).slice(-MEMORY_LOG_KEEP_LAST_LINES);
  const entries: Array<{
    turnNumber: number;
    proposedSolution: string | null;
    agreementScore: number | null;
    arguments: Array<{ type: string; content: string }>;
    contentExcerpt: string;
  }> = [];

  for (const line of lines) {
    const parsed = safeParseJsonLine(line);
    if (!parsed) continue;
    const turnNumber = Number(parsed.turnNumber ?? NaN);
    if (!Number.isFinite(turnNumber)) continue;
    const proposedSolution =
      typeof parsed.proposedSolution === "string" ? parsed.proposedSolution : null;
    const agreementScore =
      typeof parsed.agreementScore === "number" ? parsed.agreementScore : null;
    const argsRaw = Array.isArray(parsed.arguments) ? parsed.arguments : [];
    const argumentsList = argsRaw
      .map((arg) => ({
        type: typeof (arg as { type?: unknown }).type === "string" ? String((arg as { type?: unknown }).type) : "support",
        content:
          typeof (arg as { content?: unknown }).content === "string"
            ? String((arg as { content?: unknown }).content)
            : ""
      }))
      .filter((arg) => arg.content.trim());
    const excerpt =
      typeof parsed.contentExcerpt === "string" ? parsed.contentExcerpt : "";
    entries.push({
      turnNumber,
      proposedSolution,
      agreementScore,
      arguments: argumentsList,
      contentExcerpt: excerpt
    });
  }

  const summary = buildMemorySummaryMarkdown({
    debateQuestion: input.debateQuestion,
    agentName: input.agentName,
    updatedAt: input.now,
    entries
  });

  await upsertDebateAgentFile(
    input.debateAgentId,
    MEMORY_SUMMARY_PATH,
    trimToChars(summary),
    input.now
  );

  if (rawLog.length > MEMORY_LOG_COMPACT_THRESHOLD_CHARS) {
    const kept = lines.slice(-MEMORY_LOG_KEEP_LAST_LINES).join("\n");
    await upsertDebateAgentFile(input.debateAgentId, MEMORY_LOG_PATH, kept, input.now);
  }
}

export async function persistMemoryAfterTurn(input: {
  userId: string;
  debateId: string;
  debateAgentId: string;
  agentName: string;
  debateQuestion: string;
  turnNumber: number;
  content: string;
  structuredOutput: StructuredOutput | null;
  now: string;
}) {
  if (!ENABLE_DEBATE_MEMORY) return;

  const existingLog = (await readDebateAgentFile(input.userId, input.debateAgentId, MEMORY_LOG_PATH)) ?? "";
  const output = input.structuredOutput;
  const entry = {
    turnNumber: input.turnNumber,
    at: input.now,
    agentName: input.agentName,
    proposedSolution: output?.proposed_solution ?? null,
    agreementScore: typeof output?.agreement_score === "number" ? output.agreement_score : null,
    arguments: (output?.arguments ?? []).map((arg) => ({
      type: arg.type,
      content: trimToChars(String(arg.content ?? ""), 800)
    })),
    contentExcerpt: trimToChars(input.content, 1200)
  };
  const appended = JSON.stringify(entry);
  const nextLog = appendWithTrim(existingLog, appended, MEMORY_LOG_COMPACT_THRESHOLD_CHARS + 20_000);
  await upsertDebateAgentFile(input.debateAgentId, MEMORY_LOG_PATH, nextLog, input.now);

  const shouldRefresh =
    input.turnNumber <= 2 || input.turnNumber % MEMORY_SUMMARY_REFRESH_EVERY_TURNS === 0 || nextLog.length > MEMORY_LOG_COMPACT_THRESHOLD_CHARS;

  if (shouldRefresh) {
    await refreshParticipantMemorySummary({
      userId: input.userId,
      debateId: input.debateId,
      debateAgentId: input.debateAgentId,
      agentName: input.agentName,
      debateQuestion: input.debateQuestion,
      now: input.now
    });
  }

  try {
    const summary = (await readDebateAgentFile(input.userId, input.debateAgentId, MEMORY_SUMMARY_PATH)) ?? "";
    if (summary.trim()) {
      await indexDebateContextChunk({
        userId: input.userId,
        debateId: input.debateId,
        debateAgentId: input.debateAgentId,
        chunkKey: `memory:${input.debateAgentId}`,
        sourceType: "memory_summary",
        sourcePath: MEMORY_SUMMARY_PATH,
        turnNumberStart: input.turnNumber,
        turnNumberEnd: input.turnNumber,
        content: summary,
        now: input.now
      });
    }
  } catch {
    // retrieval indexing is best-effort
  }
}

function getWorkflowSummarizerConfig(workflow: NormalizedDebateWorkflow | null) {
  if (!workflow?.enabled || !workflow.summarizer.enabled) return null;
  const aiAgentId = workflow.summarizer.aiAgentId?.trim() || "";
  if (!aiAgentId) return null;
  return workflow.summarizer;
}

export function getTurnSummaryPath(workflow: NormalizedDebateWorkflow | null, roundNumber: number, turnNumber: number) {
  const baseDir = workflow?.summarizer.outputPaths.turnSummaryDir || TURN_SUMMARY_DIR;
  return `${baseDir}round-${roundNumber}/turn-${turnNumber}.md`;
}

export function getRoundSummaryPath(workflow: NormalizedDebateWorkflow | null, roundNumber: number) {
  const baseDir = workflow?.summarizer.outputPaths.roundSummaryDir || ROUND_SUMMARY_DIR;
  return `${baseDir}round-${roundNumber}.md`;
}

export function getFactsBoardPath(workflow: NormalizedDebateWorkflow | null) {
  return workflow?.summarizer.outputPaths.factsBoardPath || SHARED_FACTS_PATH;
}

async function loadWorkflowSummarizerAgent(userId: string, workflow: NormalizedDebateWorkflow | null) {
  const summarizer = getWorkflowSummarizerConfig(workflow);
  if (!summarizer) return null;
  const db = await ensureDb();
  const result = await db
    .selectFrom("ai_agents")
    .selectAll()
    .where("id", "=", summarizer.aiAgentId)
    .where("user_id", "=", userId)
    .where("deleted_at", "is", null)
    .limit(1)
    .executeTakeFirst();
  if (!result) return null;
  return {
    summarizer,
    agent: normalizeAgentRow(result as Record<string, unknown>)
  };
}

async function callWorkflowSummarizerMarkdown(input: {
  userId: string;
  debateId: string;
  workflow: NormalizedDebateWorkflow | null;
  systemTask: string;
  userPrompt: string;
  maxTokens?: number;
}) {
  const runtime = await loadWorkflowSummarizerAgent(input.userId, input.workflow);
  if (!runtime) return null;
  const summarizerRuntime = runtime;
  const apiKey = decryptSecret(summarizerRuntime.agent.apiKeyEncrypted);
  const url = resolveChatUrl(summarizerRuntime.agent);
  const system = [buildBaseSystemPrompt(summarizerRuntime.agent, null), input.systemTask, "Output only Markdown for humans; no tool calls."]
    .join("\n\n")
    .trim();

  async function executeOnce() {
    if (summarizerRuntime.agent.provider === "openai") {
      const response = await openAiChatOnce({
        url,
        apiKey,
        body: {
          model: summarizerRuntime.agent.model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: input.userPrompt }
          ],
          ...(input.maxTokens ? { max_tokens: input.maxTokens } : {})
        }
      });
      return String(response.content ?? "").trim() || null;
    }

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: summarizerRuntime.agent.model,
        max_tokens: input.maxTokens ?? 1000,
        system,
        messages: [{ role: "user", content: input.userPrompt }]
      })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new AppError("AI_API_ERROR", 502, JSON.stringify(payload).slice(0, 400));
    }
    const blocks = (payload.content ?? []) as Array<Record<string, unknown>>;
    return blocks
      .filter((block) => block.type === "text")
      .map((block) => String((block as { text?: unknown }).text ?? ""))
      .join("\n")
      .trim();
  }

  const retryDelaysMs = [800, 2000];
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    try {
      return await executeOnce();
    } catch (error) {
      lastError = error;
      const details = describeRuntimeError(error);
      const message = String(details.message ?? "");
      const looksRateLimited =
        message.includes("429") || message.toLowerCase().includes("rate limit") || message.toLowerCase().includes("too many requests");
      const retryable = isRecoverableRuntimeInterruption(details) || looksRateLimited;
      if (!retryable || attempt >= retryDelaysMs.length) {
        throw error;
      }
      await logRuntimeEvent("warn", "summarizer request retrying", {
        debateId: input.debateId,
        provider: summarizerRuntime.agent.provider,
        model: summarizerRuntime.agent.model,
        attempt: attempt + 1,
        nextDelayMs: retryDelaysMs[attempt],
        error: details
      });
      await sleep(retryDelaysMs[attempt]);
    }
  }
  throw lastError ?? new AppError("RUNTIME_ERROR", 500, "summarizer request failed");
}

function buildDefaultTurnSummaryPrompt(input: {
  debateQuestion: string;
  roundNumber: number;
  turnNumber: number;
  agentName: string;
  content: string;
}) {
  return [
    `Debate question:\n${input.debateQuestion}`,
    `\n\nCurrent turn metadata:\n- Round ${input.roundNumber}\n- Turn ${input.turnNumber}\n- Speaker: ${input.agentName}`,
    `\n\nTurn content:\n${trimToChars(input.content, 16_000)}`,
    "\n\nWrite a Markdown turn summary with exactly these sections:",
    "## 本回关键信息",
    "## 本回动作/状态更新",
    "## 对讨论推进的影响",
    "## 仍未解决的问题",
    "\nIf this turn is mainly a vote, announcement, file write, checkpoint, or other procedural/action turn, do not force fake 'new claims'. Summarize the action taken, the state change, and what it means for the debate. If a section truly has no content, say so briefly instead of inventing material. Do not quote long passages."
  ].join("").trim();
}

function buildDefaultRoundSummaryPrompt(input: {
  debateQuestion: string;
  roundNumber: number;
  turnSummaries: Array<{ turnNumber: number; agentName: string; content: string }>;
}) {
  return [
    `Debate question:\n${input.debateQuestion}`,
    `\n\nRound ${input.roundNumber} turn summaries:`,
    ...input.turnSummaries.map(
      (item) => `\n\n### Turn ${item.turnNumber} · ${item.agentName}\n${trimToChars(item.content, 6_000)}`
    ),
    "\n\nWrite a detailed Markdown round summary with exactly these sections:",
    "## 本轮关键推进",
    "## 本轮关键动作/状态变化",
    "## 本轮沉淀出的候选方案或结果",
    "## 本轮遗留风险",
    "## 下一轮最该继续推进的点",
    "\nWithin each section, prefer multiple concise bullets over a single vague paragraph. Cover each turn's real contribution when it matters, make clear which changes were procedural versus substantive, and spell out what advanced, what stalled, and what still blocks progress. If this round is mostly voting, announcements, file consolidation, or other procedural work, summarize those state changes directly instead of forcing discussion-style consensus and disagreement. Only summarize this round. Do not re-summarize the whole debate."
  ].join("").trim();
}

async function writeSummarizerDebateFile(input: {
  userId: string;
  debateId: string;
  debateAgentId: string;
  turnNumber: number;
  roundNumber: number;
  path: string;
  content: string;
  reason: "summarizer:turn_summary" | "summarizer:round_summary" | "summarizer:facts_board";
  now: string;
}) {
  const beforeContent = await readDebateFile(input.userId, input.debateId, input.path);
  await upsertDebateFile(input.debateId, input.path, input.content, input.now);
  await recordDebateFileActivity({
    debateId: input.debateId,
    debateAgentId: input.debateAgentId,
    turnNumber: input.turnNumber,
    roundNumber: input.roundNumber,
    action: "write",
    scope: "debate",
    path: input.path,
    writeMode: "replace",
    beforeContent,
    afterContent: input.content,
    reason: input.reason,
    now: input.now
  });
}

function buildDefaultFactsBoardPrompt(input: {
  debateQuestion: string;
  existingBoard: string | null;
  sourceLabel: string;
  sourceSummary: string;
}) {
  return [
    `Debate question:\n${input.debateQuestion}`,
    `\n\nCurrent facts board:\n${input.existingBoard?.trim() || "(empty board)"}`,
    `\n\nNew summary source (${input.sourceLabel}):\n${trimToChars(input.sourceSummary, 10_000)}`,
    "\n\nRewrite the full facts board in Markdown with exactly these sections:",
    "## 已确认共识",
    "## 候选方案",
    "## 未决问题",
    "## 高风险漏洞",
    "## 关键文件缺口",
    "\nMerge duplicates, remove stale points that were clearly superseded, and keep each bullet concise."
  ].join("").trim();
}

function combineSummarizerPrompt(customPrompt: string | null | undefined, basePrompt: string) {
  const trimmed = customPrompt?.trim();
  if (!trimmed) return basePrompt;
  return [`Summary instructions:\n${trimmed}`, basePrompt].join("\n\n---\n\n").trim();
}

function countMarkdownSections(content: string) {
  return (content.match(/^##\s+/gm) ?? []).length;
}

function validateSummarizerOutput(
  kind: "turn_summary" | "round_summary" | "facts_board",
  content: string
) {
  const normalized = content.trim();
  if (!normalized) return "empty_output";
  if (/^\s*(error|exception|traceback)\b/i.test(normalized)) return "invalid_output_error_echo";
  if (kind === "turn_summary") {
    if (normalized.length < 160) return "turn_summary_too_short";
    if (countMarkdownSections(normalized) < 4) return "turn_summary_missing_sections";
    return null;
  }
  if (kind === "round_summary") {
    if (normalized.length < 320) return "round_summary_too_short";
    if (countMarkdownSections(normalized) < 5) return "round_summary_missing_sections";
    return null;
  }
  if (normalized.length < 180) return "facts_board_too_short";
  if (countMarkdownSections(normalized) < 5) return "facts_board_missing_sections";
  return null;
}

function getSummaryJobLabel(kind: DebateSummaryJobKind, roundNumber?: number | null, turnNumber?: number | null) {
  if (kind === "turn_summary") return `第 ${roundNumber ?? "?"} 轮第 ${turnNumber ?? "?"} 回摘要`;
  if (kind === "round_summary") return `第 ${roundNumber ?? "?"} 轮摘要`;
  return "结构化事实板";
}

function mapSummaryJobStatusToLiveStatus(status: DebateSummaryJobRecord["status"]) {
  return status;
}

async function syncSummaryJobToLive(job: DebateSummaryJobRecord, message?: string | null, blockedReason?: string | null) {
  setDebateSummaryJob(job.debateId, {
    key: job.jobKey,
    kind: job.kind,
    label: getSummaryJobLabel(job.kind, job.roundNumber, job.turnNumber),
    turnNumber: job.turnNumber,
    roundNumber: job.roundNumber,
    status: mapSummaryJobStatusToLiveStatus(job.status),
    message: message ?? null,
    errorReason: blockedReason ?? job.lastError,
    retryAt: job.nextRetryAt,
    attemptCount: job.attemptCount,
    blockedReason,
    deadLetter: job.status === "dead_letter"
  });
}

async function updateSummaryJob(
  debateId: string,
  job: {
    key: string;
    kind: DebateSummaryJobKind;
    label: string;
    turnNumber?: number | null;
    roundNumber?: number | null;
    status: DebateSummaryJobRecord["status"];
    message: string | null;
    errorReason?: string | null;
    retryAt?: string | null;
    attemptCount?: number | null;
    blockedReason?: string | null;
  }
) {
  setDebateSummaryJob(debateId, {
    key: job.key,
    kind: job.kind,
    label: job.label,
    turnNumber: job.turnNumber ?? null,
    roundNumber: job.roundNumber ?? null,
    status: job.status,
    message: job.message,
    errorReason: job.errorReason ?? null,
    retryAt: job.retryAt ?? null,
    attemptCount: job.attemptCount ?? null,
    blockedReason: job.blockedReason ?? null,
    deadLetter: job.status === "dead_letter"
  });
  if (job.status === "completed") {
    clearDebateSummaryJob(debateId, job.key);
  }
}

export async function generateTurnSummary(input: {
  userId: string;
  debateId: string;
  debateAgentId: string;
  debateQuestion: string;
  workflow: NormalizedDebateWorkflow | null;
  roundNumber: number;
  turnNumber: number;
  agentName: string;
  content: string;
  now: string;
  refreshFactsBoard?: boolean;
}) {
  const summarizer = getWorkflowSummarizerConfig(input.workflow);
  if (!summarizer || !summarizer.perTurn) return { ok: false, skipped: true };

  const key = `turn_summary:${input.turnNumber}`;
  await updateSummaryJob(input.debateId, {
    key,
    kind: "turn_summary",
    label: `第 ${input.roundNumber} 轮第 ${input.turnNumber} 回摘要`,
    turnNumber: input.turnNumber,
    roundNumber: input.roundNumber,
    status: "running",
    message: "AI 总结中..."
  });

  try {
    const content = await callWorkflowSummarizerMarkdown({
      userId: input.userId,
      debateId: input.debateId,
      workflow: input.workflow,
      systemTask: "SYSTEM TASK: Summarize the just-finished turn into a high-signal turn summary.",
      userPrompt: combineSummarizerPrompt(
        summarizer.prompts.turnSummary,
        buildDefaultTurnSummaryPrompt({
          debateQuestion: input.debateQuestion,
          roundNumber: input.roundNumber,
          turnNumber: input.turnNumber,
          agentName: input.agentName,
          content: input.content
        })
      ),
      maxTokens: 900
    });
    const nextContent = content?.trim() ?? "";
    const invalidReason = validateSummarizerOutput("turn_summary", nextContent);
    if (invalidReason) {
      await updateSummaryJob(input.debateId, {
        key,
        kind: "turn_summary",
        label: `第 ${input.roundNumber} 轮第 ${input.turnNumber} 回摘要`,
        turnNumber: input.turnNumber,
        roundNumber: input.roundNumber,
        status: "failed",
        message: "回摘要生成失败",
        errorReason: invalidReason
      });
      return { ok: false, error: invalidReason };
    }
    const path = getTurnSummaryPath(input.workflow, input.roundNumber, input.turnNumber);
    await writeSummarizerDebateFile({
      userId: input.userId,
      debateId: input.debateId,
      debateAgentId: input.debateAgentId,
      turnNumber: input.turnNumber,
      roundNumber: input.roundNumber,
      path,
      content: `${nextContent}\n`,
      reason: "summarizer:turn_summary",
      now: input.now
    });
    try {
      await indexDebateContextChunk({
        userId: input.userId,
        debateId: input.debateId,
        chunkKey: `turn_summary:${input.turnNumber}`,
        sourceType: "turn_summary",
        sourcePath: path,
        turnNumberStart: input.turnNumber,
        turnNumberEnd: input.turnNumber,
        roundNumber: input.roundNumber,
        content: nextContent,
        now: input.now
      });
    } catch {
    }
    await updateSummaryJob(input.debateId, {
      key,
      kind: "turn_summary",
      label: `第 ${input.roundNumber} 轮第 ${input.turnNumber} 回摘要`,
      turnNumber: input.turnNumber,
      roundNumber: input.roundNumber,
      status: "completed",
      message: "回摘要已完成"
    });
    return { ok: true, path, content: nextContent };
  } catch (error) {
    const details = describeRuntimeError(error);
    await updateSummaryJob(input.debateId, {
      key,
      kind: "turn_summary",
      label: `第 ${input.roundNumber} 轮第 ${input.turnNumber} 回摘要`,
      turnNumber: input.turnNumber,
      roundNumber: input.roundNumber,
      status: "failed",
      message: "回摘要生成失败",
      errorReason: truncateErrorMessage(String(details.message ?? "turn_summary_failed"))
    });
    await logRuntimeEvent("warn", "turn summary generation failed", { debateId: input.debateId, error: details });
    return { ok: false, error };
  }
}

async function listRoundTurnSummaries(input: {
  userId: string;
  debateId: string;
  workflow: NormalizedDebateWorkflow | null;
  roundNumber: number;
  participantCount: number;
}) {
  const startTurn = (input.roundNumber - 1) * input.participantCount + 1;
  const endTurn = input.roundNumber * input.participantCount;
  const db = await ensureDb();
  const turnRows = await db
    .selectFrom("debate_turns as t")
    .innerJoin("ai_agents as a", "a.id", "t.ai_agent_id")
    .leftJoin("debate_agents as da", "da.id", "t.debate_agent_id")
    .select([
      "t.turn_number",
      sql<string>`coalesce(da.display_name, a.name)`.as("speaker_name")
    ])
    .where("t.debate_id", "=", input.debateId)
    .where("t.turn_number", ">=", startTurn)
    .where("t.turn_number", "<=", endTurn)
    .orderBy("t.turn_number", "asc")
    .execute();
  const items: Array<{ turnNumber: number; agentName: string; content: string }> = [];
  for (const row of turnRows) {
    const turnNumber = Number(row.turn_number);
    const content = await readDebateFile(
      input.userId,
      input.debateId,
      getTurnSummaryPath(input.workflow, input.roundNumber, turnNumber)
    );
    if (!content?.trim()) continue;
    items.push({
      turnNumber,
      agentName: String(row.speaker_name ?? `Turn-${turnNumber}`),
      content: content.trim()
    });
  }
  return items;
}

export async function refreshFactsBoardFromSummaries(input: {
  userId: string;
  debateId: string;
  debateAgentId: string;
  debateQuestion: string;
  workflow: NormalizedDebateWorkflow | null;
  sourceLabel: string;
  sourceSummary: string;
  turnNumber?: number | null;
  roundNumber?: number | null;
  now: string;
}) {
  if (!ENABLE_DEBATE_MEMORY) return { ok: false, skipped: true };
  const summarizer = getWorkflowSummarizerConfig(input.workflow);
  if (!summarizer || !summarizer.factsBoard) return { ok: false, skipped: true };

  const key = input.turnNumber ? `facts_board:turn:${input.turnNumber}` : `facts_board:round:${input.roundNumber ?? 0}`;
  await updateSummaryJob(input.debateId, {
    key,
    kind: "facts_board",
    label: "结构化事实板",
    turnNumber: input.turnNumber ?? null,
    roundNumber: input.roundNumber ?? null,
    status: "running",
    message: "AI 总结中..."
  });

  try {
    const boardPath = getFactsBoardPath(input.workflow);
    const current = await readDebateFile(input.userId, input.debateId, boardPath);
    const content = await callWorkflowSummarizerMarkdown({
      userId: input.userId,
      debateId: input.debateId,
      workflow: input.workflow,
      systemTask: "SYSTEM TASK: Rewrite the debate facts board into a concise structured board.",
      userPrompt: combineSummarizerPrompt(
        summarizer.prompts.factsBoard,
        buildDefaultFactsBoardPrompt({
          debateQuestion: input.debateQuestion,
          existingBoard: current,
          sourceLabel: input.sourceLabel,
          sourceSummary: input.sourceSummary
        })
      ),
      maxTokens: 1200
    });
    const nextContent = content?.trim() ?? "";
    const invalidReason = validateSummarizerOutput("facts_board", nextContent);
    if (invalidReason) {
      await updateSummaryJob(input.debateId, {
        key,
        kind: "facts_board",
        label: "结构化事实板",
        turnNumber: input.turnNumber ?? null,
        roundNumber: input.roundNumber ?? null,
        status: "failed",
        message: "事实板整理失败",
        errorReason: invalidReason
      });
      return { ok: false, error: invalidReason };
    }
    await writeSummarizerDebateFile({
      userId: input.userId,
      debateId: input.debateId,
      debateAgentId: input.debateAgentId,
      turnNumber: input.turnNumber ?? 0,
      roundNumber: input.roundNumber ?? 0,
      path: boardPath,
      content: `${nextContent}\n`,
      reason: "summarizer:facts_board",
      now: input.now
    });
    try {
      await indexDebateContextChunk({
        userId: input.userId,
        debateId: input.debateId,
        chunkKey: "shared_facts:board",
        sourceType: "shared_facts",
        sourcePath: boardPath,
        turnNumberStart: input.turnNumber ?? undefined,
        turnNumberEnd: input.turnNumber ?? undefined,
        roundNumber: input.roundNumber ?? undefined,
        content: nextContent,
        now: input.now
      });
    } catch {
    }
    await updateSummaryJob(input.debateId, {
      key,
      kind: "facts_board",
      label: "结构化事实板",
      turnNumber: input.turnNumber ?? null,
      roundNumber: input.roundNumber ?? null,
      status: "completed",
      message: "事实板已更新"
    });
    return { ok: true, path: boardPath, content: nextContent };
  } catch (error) {
    const details = describeRuntimeError(error);
    await updateSummaryJob(input.debateId, {
      key,
      kind: "facts_board",
      label: "结构化事实板",
      turnNumber: input.turnNumber ?? null,
      roundNumber: input.roundNumber ?? null,
      status: "failed",
      message: "事实板整理失败",
      errorReason: truncateErrorMessage(String(details.message ?? "facts_board_failed"))
    });
    await logRuntimeEvent("warn", "facts board refresh failed", { debateId: input.debateId, error: details });
    return { ok: false, error };
  }
}

export async function persistAnswerAfterTurn(input: {
  userId: string;
  debateId: string;
  roundNumber: number;
  turnNumber: number;
  agentName: string;
  content: string;
  now: string;
}) {
  const answersPath = `${ANSWERS_DIR}round-${input.roundNumber}/turn-${input.turnNumber}.md`;
  const lines: string[] = [];
  lines.push(`# Turn ${input.turnNumber} · Round ${input.roundNumber}`);
  lines.push("");
  lines.push(`- Speaker: ${input.agentName}`);
  lines.push(`- Timestamp: ${input.now}`);
  lines.push("");
  lines.push(input.content.trim());
  lines.push("");
  await upsertDebateFile(input.debateId, answersPath, lines.join("\n"), input.now);
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function aggregateConsensusByLastRound(
  turns: DebateTurnRecord[],
  participantCount: number,
  consensus?: NormalizedDebateWorkflow["consensus"] | null
) {
  if (participantCount <= 0) participantCount = 1;

  const enabled = consensus?.enabled === undefined ? true : Boolean(consensus.enabled);
  const minAvgScoreRaw = consensus?.minAvgScore ?? 8;
  const minAvgScore = typeof minAvgScoreRaw === "number" && Number.isFinite(minAvgScoreRaw) ? minAvgScoreRaw : 8;
  const requireAllSeats =
    consensus?.requireAllSeats === undefined ? true : Boolean(consensus.requireAllSeats);

  if (!enabled) {
    return { reached: false, leadingSolution: null as string | null, score: 0 };
  }

  if (turns.length < participantCount) {
    return { reached: false, leadingSolution: null as string | null, score: 0 };
  }
  if (turns.length % participantCount !== 0) {
    return { reached: false, leadingSolution: null as string | null, score: 0 };
  }

  const lastRoundTurns = turns.slice(-participantCount);
  const solutions = lastRoundTurns.map((t) => t.structuredOutput?.proposed_solution ?? null);
  if (solutions.some((s) => !s || !String(s).trim())) {
    return { reached: false, leadingSolution: null as string | null, score: 0 };
  }

  const normalized = solutions.map((s) => String(s));
  const first = normalized[0];
  const unanimous = normalized.every((s) => s === first);
  if (!unanimous) {
    return { reached: false, leadingSolution: first, score: 0 };
  }

  const scores = lastRoundTurns
    .map((t) => t.structuredOutput?.agreement_score)
    .filter((x): x is number => typeof x === "number");
  const avg = scores.length > 0 ? scores.reduce((sum, item) => sum + item, 0) / scores.length : 0;
  const reached = (requireAllSeats ? scores.length === participantCount : scores.length > 0) && avg >= minAvgScore;

  return { reached, leadingSolution: first, score: Number((avg / 10).toFixed(3)) };
}

export function parseResponse(raw: string): {
  content: string;
  structuredOutput: StructuredOutput | null;
  parseStatus: "ok" | "fallback";
} {
  const trimmed = raw.trim();

  function extractJsonCandidate(text: string) {
    const value = text.trim();
    if (value.startsWith("{") && value.endsWith("}")) return value;
    if (!value.startsWith("```")) return null;

    const fenceEnd = value.indexOf("\n");
    if (fenceEnd <= 0) return null;
    const closeFence = value.lastIndexOf("```");
    if (closeFence <= fenceEnd) return null;
    if (closeFence < value.length - 3) return null;
    return value.slice(fenceEnd + 1, closeFence).trim();
  }

  function toStructuredOutput(parsed: unknown): StructuredOutput | null {
    if (typeof parsed !== "object" || parsed === null) return null;
    const obj = parsed as Record<string, unknown>;

    const proposed_solution =
      typeof obj.proposed_solution === "string" ? obj.proposed_solution.trim() : undefined;

    const agreement_score = typeof obj.agreement_score === "number" ? obj.agreement_score : undefined;

    const argumentsRaw = Array.isArray(obj.arguments) ? obj.arguments : [];
    const argumentsParsed = argumentsRaw
      .map((item) => {
        if (typeof item !== "object" || item === null) return null;
        const arg = item as Record<string, unknown>;
        const type: "support" | "rebuttal" = arg.type === "rebuttal" ? "rebuttal" : "support";
        const content = typeof arg.content === "string" ? arg.content.trim() : "";
        const target = typeof arg.target === "string" ? arg.target.trim() : undefined;
        if (!content) return null;
        return { type, content, ...(target ? { target } : {}) };
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item));

    const hasAny = Boolean(proposed_solution || agreement_score !== undefined || argumentsParsed.length > 0);
    if (!hasAny) return null;

    return {
      proposed_solution,
      agreement_score,
      arguments: argumentsParsed.length > 0 ? argumentsParsed : undefined
    };
  }

  const jsonCandidate = extractJsonCandidate(trimmed);
  if (jsonCandidate) {
    try {
      const parsed = JSON.parse(jsonCandidate);
      const structuredOutput = toStructuredOutput(parsed);
      if (structuredOutput) {
        const lines: string[] = [];
        if (structuredOutput.proposed_solution) {
          lines.push(`## 方案`);
          lines.push(structuredOutput.proposed_solution);
          lines.push("");
        }

        const args = structuredOutput.arguments ?? [];
        const support = args.filter((arg) => arg.type === "support");
        const rebuttal = args.filter((arg) => arg.type === "rebuttal");

        if (support.length > 0) {
          lines.push("## 支持点");
          for (const arg of support) lines.push(`- ${arg.content}`);
          lines.push("");
        }
        if (rebuttal.length > 0) {
          lines.push("## 反对点");
          for (const arg of rebuttal) lines.push(`- ${arg.content}`);
          lines.push("");
        }

        if (typeof structuredOutput.agreement_score === "number") {
          lines.push("## 同意度");
          lines.push(String(structuredOutput.agreement_score));
          lines.push("");
        }

        return {
          content: lines.join("\n").trim() || raw,
          structuredOutput,
          parseStatus: "ok" as const
        };
      }
    } catch {
      return { content: raw, structuredOutput: null, parseStatus: "fallback" as const };
    }
  }

  return { content: raw, structuredOutput: null, parseStatus: "ok" as const };
}

export function appendWorkflowSummaryLines(lines: string[], workflow: NormalizedDebateWorkflow | null) {
  lines.push("## Rules (summary)");
  if (!workflow?.enabled) {
    lines.push("- disabled (no workflow.json or enabled=false)");
    return;
  }

  const hasFinalizationVotePhase = hasWorkflowPhase(workflow, "finalization_vote");
  const hasFinalizationPhase = hasWorkflowPhase(workflow, "finalization");
  lines.push(`- version: v${workflow.workflowVersion}`);
  lines.push(
    `- phase minRounds: analysis=${getWorkflowMinimumAnalysisRounds(workflow)}; deliberation=${getWorkflowPhaseMinRounds(workflow, "deliberation", 0)}; finalization_vote=${hasFinalizationVotePhase ? getWorkflowPhaseMinRounds(workflow, "finalization_vote", 0) : "n/a"}; finalization=${hasFinalizationPhase ? getWorkflowPhaseMinRounds(workflow, "finalization", 0) : "n/a"}`
  );
  lines.push(
    `- phase earliest rounds: deliberation@${getWorkflowEarliestDeliberationRound(workflow)}; finalization_vote@${hasFinalizationVotePhase ? getWorkflowEarliestFinalizationVoteRound(workflow) : "n/a"}; finalization@${hasFinalizationPhase ? getWorkflowEarliestFinalizationRound(workflow) : "n/a"}; completion@${getWorkflowEarliestCompletionRound(workflow)}`
  );
  lines.push(
    `- consolidation controls: votePhase=${hasFinalizationVotePhase ? "yes" : "no"}; consolidationPhase=${hasFinalizationPhase ? "yes" : "no"}; autoOpenVote=${workflow.phaseMachine.transitionRules.finalization.autoOpenVote ? "yes" : "no"}; requireUnanimousVote=${workflow.phaseMachine.transitionRules.finalization.requireUnanimousVote ? "yes" : "no"}; reopenUntilPassed=${workflow.phaseMachine.transitionRules.finalization.reopenUntilPassed ? "yes" : "no"}; discussionRoundsBetweenVotes=${workflow.phaseMachine.transitionRules.finalization.discussionRoundsBetweenVotes}; requirePhaseForCompletion=${workflow.phaseMachine.transitionRules.finalization.requirePhaseForCompletion ? "yes" : "no"}`
  );
  lines.push(
    `- output budget: discussion=${workflow.promptPolicies.outputBudget.discussionMaxTokens ?? "unlimited"}; writing=${workflow.promptPolicies.outputBudget.writingMaxTokens ?? "unlimited"}`
  );
  if (workflow.deliverables.requiredFiles.length > 0) {
    lines.push("- required deliverables:");
    for (const file of workflow.deliverables.requiredFiles) {
      lines.push(`  - ${formatRequiredDeliverableSummary(file, "plain")}`);
    }
  }
  if (workflow.summarizer.enabled) {
    lines.push(
      `- summarizer: enabled; perTurn=${workflow.summarizer.perTurn ? "yes" : "no"}; perRound=${workflow.summarizer.perRound ? "yes" : "no"}; factsBoard=${workflow.summarizer.factsBoard ? "yes" : "no"}`
    );
    lines.push(
      `- summarizer outputs: turn=${workflow.summarizer.outputPaths.turnSummaryDir}; round=${workflow.summarizer.outputPaths.roundSummaryDir}; facts=${workflow.summarizer.outputPaths.factsBoardPath}`
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
}

export async function loadAgentFilesInline(
  userId: string,
  debateAgentId: string,
  agentId: string,
  maxChars?: number | null,
  audit: DebateFileActivityAudit | null = null
) {
  try {
    const db = await ensureDb();
    const result = await db
      .selectFrom("ai_agent_files as f")
      .innerJoin("ai_agents as a", "a.id", "f.ai_agent_id")
      .select(["f.path", "f.content"])
      .where("f.ai_agent_id", "=", agentId)
      .where("a.user_id", "=", userId)
      .orderBy("f.path", "asc")
      .execute();

    const parts: string[] = [];
    const auditedPaths: string[] = [];
    for (const row of result) {
      const path = String(row.path);
      if (isMemoryPath(path)) continue;
      const content = String(row.content ?? "");
      const header = `\n\n---\nFILE: ${path}\n---\n`;
      parts.push(header + content);
      auditedPaths.push(path);
    }

    if (parts.length === 0) return null;
    await recordImplicitFileReads({
      audit,
      scope: "agent",
      paths: auditedPaths,
      targetDebateAgentId: null
    });
    return `Agent files (read-only context):${clipPromptInlineContent(parts.join(""), maxChars ?? 18_000)}`;
  } catch (error) {
    return null;
  }
}

type SeatFileSource = "debate" | "agent";
type SeatFileEntry = {
  path: string;
  content: string;
  source: SeatFileSource;
};

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

async function listMergedSeatFiles(userId: string, debateAgentId: string, agentId: string, prefix = "") {
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

export async function loadDebateAgentSystemPrompt(userId: string, debateAgentId: string) {
  try {
    const db = await ensureDb();
    const result = await db
      .selectFrom("debate_agent_overrides as o")
      .innerJoin("debate_agents as da", "da.id", "o.debate_agent_id")
      .innerJoin("debates as d", "d.id", "da.debate_id")
      .select("o.system_prompt")
      .where("o.debate_agent_id", "=", debateAgentId)
      .where("d.user_id", "=", userId)
      .limit(1)
      .executeTakeFirst();
    return (result?.system_prompt as string | null | undefined) ?? null;
  } catch (error) {
    if (isMissingTableError(error, "debate_agent_overrides")) return null;
    return null;
  }
}

export async function loadDebateAgentFilesInline(
  userId: string,
  debateAgentId: string,
  agentId: string,
  maxChars?: number | null,
  audit: DebateFileActivityAudit | null = null
) {
  try {
    const files = await listMergedSeatFiles(userId, debateAgentId, agentId);
    const parts: string[] = [];
    const auditedDebatePaths: string[] = [];
    const auditedAgentPaths: string[] = [];
    for (const row of files) {
      const path = String(row.path ?? "");
      if (isMemoryPath(path)) continue;
      const content = String(row.content ?? "");
      const header = `\n\n---\nFILE: ${path}\n---\n`;
      parts.push(header + content);
      if (row.source === "debate") {
        auditedDebatePaths.push(path);
      } else {
        auditedAgentPaths.push(path);
      }
    }

    if (parts.length === 0) {
      return loadAgentFilesInline(userId, debateAgentId, agentId, maxChars, audit);
    }
    await recordImplicitFileReads({ audit, scope: "agent", paths: auditedDebatePaths, targetDebateAgentId: debateAgentId });
    await recordImplicitFileReads({ audit, scope: "agent", paths: auditedAgentPaths, targetDebateAgentId: null });
    return `Agent files (read-only context):${clipPromptInlineContent(parts.join(""), maxChars ?? 18_000)}`;
  } catch (error) {
    if (isMissingTableError(error, "debate_agent_files")) {
      return loadAgentFilesInline(userId, debateAgentId, agentId, maxChars, audit);
    }
    return loadAgentFilesInline(userId, debateAgentId, agentId, maxChars, audit);
  }
}

export async function listSeatContextFilesForRule(
  userId: string,
  debateAgentId: string,
  agentId: string,
  rule: ResolvedContextAccessRule
) {
  const rows = await listMergedSeatFiles(userId, debateAgentId, agentId, rule.pathPrefix);
  return rows.filter((row) => (rule.recursive ? true : isDirectChildPath(rule.pathPrefix, String(row.path ?? ""))));
}

export async function listSharedContextFilesForRule(userId: string, debateId: string, rule: ResolvedContextAccessRule) {
  const prefixLike = `${rule.pathPrefix}%`;
  try {
    const db = await ensureDb();
    const result = await db
      .selectFrom("debate_files as f")
      .innerJoin("debates as d", "d.id", "f.debate_id")
      .select(["f.path", "f.content"])
      .where("f.debate_id", "=", debateId)
      .where("d.user_id", "=", userId)
      .where("f.path", "like", prefixLike)
      .orderBy("f.path", "asc")
      .execute();
    return result.filter((row) => (rule.recursive ? true : isDirectChildPath(rule.pathPrefix, String(row.path ?? ""))));
  } catch (error) {
    if (isMissingTableError(error, "debate_files")) return [];
    throw error;
  }
}

export async function loadContextAccessAutoReadInline(input: {
  userId: string;
  debateId: string;
  debateAgentId: string;
  agentId: string;
  workflow: NormalizedDebateWorkflow | null;
  currentPhaseKind: WorkflowPhaseKind | null | undefined;
  audit?: DebateFileActivityAudit | null;
}) {
  if (!hasContextAccessRules(input.workflow)) return null;
  const resolved = resolveContextAccessRules(input.workflow, input.currentPhaseKind);
  if (resolved.autoRead.length <= 0) return null;

  const blocks: string[] = ["Context access auto-read files (IMPORTANT):"];
  for (const rule of resolved.autoRead) {
    const rows =
      rule.scope === "shared"
        ? await listSharedContextFilesForRule(input.userId, input.debateId, rule)
        : await listSeatContextFilesForRule(input.userId, input.debateAgentId, input.agentId, rule);
    if (rows.length <= 0) continue;
    const limitedRows = rows.slice(0, Math.max(1, rule.maxFiles));
    if (rule.scope === "shared") {
      await recordImplicitFileReads({
        audit: input.audit ?? null,
        scope: "debate",
        paths: limitedRows.map((row) => String(row.path ?? "")),
        targetDebateAgentId: null
      });
    } else {
      const seatRows = limitedRows as SeatFileEntry[];
      await recordImplicitFileReads({
        audit: input.audit ?? null,
        scope: "agent",
        paths: seatRows.filter((row) => row.source === "debate").map((row) => String(row.path ?? "")),
        targetDebateAgentId: input.debateAgentId
      });
      await recordImplicitFileReads({
        audit: input.audit ?? null,
        scope: "agent",
        paths: seatRows.filter((row) => row.source === "agent").map((row) => String(row.path ?? "")),
        targetDebateAgentId: null
      });
    }
    blocks.push(`- [${rule.scope}] ${rule.pathPrefix}`);
    for (const row of limitedRows) {
      const path = normalizeContextPath(String(row.path ?? ""));
      const content = clipPromptInlineContent(String(row.content ?? ""), Math.max(400, rule.maxCharsPerFile));
      blocks.push(`\n---\nFILE: ${path}\n---\n${content}`);
    }
    if (rows.length > limitedRows.length) {
      blocks.push(`[Truncated: ${rows.length - limitedRows.length} more files under ${rule.pathPrefix}]`);
    }
  }

  return blocks.length > 1 ? blocks.join("\n") : null;
}

export async function loadDebateAgentMemoryInline(
  userId: string,
  debateAgentId: string,
  maxChars?: number | null,
  audit: DebateFileActivityAudit | null = null
) {
  const content = await readDebateAgentFile(userId, debateAgentId, MEMORY_SUMMARY_PATH);
  if (!content) return null;
  await recordImplicitFileReads({
    audit,
    scope: "agent",
    paths: [MEMORY_SUMMARY_PATH],
    targetDebateAgentId: debateAgentId
  });
  return `Long-term memory (this agent):\n\n${clipPromptInlineContent(content, maxChars ?? 10_000)}`;
}

export async function loadSharedFactsBoardInline(
  userId: string,
  debateId: string,
  maxChars?: number | null,
  audit: DebateFileActivityAudit | null = null
) {
  const content = await readDebateFile(userId, debateId, SHARED_FACTS_PATH);
  if (!content) return null;
  await recordImplicitFileReads({
    audit,
    scope: "debate",
    paths: [SHARED_FACTS_PATH]
  });
  return `Shared facts board (structured working notes):\n\n${clipPromptInlineContent(content, maxChars ?? 10_000)}`;
}

export async function loadDebateSegmentInline(userId: string, debateId: string, maxChars?: number | null) {
  const content = await readDebateFile(userId, debateId, CONTEXT_SEGMENT_PATH);
  if (!content) return null;
  return `Segment checkpoint (read-only; summary for continuing the debate):\n\n${clipPromptInlineContent(content, maxChars ?? 12_000)}`;
}

export async function loadDebateAgentSegmentInline(
  userId: string,
  debateId: string,
  debateAgentId: string,
  maxChars?: number | null,
  audit: DebateFileActivityAudit | null = null
) {
  const agentContent = await readDebateAgentFile(userId, debateAgentId, CONTEXT_SEGMENT_PATH);
  const content = agentContent ?? (await readDebateFile(userId, debateId, CONTEXT_SEGMENT_PATH));
  if (!content) return null;
  await recordImplicitFileReads({
    audit,
    scope: agentContent ? "agent" : "debate",
    paths: [CONTEXT_SEGMENT_PATH],
    targetDebateAgentId: agentContent ? debateAgentId : null
  });
  return `Segment checkpoint (read-only; this seat only):\n\n${clipPromptInlineContent(content, maxChars ?? 12_000)}`;
}

export async function loadContextWindowMinTurnNumber(userId: string, debateId: string) {
  const raw = await readDebateFile(userId, debateId, CONTEXT_WINDOW_PATH);
  if (!raw) return null;
  const parsed = safeJsonParse<{ minTurnNumber?: unknown; enabled?: unknown }>(raw);
  if (!parsed) return null;
  const enabled = parsed.enabled === undefined ? true : Boolean(parsed.enabled);
  if (!enabled) return null;
  const minTurnNumber = typeof parsed.minTurnNumber === "number" ? parsed.minTurnNumber : Number(parsed.minTurnNumber);
  if (!Number.isFinite(minTurnNumber) || minTurnNumber <= 1) return null;
  return Math.floor(minTurnNumber);
}

export async function loadContextWindowMinTurnNumberForDebateAgent(
  userId: string,
  debateId: string,
  debateAgentId: string
) {
  const agentRaw = await readDebateAgentFile(userId, debateAgentId, CONTEXT_WINDOW_PATH);
  const raw = agentRaw ?? (await readDebateFile(userId, debateId, CONTEXT_WINDOW_PATH));
  if (!raw) return null;
  const parsed = safeJsonParse<{ minTurnNumber?: unknown; enabled?: unknown }>(raw);
  if (!parsed) return null;
  const enabled = parsed.enabled === undefined ? true : Boolean(parsed.enabled);
  if (!enabled) return null;
  const minTurnNumber = typeof parsed.minTurnNumber === "number" ? parsed.minTurnNumber : Number(parsed.minTurnNumber);
  if (!Number.isFinite(minTurnNumber) || minTurnNumber <= 1) return null;
  return Math.floor(minTurnNumber);
}

export type RecentTurnRow = {
  turnNumber: number;
  content: string;
  createdAt: string;
  speakerName: string | null;
  seatNumber: number | null;
};

export function formatRecentTurnsInline(rows: RecentTurnRow[], participantCount: number, minTurnNumber?: number | null) {
  if (rows.length <= 0) return null;
  const min = typeof minTurnNumber === "number" && Number.isFinite(minTurnNumber) ? Math.floor(minTurnNumber) : null;
  const parts: string[] = [];
  parts.push(
    [
      "Recent messages context (read-only):",
      ...(min ? [`- Window: Turn >= ${min}.`] : []),
      `- Seats: ${participantCount}. 1 round = ${participantCount} messages (each seat speaks once).`,
      "- Turn #N below means the N-th message overall, NOT the number of seats/legislators."
    ].join("\n")
  );
  for (const row of rows) {
    const speakerName = String(row.speakerName ?? "Unknown");
    const seatLabel = row.seatNumber === null ? "" : `Seat-${Number(row.seatNumber)} · `;
    const header = `\n\n---\nTurn #${row.turnNumber} · ${seatLabel}${speakerName} · ${row.createdAt}\n---\n`;
    parts.push(header + row.content);
  }
  return parts.join("");
}

export async function loadRecentTurnRows(
  userId: string,
  debateId: string,
  participantCount: number,
  limit: number,
  minTurnNumber?: number | null
) {
  try {
    const min = typeof minTurnNumber === "number" && Number.isFinite(minTurnNumber) ? Math.floor(minTurnNumber) : null;
    const db = await ensureDb();
    let queryBuilder = db
      .selectFrom("debate_turns as t")
      .innerJoin("ai_agents as a", "a.id", "t.ai_agent_id")
      .leftJoin("debate_agents as da", "da.id", "t.debate_agent_id")
      .innerJoin("debates as d", "d.id", "t.debate_id")
      .select([
        "t.turn_number",
        "t.content",
        "t.created_at",
        sql<string>`coalesce(da.display_name, a.name)`.as("speaker_name"),
        "t.seat_number as seat_number"
      ])
      .where("t.debate_id", "=", debateId)
      .where("d.user_id", "=", userId);
    if (min !== null) {
      queryBuilder = queryBuilder.where("t.turn_number", ">=", min);
    }
    const result = await queryBuilder
      .orderBy("t.turn_number", "desc")
      .limit(Math.max(0, Math.floor(limit)))
      .execute();

    if (result.length === 0) return [];

    return [...result].reverse().map((row) => ({
      turnNumber: Number(row.turn_number),
      content: String(row.content ?? ""),
      createdAt: String(row.created_at ?? ""),
      speakerName: row.speaker_name === null ? null : String(row.speaker_name),
      seatNumber: row.seat_number === null ? null : Number(row.seat_number)
    }));
  } catch {
    return [];
  }
}

export async function loadDebateSeatInline(userId: string, debateId: string, debateAgentId: string) {
  try {
    const db = await ensureDb();
    const result = await db
      .selectFrom("debate_agents as da")
      .innerJoin("debates as d", "d.id", "da.debate_id")
      .select(["da.turn_order", "da.display_name"])
      .where("da.debate_id", "=", debateId)
      .where("da.id", "=", debateAgentId)
      .where("d.user_id", "=", userId)
      .limit(1)
      .executeTakeFirst();
    if (!result) return null;
    const seatNumber = Number(result.turn_order ?? 0);
    const displayName = String(result.display_name ?? "");
    if (!Number.isFinite(seatNumber) || seatNumber <= 0) return null;
    const namePart = displayName ? ` (${displayName})` : "";
    return `Identity (read-only):\n- You are Seat-${seatNumber}${namePart}.`;
  } catch {
    return null;
  }
}

export async function loadDebateParticipantsInline(userId: string, debateId: string) {
  try {
    const db = await ensureDb();
    const result = await db
      .selectFrom("debate_agents as da")
      .innerJoin("debates as d", "d.id", "da.debate_id")
      .select(["da.turn_order", "da.display_name as display_name"])
      .where("da.debate_id", "=", debateId)
      .where("d.user_id", "=", userId)
      .orderBy("da.turn_order", "asc")
      .execute();
    if (result.length <= 0) return null;
    const lines = result.map(
      (row) => `- Seat-${Number(row.turn_order)}: ${String(row.display_name ?? `Seat-${Number(row.turn_order)}`)}`
    );
    return [
      "Seats (read-only):",
      ...lines
    ].join("\n");
  } catch {
    return null;
  }
}

export function buildWorkflowPhaseInline(input: {
  workflow: NormalizedDebateWorkflow | null;
  debate: DebateRecord;
  roundNumber: number;
  openVote: OfficialVote | null;
  latestVote?: OfficialVote | null;
}) {
  const isLightweightWorkflow =
    input.workflow?.enabled &&
    input.workflow.completion.mode === "consensus_only" &&
    input.workflow.deliverables.requiredFiles.length === 0 &&
    !input.workflow.ideaBank.rawIdeaBankPath &&
    !Object.values(input.workflow.ideaBank.derivedFiles).some(Boolean) &&
    input.workflow.contextAccess.alwaysRead.length === 0 &&
    input.workflow.contextAccess.readWhenNeeded.length === 0 &&
    input.workflow.contextAccess.unlockAfterPhase.length === 0 &&
    input.workflow.phaseMachine.phases.length === 1 &&
    input.workflow.phaseMachine.phases[0]?.kind === "deliberation";
  const current = resolveCurrentWorkflowPhase({
    workflow: input.workflow,
    roundNumber: input.roundNumber,
    openVote: input.openVote,
    latestVote: input.latestVote,
    persistedPhaseKind: input.debate.workflowPhaseKind
  });
  if (!current) return null;
  if (isLightweightWorkflow) {
    const lines = ["Discussion guidance (IMPORTANT):"];
    if (current.description) lines.push(`- Focus: ${current.description}`);
    if (current.injectedPrompt) {
      lines.push("- Discussion prompt:");
      lines.push(current.injectedPrompt);
    }
    lines.push(`- Earliest completion round: ${getWorkflowEarliestCompletionRound(input.workflow)}`);
    lines.push(`- Completion mode: ${getWorkflowCompletionMode(input.workflow)}`);
    return lines.join("\n");
  }
  const lines = [
    "Rule guidance (IMPORTANT):",
    `- Current phase: ${current.title}`,
    `- Phase kind: ${current.kind}`
  ];
  if (current.description) lines.push(`- Goal: ${current.description}`);
  if (current.injectedPrompt) {
    lines.push("- Phase-specific prompt:");
    lines.push(current.injectedPrompt);
  }
  if (current.minRounds) lines.push(`- Minimum rounds for this phase: ${current.minRounds}`);
  if (hasWorkflowPhase(input.workflow, "finalization_vote")) {
    lines.push(`- Earliest consolidation vote round: ${getWorkflowEarliestFinalizationVoteRound(input.workflow)}`);
  } else {
    lines.push("- Consolidation vote phase: not configured");
  }
  if (hasWorkflowPhase(input.workflow, "finalization")) {
    lines.push(`- Earliest consolidation round: ${getWorkflowEarliestFinalizationRound(input.workflow)}`);
  } else {
    lines.push("- Consolidation phase: not configured");
  }
  lines.push(`- Earliest completion round: ${getWorkflowEarliestCompletionRound(input.workflow)}`);
  lines.push(`- Completion mode: ${getWorkflowCompletionMode(input.workflow)}`);
  const allPhases = input.workflow?.phaseMachine.phases ?? [];
  if (allPhases.length > 0) {
    lines.push("- Full phase machine:");
    for (const phase of allPhases) {
      lines.push(
        `  - ${phase.title}${phase.description ? `: ${phase.description}` : ""}${phase.minRounds ? ` (minRounds=${phase.minRounds})` : ""}`
      );
    }
  }
  const requiredDeliverables = input.workflow?.deliverables.requiredFiles ?? [];
  if (requiredDeliverables.length > 0 && requiresWorkflowOutputsForCompletion(input.workflow)) {
    lines.push("- Completion gate: this workflow requires the listed deliverables before the debate can finish.");
  }
  return lines.join("\n");
}

export async function loadWorkflowIdeaBankInline(input: {
  workflow: NormalizedDebateWorkflow | null;
  phaseKind: "analysis" | "deliberation" | "finalization_vote" | "finalization" | null;
  userId: string;
  debateId: string;
}) {
  if (!input.workflow?.enabled || !input.phaseKind) return null;
  if (input.phaseKind === "analysis") return null;

  const lines: string[] = ["Idea bank routing (IMPORTANT):"];
  const rawPath = input.workflow.ideaBank.rawIdeaBankPath;
  const derived = input.workflow.ideaBank.derivedFiles;

  if (input.phaseKind === "deliberation") {
    if (rawPath) {
      lines.push(`- Raw idea bank path: ${rawPath} (read-only source material; do not overwrite this file).`);
      const rawContent = (await readDebateFile(input.userId, input.debateId, rawPath)) ?? "";
      if (rawContent.trim()) {
        lines.push("", `## Raw idea bank · ${rawPath}`, clipPromptInlineContent(rawContent.trim()));
      }
    }
    lines.push("- In this phase, you must collaboratively filter, merge, reject, regroup, and invent ideas.");
    lines.push("- Write the screening results into derived idea files instead of mutating the raw idea bank.");
    const derivedTargets = [
      derived.selectedSTierPath,
      derived.selectedATierPath,
      derived.rejectedOrMergedPath,
      derived.eventMappingsPath,
      derived.newlyInventedIdeasPath
    ].filter((item): item is string => Boolean(item));
    if (derivedTargets.length > 0) {
      lines.push(`- Preferred derived files: ${derivedTargets.join(" / ")}`);
    }
  } else if (input.phaseKind === "finalization_vote") {
    if (rawPath) {
      lines.push(`- Raw idea bank path: ${rawPath} (do not reopen the raw bank unless you must verify unresolved risk).`);
    }
    lines.push("- In this phase, do not expand the scope again by default.");
    lines.push("- Focus on whether the debate is ready to enter consolidation, what blockers remain, and whether the required outputs can now be unified.");
  } else if (input.phaseKind === "finalization") {
    if (rawPath) {
      lines.push(`- Raw idea bank path: ${rawPath} (do not return to this file by default in finalization).`);
    }
    lines.push("- In this phase, use the idea screening results as the primary source of truth.");
  }

  const derivedReadOrder =
    input.phaseKind === "deliberation"
      ? [
          derived.selectedSTierPath,
          derived.selectedATierPath,
          derived.rejectedOrMergedPath,
          derived.eventMappingsPath,
          derived.newlyInventedIdeasPath
        ]
      : [derived.selectedSTierPath, derived.eventMappingsPath, derived.selectedATierPath];

  for (const path of derivedReadOrder) {
    if (!path) continue;
    const content = (await readDebateFile(input.userId, input.debateId, path)) ?? "";
    if (!content.trim()) continue;
    lines.push("", `## Idea result file · ${path}`, clipPromptInlineContent(content.trim(), 12_000));
  }

  return lines.length > 1 ? lines.join("\n") : null;
}

export function rotateOrder<T>(items: T[], offset: number) {
  const n = items.length;
  if (n <= 1) return items.slice();
  const k = ((offset % n) + n) % n;
  if (k === 0) return items.slice();
  return [...items.slice(k), ...items.slice(0, k)];
}

export async function toolListFiles(
  userId: string,
  debateAgentId: string,
  agentId: string,
  prefix?: string,
  audit:
    | {
        debateId: string;
        turnNumber: number;
        roundNumber: number;
        now: string;
      }
    | null = null,
  policy:
    | {
        workflow: NormalizedDebateWorkflow | null;
        currentPhaseKind: WorkflowPhaseKind | null | undefined;
      }
    | null = null
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
  audit:
    | {
        debateId: string;
        turnNumber: number;
        roundNumber: number;
        now: string;
      }
    | null = null,
  policy:
    | {
        workflow: NormalizedDebateWorkflow | null;
        currentPhaseKind: WorkflowPhaseKind | null | undefined;
      }
    | null = null
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
  audit:
    | {
        debateId: string;
        turnNumber: number;
        roundNumber: number;
        now: string;
      }
    | null,
  policy:
    | {
        workflow: NormalizedDebateWorkflow | null;
        currentPhaseKind: WorkflowPhaseKind | null | undefined;
      }
    | null = null
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
  policy: {
    workflow: NormalizedDebateWorkflow | null;
    currentPhaseKind: WorkflowPhaseKind | null | undefined;
  }
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
  audit:
    | {
        debateId: string;
        turnNumber: number;
        roundNumber: number;
        now: string;
      }
    | null
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
  audit:
    | {
        debateId: string;
        turnNumber: number;
        roundNumber: number;
        now: string;
      }
    | null = null,
  policy:
    | {
        workflow: NormalizedDebateWorkflow | null;
        currentPhaseKind: WorkflowPhaseKind | null | undefined;
      }
    | null = null
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
  audit:
    | {
        debateId: string;
        turnNumber: number;
        roundNumber: number;
        now: string;
      }
    | null = null,
  policy:
    | {
        workflow: NormalizedDebateWorkflow | null;
        currentPhaseKind: WorkflowPhaseKind | null | undefined;
      }
    | null = null
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
  const result = await db.executeQuery<{ content: string; updated_at: string; version: number }>(sql`
    select content, updated_at, version
      from debate_files
     where debate_id = ${debateId}
       and path = ${path}
     limit 1
     for update
  `.compile(db));
  if ((result.rows.length ?? 0) !== 1) return null;
  return {
    content: String(result.rows[0].content ?? ""),
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
    mode: writeResult.mode
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
  eventAgentName: string,
  baseRoleName: string
) {
  // NOTE: keep provider orchestration lazily loaded until shared runtime helpers
  // are fully extracted from this file; this avoids a runtime import cycle.
  const { callProvider: callProviderFromProviderOrchestration } = await import("@/lib/runtime/provider-orchestration");
  return callProviderFromProviderOrchestration(
    debate,
    agent,
    messageNumber,
    roundNumber,
    participantCount,
    userId,
    debateAgentId,
    eventAgentName,
    baseRoleName
  );
}

export function normalizeDebateRow(row: Record<string, unknown>): DebateRecord {
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

export function normalizeAgentRow(row: Record<string, unknown>): AgentRecord {
  const contextLengthRaw = row.context_length ?? row.contextLength ?? null;
  const contextLength = contextLengthRaw === null ? null : Number(contextLengthRaw);
  const maxInputTokensRaw = row.max_input_tokens ?? row.maxInputTokens ?? null;
  const maxInputTokens = maxInputTokensRaw === null ? null : Number(maxInputTokensRaw);
  const maxOutputTokensRaw = row.max_output_tokens ?? row.maxOutputTokens ?? null;
  const maxOutputTokens = maxOutputTokensRaw === null ? null : Number(maxOutputTokensRaw);
  return {
    id: String(row.id),
    userId: String(row.user_id),
    name: String(row.name),
    provider: row.provider as AgentRecord["provider"],
    model: String(row.model),
    contextLength:
      contextLength !== null && Number.isFinite(contextLength) && contextLength > 0 ? Math.floor(contextLength) : null,
    maxInputTokens:
      maxInputTokens !== null && Number.isFinite(maxInputTokens) && maxInputTokens > 0
        ? Math.floor(maxInputTokens)
        : null,
    maxOutputTokens:
      maxOutputTokens !== null && Number.isFinite(maxOutputTokens) && maxOutputTokens > 0
        ? Math.floor(maxOutputTokens)
        : null,
    baseUrl: String(row.base_url),
    apiKeyEncrypted: String(row.api_key_encrypted),
    apiKeyMasked: String(row.api_key_masked),
    isActive: Boolean(row.is_active),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

export async function finishDebate(
  id: string,
  status: "completed" | "stopped" | "failed",
  reason?: string,
  options?: {
    phase?: Pick<DebateRecord, "workflowPhaseKind" | "workflowPhaseTitle" | "workflowPhaseRound"> | null;
    lastErrorCode?: string | null;
    lastErrorMessage?: string | null;
  }
) {
  const db = await ensureDb();
  const now = new Date().toISOString();
  await db.executeQuery(sql`
    update debates
        set status = ${status},
            finished_at = ${now},
            stopped_reason = ${reason ?? null},
            workflow_phase_kind = ${options?.phase?.workflowPhaseKind ?? null},
            workflow_phase_title = ${options?.phase?.workflowPhaseTitle ?? null},
            workflow_phase_round = ${options?.phase?.workflowPhaseRound ?? null},
            runtime_notice_kind = null,
            runtime_notice_message = null,
            runtime_notice_at = null,
            last_error_code = coalesce(${options?.lastErrorCode ?? null}, last_error_code),
            last_error_message = coalesce(${options?.lastErrorMessage ?? null}, last_error_message),
            updated_at = ${now}
      where id = ${id}
  `.compile(db));
}

export async function setDebateRuntimeNotice(
  id: string,
  notice: Pick<DebateRecord, "runtimeNoticeKind" | "runtimeNoticeMessage" | "runtimeNoticeAt"> | null
) {
  const db = await ensureDb();
  await db.executeQuery(sql`
    update debates
        set runtime_notice_kind = ${notice?.runtimeNoticeKind ?? null},
            runtime_notice_message = ${notice?.runtimeNoticeMessage ?? null},
            runtime_notice_at = ${notice?.runtimeNoticeAt ?? null}
      where id = ${id}
  `.compile(db));
}

export function isRecoverableRuntimeInterruption(details: { code?: string | null; message?: string | null }) {
  const code = String(details.code ?? "").toUpperCase();
  const message = String(details.message ?? "").toLowerCase();
  if (code === "AI_NETWORK_ERROR") return true;
  const patterns = [
    "fetch failed",
    "network",
    "socket hang up",
    "econnreset",
    "etimedout",
    "timeout",
    "timed out",
    "aborted",
    "aborterror",
    "terminated",
    "eai_again",
    "enotfound",
    "connection closed",
    "other side closed",
    "client network socket disconnected"
  ];
  return patterns.some((pattern) => message.includes(pattern));
}

export async function pauseDebateAfterRuntimeInterruption(
  id: string,
  reason: string,
  options?: {
    phase?: Pick<DebateRecord, "workflowPhaseKind" | "workflowPhaseTitle" | "workflowPhaseRound"> | null;
    lastErrorCode?: string | null;
    lastErrorMessage?: string | null;
  }
) {
  const now = new Date().toISOString();
  const db = await ensureDb();
  await db.executeQuery(sql`
    update debates
        set status = case
              when status = 'running' then 'paused'
              else status
            end,
            stopped_reason = ${reason},
            workflow_phase_kind = ${options?.phase?.workflowPhaseKind ?? null},
            workflow_phase_title = ${options?.phase?.workflowPhaseTitle ?? null},
            workflow_phase_round = ${options?.phase?.workflowPhaseRound ?? null},
            runtime_notice_kind = ${"interrupted"},
            runtime_notice_message = ${"检测到运行时中断或网络断开，系统已自动暂停这场辩论；恢复设备或网络后可继续运行"},
            runtime_notice_at = ${now},
            last_error_code = coalesce(${options?.lastErrorCode ?? null}, last_error_code),
            last_error_message = coalesce(${options?.lastErrorMessage ?? null}, last_error_message),
            updated_at = ${now}
      where id = ${id}
  `.compile(db));
}

export async function persistDebatePhaseSnapshot(
  id: string,
  phase: Pick<DebateRecord, "workflowPhaseKind" | "workflowPhaseTitle" | "workflowPhaseRound"> | null
) {
  const db = await ensureDb();
  await db.executeQuery(sql`
    update debates
        set workflow_phase_kind = ${phase?.workflowPhaseKind ?? null},
            workflow_phase_title = ${phase?.workflowPhaseTitle ?? null},
            workflow_phase_round = ${phase?.workflowPhaseRound ?? null}
      where id = ${id}
  `.compile(db));
}

export async function startAutoSegmentAtBoundary(input: {
  userId: string;
  debateId: string;
  participantCount: number;
  currentTurn: number;
  question: string;
  reason: string;
  now: string;
}) {
  const checkpointPrefix = "context/checkpoints/seg-";
  const pad = (n: number) => String(n).padStart(4, "0");

  const db = await ensureDb();
  const participants = await db
    .selectFrom("debate_agents as da")
    .innerJoin("ai_agents as a", "a.id", "da.ai_agent_id")
    .innerJoin("debates as d", "d.id", "da.debate_id")
    .select(["da.turn_order", "a.name as agent_name"])
    .where("da.debate_id", "=", input.debateId)
    .where("d.user_id", "=", input.userId)
    .orderBy("da.turn_order", "asc")
    .execute();

  const existing = await db
    .selectFrom("debate_files")
    .select("path")
    .where("debate_id", "=", input.debateId)
    .where("path", "like", `${checkpointPrefix}%`)
    .orderBy("path", "asc")
    .limit(200)
    .execute();
  const nextIndex = existing.length + 1;
  const seg = `seg-${pad(nextIndex)}`;
  const checkpointPath = `${checkpointPrefix}${pad(nextIndex)}.md`;

  const completedRounds = Math.floor(input.currentTurn / Math.max(1, input.participantCount));
  const minTurnNumber = input.currentTurn + 1;

  const workflowRaw = await readDebateFile(input.userId, input.debateId, WORKFLOW_PATH);
  const workflow = safeParseWorkflowJson(workflowRaw);
  const officialDecision = (await readDebateFile(input.userId, input.debateId, VOTE_DECISION_PATH)) ?? "";

  const lines: string[] = [];
  lines.push(`# Segment Checkpoint · ${seg}`);
  lines.push("");
  lines.push(`- At: ${input.now}`);
  lines.push(`- Completed rounds: ${completedRounds}`);
  lines.push(`- Current turn: ${input.currentTurn}`);
  lines.push(`- Context window reset: next model calls will inject recent turns from Turn >= ${minTurnNumber}.`);
  if (input.reason) lines.push(`- Reason: ${input.reason}`);
  lines.push("");
  lines.push("## Question");
  lines.push(input.question ? input.question : "(empty)");
  lines.push("");
  lines.push("## Seats (current order)");
  for (const row of participants) {
    lines.push(`- Seat-${Number(row.turn_order)}: ${String(row.agent_name ?? "Unknown")}`);
  }

  lines.push("");
  appendWorkflowSummaryLines(lines, workflow);

  if (officialDecision.trim()) {
    lines.push("");
    lines.push("## Latest official decision");
    lines.push(officialDecision.trim());
  }

  lines.push("");
  lines.push("## Notes");
  lines.push("- This checkpoint is injected to all seats as a shared segment context.");
  lines.push("- Long-term memory (per seat) and shared facts (if enabled) are still used.");

  const checkpointContent = lines.join("\n").trim() + "\n";

  await upsertDebateFile(
    input.debateId,
    CONTEXT_WINDOW_PATH,
    JSON.stringify({ enabled: true, minTurnNumber, at: input.now, seg, reason: input.reason }, null, 2),
    input.now
  );
  await upsertDebateFile(input.debateId, CONTEXT_SEGMENT_PATH, checkpointContent, input.now);
  await upsertDebateFile(input.debateId, checkpointPath, checkpointContent, input.now);
  try {
    await indexDebateContextChunk({
      userId: input.userId,
      debateId: input.debateId,
      chunkKey: `segment:shared:${seg}`,
      sourceType: "segment",
      sourcePath: CONTEXT_SEGMENT_PATH,
      segmentTag: seg,
      content: checkpointContent,
      now: input.now
    });
  } catch {
    // retrieval indexing is best-effort
  }
}

export async function startAutoSegmentForDebateAgentAtBoundary(input: {
  userId: string;
  debateId: string;
  debateAgentId: string;
  participantCount: number;
  currentTurn: number;
  question: string;
  reason: string;
  now: string;
}) {
  const checkpointPrefix = "context/checkpoints/seg-";
  const pad = (n: number) => String(n).padStart(4, "0");

  const db = await ensureDb();
  const participants = await db
    .selectFrom("debate_agents as da")
    .innerJoin("ai_agents as a", "a.id", "da.ai_agent_id")
    .innerJoin("debates as d", "d.id", "da.debate_id")
    .select(["da.turn_order", "a.name as agent_name"])
    .where("da.debate_id", "=", input.debateId)
    .where("d.user_id", "=", input.userId)
    .orderBy("da.turn_order", "asc")
    .execute();

  let existingCount = 0;
  try {
    const existing = await db
      .selectFrom("debate_agent_files as f")
      .select("f.path")
      .where("f.debate_agent_id", "=", input.debateAgentId)
      .where("f.path", "like", `${checkpointPrefix}%`)
      .orderBy("f.path", "asc")
      .limit(200)
      .execute();
    existingCount = existing.length;
  } catch (error) {
    if (getPgErrorCode(error) !== "42P01") throw error;
    existingCount = 0;
  }

  const nextIndex = existingCount + 1;
  const seg = `seg-${pad(nextIndex)}`;
  const checkpointPath = `${checkpointPrefix}${pad(nextIndex)}.md`;

  const completedRounds = Math.floor(input.currentTurn / Math.max(1, input.participantCount));
  const minTurnNumber = input.currentTurn + 1;

  const workflowRaw = await readDebateFile(input.userId, input.debateId, WORKFLOW_PATH);
  const workflow = safeParseWorkflowJson(workflowRaw);
  const officialDecision = (await readDebateFile(input.userId, input.debateId, VOTE_DECISION_PATH)) ?? "";

  const lines: string[] = [];
  lines.push(`# Segment Checkpoint · ${seg}`);
  lines.push("");
  lines.push(`- At: ${input.now}`);
  lines.push(`- Completed rounds: ${completedRounds}`);
  lines.push(`- Current turn: ${input.currentTurn}`);
  lines.push(`- Context window reset (this seat only): next model calls will inject recent turns from Turn >= ${minTurnNumber}.`);
  if (input.reason) lines.push(`- Reason: ${input.reason}`);
  lines.push("");
  lines.push("## Question");
  lines.push(input.question ? input.question : "(empty)");
  lines.push("");
  lines.push("## Seats (current order)");
  for (const row of participants) {
    lines.push(`- Seat-${Number(row.turn_order)}: ${String(row.agent_name ?? "Unknown")}`);
  }

  lines.push("");
  appendWorkflowSummaryLines(lines, workflow);

  if (officialDecision.trim()) {
    lines.push("");
    lines.push("## Latest official decision");
    lines.push(officialDecision.trim());
  }

  lines.push("");
  lines.push("## Notes");
  lines.push("- This checkpoint is injected only to this seat.");
  lines.push("- Long-term memory (per seat) and shared facts (if enabled) are still used.");

  const checkpointContent = lines.join("\n").trim() + "\n";

  await upsertDebateAgentFile(
    input.debateAgentId,
    CONTEXT_WINDOW_PATH,
    JSON.stringify({ enabled: true, minTurnNumber, at: input.now, seg, reason: input.reason }, null, 2),
    input.now
  );
  await upsertDebateAgentFile(input.debateAgentId, CONTEXT_SEGMENT_PATH, checkpointContent, input.now);
  await upsertDebateAgentFile(input.debateAgentId, checkpointPath, checkpointContent, input.now);
  try {
    await indexDebateContextChunk({
      userId: input.userId,
      debateId: input.debateId,
      debateAgentId: input.debateAgentId,
      chunkKey: `segment:${input.debateAgentId}:${seg}`,
      sourceType: "segment",
      sourcePath: CONTEXT_SEGMENT_PATH,
      segmentTag: seg,
      content: checkpointContent,
      now: input.now
    });
  } catch {
    // retrieval indexing is best-effort
  }
}

export async function maybeAutoCloseOpenVoteAtBoundary(input: {
  userId: string;
  debateId: string;
  participantCount: number;
  endedRound: number;
}) {
  const open = await loadOpenVote(input.userId, input.debateId);
  if (!open || open.status !== "open") return { ok: true, closed: false };

  const forcedOpen = Boolean(open.meta?.forcedOpen);

  // Default policy:
  // - If vote opened at Round N (possibly mid-round), close at end of Round >= N+1.
  // Forced policy (auto-open at boundary):
  // - Close at end of Round >= N (i.e., one full round to vote).
  if (!forcedOpen && input.endedRound <= open.roundNumber) return { ok: true, closed: false };
  if (forcedOpen && input.endedRound < open.roundNumber) return { ok: true, closed: false };

  const result = await toolVoteClose({
    userId: input.userId,
    debateId: input.debateId,
    participantCount: input.participantCount
  });
  const reopened = Boolean((result as { reopened?: unknown }).reopened);
  const closed = Boolean((result as { closed?: unknown }).closed);
  return { ok: true, closed, reopened, result };
}

export async function maybeAutoOpenVoteAtBoundaryUsingWorkflow(input: {
  userId: string;
  debateId: string;
  participantCount: number;
  endedRound: number;
  skipFinalizationAutoOpen?: boolean;
}) {
  if (input.participantCount <= 0) return { ok: true, opened: false };

  const latestVote = await loadLatestVote(input.userId, input.debateId);
  if (latestVote?.status === "open") return { ok: true, opened: false, open: latestVote };

  const workflow = await loadDebateWorkflow(input.userId, input.debateId);
  const workflowEnabled = Boolean(workflow?.enabled);
  if (!workflowEnabled) return { ok: true, opened: false };

  const nextRoundNumber = input.endedRound + 1;
  const finalizationRules = workflow?.phaseMachine.transitionRules.finalization;
  const finalizationEntryRound = getWorkflowEarliestFinalizationVoteRound(workflow);
  const finalizationVoteTitle = getWorkflowPhaseByKind(workflow, "finalization_vote")?.title ?? "Consolidation vote";
  if (
    workflowEnabled &&
    !input.skipFinalizationAutoOpen &&
    finalizationRules?.autoOpenVote &&
    nextRoundNumber === finalizationEntryRound
  ) {
    const debateState = await loadDebatePhaseState({ userId: input.userId, debateId: input.debateId });
    if (debateState.workflowPhaseKind !== "finalization") {
      const result = await toolVoteOpen({
        userId: input.userId,
        debateId: input.debateId,
        participantCount: input.participantCount,
        roundNumber: nextRoundNumber,
        title: `Round ${nextRoundNumber} · ${finalizationVoteTitle}`,
        kind: "finalization",
        bypassStartRound: false,
        meta: { forcedOpen: true, reason: `after_round_${input.endedRound}` }
      });
      return { ok: true, opened: Boolean((result as { ok?: unknown }).ok), result };
    }
  }

  if (
    workflowEnabled &&
    !input.skipFinalizationAutoOpen &&
    finalizationRules?.autoOpenVote &&
    finalizationRules?.reopenUntilPassed &&
    latestVote?.status === "closed" &&
    latestVote.kind === "finalization" &&
    !Boolean((latestVote.result as any)?.passed)
  ) {
    const discussionRoundsBetweenVotes = Math.max(1, Math.floor(Number(finalizationRules.discussionRoundsBetweenVotes) || 1));
    const nextRoundNumber = input.endedRound + 1;
    const targetVoteRound = latestVote.roundNumber + discussionRoundsBetweenVotes + 1;
    if (nextRoundNumber === targetVoteRound) {
      const attempt = Math.max(1, Math.floor(Number(latestVote.meta?.attempt) || 1)) + 1;
      const result = await toolVoteOpen({
        userId: input.userId,
        debateId: input.debateId,
        participantCount: input.participantCount,
        roundNumber: nextRoundNumber,
        title: `Round ${nextRoundNumber} · ${finalizationVoteTitle} retry`,
        kind: "finalization",
        bypassStartRound: false,
        meta: {
          forcedOpen: true,
          reason: `retry_after_round_${input.endedRound}`,
          attempt,
          previousFailedRound: latestVote.roundNumber
        }
      });
      return { ok: true, opened: Boolean((result as { ok?: unknown }).ok), result };
    }
  }

  return { ok: true, opened: false };
}

export function buildFallbackVoteAnnouncement(input: {
  debateQuestion: string;
  participantsInline: string | null;
  closed: ClosedOfficialVote;
  decisionJson: Record<string, unknown> | null;
}) {
  const kind = input.closed.kind;
  const result = input.closed.result ?? {};
  const winner = typeof (result as any)?.winner === "string" ? String((result as any).winner) : null;
  const passed = Boolean((result as any)?.passed);
  return [
    `# 第 ${input.closed.roundNumber} 轮 · 投票结果公告`,
    "",
    `- 标题：${input.closed.title}`,
    `- 类型：${kind}`,
    "",
    "## 结果",
    kind === "finalization"
      ? passed
        ? "- Consolidation vote passed"
        : "- Consolidation vote not passed"
      : kind === "custom"
        ? winner
          ? `- Winner：${winner}`
          : "- Winner：未能选出"
        : "- 结果：未提供",
    "",
    ...(input.participantsInline ? [input.participantsInline, ""] : []),
    ...(input.decisionJson ? ["## 结论数据（JSON）", "```json", JSON.stringify(input.decisionJson, null, 2), "```", ""] : []),
    "请各席位在下一轮以官方投票结果为准继续推进。"
  ].join("\n").trim();
}

export async function maybeGenerateVoteAnnouncementWithSeat1(input: {
  userId: string;
  debate: DebateRecord;
  participantCount: number;
  closed: OfficialVote;
}) {
  if (!input.closed || input.closed.status !== "closed") return { ok: true, generated: false };

  const roundNumber = input.closed.roundNumber;
  const roundPath = `${VOTE_ANNOUNCEMENT_PREFIX}${roundNumber}.md`;
  const existing = await readDebateFile(input.userId, input.debate.id, roundPath);
  if (existing && existing.trim()) return { ok: true, generated: false, reason: "already_exists" };

  const workflow = await loadDebateWorkflow(input.userId, input.debate.id);
  const participantsInline = await loadDebateParticipantsInline(input.userId, input.debate.id);
  const decisionJsonRaw = await readDebateFile(input.userId, input.debate.id, VOTE_DECISION_JSON_PATH);
  const decisionJson = decisionJsonRaw ? (safeJsonParse<Record<string, unknown>>(decisionJsonRaw) ?? null) : null;

  let announcerSeatNumber = 1;
  const announcerRoleLabel = "Host";
  const fallbackAnnouncerSeatNumber = 1;

  const db = await ensureDb();
  const announcer = await db
    .selectFrom("debate_agents as da")
    .innerJoin("ai_agents as a", "a.id", "da.ai_agent_id")
    .innerJoin("debates as d", "d.id", "da.debate_id")
    .selectAll("a")
    .select("da.id as debate_agent_id")
    .where("da.debate_id", "=", input.debate.id)
    .where("d.user_id", "=", input.userId)
    .where("da.turn_order", "=", announcerSeatNumber)
    .limit(1)
    .executeTakeFirst();

  let announcerRow: Record<string, unknown> | null = announcer ? (announcer as Record<string, unknown>) : null;
  if (!announcerRow) {
    const fallbackSeat = await db
      .selectFrom("debate_agents as da")
      .innerJoin("ai_agents as a", "a.id", "da.ai_agent_id")
      .innerJoin("debates as d", "d.id", "da.debate_id")
      .selectAll("a")
      .select("da.id as debate_agent_id")
      .where("da.debate_id", "=", input.debate.id)
      .where("d.user_id", "=", input.userId)
      .where("da.turn_order", "=", fallbackAnnouncerSeatNumber)
      .limit(1)
      .executeTakeFirst();
    if (!fallbackSeat) {
      return { ok: false, generated: false, error: `Seat-${fallbackAnnouncerSeatNumber} agent not found.` };
    }
    announcerSeatNumber = fallbackAnnouncerSeatNumber;
    announcerRow = fallbackSeat as Record<string, unknown>;
  }

  const announcerDebateAgentId = String(announcerRow.debate_agent_id);
  const agent = normalizeAgentRow(announcerRow);
  const overrideSystemPrompt = await loadDebateAgentSystemPrompt(input.userId, announcerDebateAgentId);
  const apiKey = decryptSecret(agent.apiKeyEncrypted);
  const url = resolveChatUrl(agent);

  const proposalRound = Math.max(1, Math.floor(roundNumber) - 1);
  const proposalStart = 1;
  const proposalEnd = proposalRound * input.participantCount;
  const proposalTurns = await db
    .selectFrom("debate_turns as t")
    .innerJoin("ai_agents as a", "a.id", "t.ai_agent_id")
    .leftJoin("debate_agents as da", "da.id", "t.debate_agent_id")
    .innerJoin("debates as d", "d.id", "t.debate_id")
    .select([
      "t.turn_number",
      "t.seat_number",
      "t.content",
      sql<string>`coalesce(da.display_name, a.name)`.as("speaker_name")
    ])
    .where("t.debate_id", "=", input.debate.id)
    .where("d.user_id", "=", input.userId)
    .where("t.turn_number", ">=", proposalStart)
    .where("t.turn_number", "<=", proposalEnd)
    .orderBy("t.turn_number", "asc")
    .limit(200)
    .execute();
  const proposalInline =
    proposalTurns.length > 0
      ? [
          `Rounds 1-${proposalRound} (read-only; for vote context):`,
          ...proposalTurns.map((r) => {
            const tn = Number(r.turn_number);
            const seatNumber =
              r.seat_number === null ? ((tn - 1) % input.participantCount) + 1 : Number(r.seat_number);
            const seat = `Seat-${seatNumber}`;
            const name = String(r.speaker_name ?? "Unknown");
            const body = summarizeOptionText(String(r.content ?? ""), 260);
            return `- ${seat} · ${name}: ${body}`;
          })
        ].join("\n")
      : null;

  const system = [
    buildBaseSystemPrompt(agent, overrideSystemPrompt),
    `SYSTEM TASK: You are Seat-${announcerSeatNumber}${announcerRoleLabel ? ` (${announcerRoleLabel})` : ""} acting as the official vote announcer.`,
    "Output only Markdown for humans; no tool calls."
  ].join("\n\n");

  const userPrompt = [
    `Debate question:\n${input.debate.question}`,
    participantsInline ? `\n\n${participantsInline}` : "",
    proposalInline ? `\n\n${proposalInline}` : "",
    `\n\nOfficial vote closed (JSON):\n\`\`\`json\n${JSON.stringify(input.closed, null, 2)}\n\`\`\``,
    decisionJson ? `\n\nOfficial decision data (JSON):\n\`\`\`json\n${JSON.stringify(decisionJson, null, 2)}\n\`\`\`` : "",
    "\n\nWrite a concise announcement that all seats must follow:",
    "- Title line with round number",
    "- 3-7 bullet points: winner, turnout, and next step",
    "- End with one short decision sentence starting with: OFFICIAL DECISION:"
  ]
    .join("")
    .trim();

  let content = "";
  try {
    if (agent.provider === "openai") {
      const res = await openAiChatOnce({
        url,
        apiKey,
        body: { model: agent.model, messages: [{ role: "system", content: system }, { role: "user", content: userPrompt }] }
      });
      content = String(res.content ?? "").trim();
    } else {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
          model: agent.model,
          max_tokens: 900,
          system,
          messages: [{ role: "user", content: userPrompt }]
        })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new AppError("AI_API_ERROR", 502, JSON.stringify(payload).slice(0, 400));
      }
      const blocks = (payload.content ?? []) as Array<Record<string, unknown>>;
      const texts = blocks
        .filter((b) => b.type === "text")
        .map((b) => String((b as { text?: unknown }).text ?? ""))
        .filter(Boolean);
      content = texts.join("\n").trim();
    }
  } catch (error) {
    await logRuntimeEvent("warn", "vote announcement generation failed", { error: describeRuntimeError(error) });
  }

  const now = new Date().toISOString();
  const finalContent =
    content ||
    buildFallbackVoteAnnouncement({
      debateQuestion: input.debate.question,
      participantsInline,
      closed: input.closed,
      decisionJson
    });

  await upsertDebateFile(input.debate.id, roundPath, finalContent.trim() + "\n", now);
  await upsertDebateFile(input.debate.id, VOTE_ANNOUNCEMENT_PATH, finalContent.trim() + "\n", now);
  return { ok: true, generated: true, path: roundPath };
}

export async function generateRoundSummary(input: {
  userId: string;
  debate: { id: string; question: string };
  debateAgentId: string;
  workflow: NormalizedDebateWorkflow | null;
  participantCount: number;
  endedRound: number;
  now: string;
  refreshFactsBoard?: boolean;
}) {
  const summarizer = getWorkflowSummarizerConfig(input.workflow);
  if (!summarizer || !summarizer.perRound) return { ok: false, skipped: true };

  const key = `round_summary:${input.endedRound}`;
  await updateSummaryJob(input.debate.id, {
    key,
    kind: "round_summary",
    label: `第 ${input.endedRound} 轮摘要`,
    roundNumber: input.endedRound,
    status: "running",
    message: "AI 总结中..."
  });

  try {
    const turnSummaries = await listRoundTurnSummaries({
      userId: input.userId,
      debateId: input.debate.id,
      workflow: input.workflow,
      roundNumber: input.endedRound,
      participantCount: input.participantCount
    });
    if (turnSummaries.length <= 0) {
      await updateSummaryJob(input.debate.id, {
        key,
        kind: "round_summary",
        label: `第 ${input.endedRound} 轮摘要`,
        roundNumber: input.endedRound,
        status: "failed",
        message: "缺少回摘要，无法生成轮摘要",
        errorReason: "missing_turn_summaries"
      });
      return { ok: false, error: "missing_turn_summaries" };
    }
    const content = await callWorkflowSummarizerMarkdown({
      userId: input.userId,
      debateId: input.debate.id,
      workflow: input.workflow,
      systemTask: `SYSTEM TASK: Summarize Round ${input.endedRound} using only the provided turn summaries.`,
      userPrompt: combineSummarizerPrompt(
        summarizer.prompts.roundSummary,
        buildDefaultRoundSummaryPrompt({
          debateQuestion: input.debate.question,
          roundNumber: input.endedRound,
          turnSummaries
        })
      ),
      maxTokens: 1600
    });
    const nextContent = content?.trim() ?? "";
    const invalidReason = validateSummarizerOutput("round_summary", nextContent);
    if (invalidReason) {
      await updateSummaryJob(input.debate.id, {
        key,
        kind: "round_summary",
        label: `第 ${input.endedRound} 轮摘要`,
        roundNumber: input.endedRound,
        status: "failed",
        message: "轮摘要生成失败",
        errorReason: invalidReason
      });
      return { ok: false, error: invalidReason };
    }
    const roundPath = getRoundSummaryPath(input.workflow, input.endedRound);
    await writeSummarizerDebateFile({
      userId: input.userId,
      debateId: input.debate.id,
      debateAgentId: input.debateAgentId,
      turnNumber: input.endedRound * Math.max(1, input.participantCount),
      roundNumber: input.endedRound,
      path: roundPath,
      content: `${nextContent}\n`,
      reason: "summarizer:round_summary",
      now: input.now
    });
    try {
      await indexDebateContextChunk({
        userId: input.userId,
        debateId: input.debate.id,
        chunkKey: `round_summary:${input.endedRound}`,
        sourceType: "round_summary",
        sourcePath: roundPath,
        roundNumber: input.endedRound,
        content: nextContent,
        now: input.now
      });
    } catch {
    }
    await updateSummaryJob(input.debate.id, {
      key,
      kind: "round_summary",
      label: `第 ${input.endedRound} 轮摘要`,
      roundNumber: input.endedRound,
      status: "completed",
      message: "轮摘要已完成"
    });
    return { ok: true, path: roundPath, content: nextContent };
  } catch (error) {
    const details = describeRuntimeError(error);
    await updateSummaryJob(input.debate.id, {
      key,
      kind: "round_summary",
      label: `第 ${input.endedRound} 轮摘要`,
      roundNumber: input.endedRound,
      status: "failed",
      message: "轮摘要生成失败",
      errorReason: truncateErrorMessage(String(details.message ?? "round_summary_failed"))
    });
    await logRuntimeEvent("warn", "round summary generation failed", { error: details });
    return { ok: false, error };
  }
}

async function enqueueTurnSummaryJob(input: {
  userId: string;
  debateId: string;
  debateAgentId: string;
  debateQuestion: string;
  workflow: NormalizedDebateWorkflow | null;
  roundNumber: number;
  turnNumber: number;
  agentName: string;
  content: string;
  refreshFactsBoard: boolean;
}) {
  const summarizer = getWorkflowSummarizerConfig(input.workflow);
  if (!summarizer || !summarizer.perTurn) return null;
  const record = await enqueueDebateSummaryJob({
    debateId: input.debateId,
    kind: "turn_summary",
    jobKey: `turn:${input.turnNumber}`,
    turnNumber: input.turnNumber,
    roundNumber: input.roundNumber,
    payload: {
      userId: input.userId,
      debateId: input.debateId,
      debateAgentId: input.debateAgentId,
      debateQuestion: input.debateQuestion,
      roundNumber: input.roundNumber,
      turnNumber: input.turnNumber,
      agentName: input.agentName,
      content: input.content,
      refreshFactsBoard: input.refreshFactsBoard
    }
  });
  await syncSummaryJobToLive(record, "AI 总结排队中...");
  return record;
}

async function enqueueRoundSummaryJob(input: {
  userId: string;
  debateId: string;
  debateAgentId: string;
  debateQuestion: string;
  workflow: NormalizedDebateWorkflow | null;
  participantCount: number;
  roundNumber: number;
  refreshFactsBoard: boolean;
}) {
  const summarizer = getWorkflowSummarizerConfig(input.workflow);
  if (!summarizer || !summarizer.perRound) return null;
  const dependsOnKeys = Array.from({ length: Math.max(0, input.participantCount) }, (_, index) => {
    const turnNumber = (input.roundNumber - 1) * input.participantCount + index + 1;
    return `turn:${turnNumber}`;
  });
  const blocked = dependsOnKeys.length > 0;
  const record = await enqueueDebateSummaryJob({
    debateId: input.debateId,
    kind: "round_summary",
    jobKey: `round:${input.roundNumber}`,
    roundNumber: input.roundNumber,
    dependsOnKeys,
    status: blocked ? "blocked" : "queued",
    payload: {
      userId: input.userId,
      debateId: input.debateId,
      debateAgentId: input.debateAgentId,
      debateQuestion: input.debateQuestion,
      endedRound: input.roundNumber,
      participantCount: input.participantCount,
      refreshFactsBoard: input.refreshFactsBoard
    }
  });
  await syncSummaryJobToLive(
    record,
    blocked ? "等待本轮回摘要完成" : "AI 总结排队中...",
    blocked ? "missing_turn_summaries" : null
  );
  return record;
}

async function enqueueFactsBoardJob(input: {
  debateId: string;
  sourceKey: string;
  turnNumber?: number | null;
  roundNumber?: number | null;
  payload: Record<string, unknown>;
}) {
  const record = await enqueueDebateSummaryJob({
    debateId: input.debateId,
    kind: "facts_board",
    jobKey: `facts:${input.sourceKey}`,
    turnNumber: input.turnNumber ?? null,
    roundNumber: input.roundNumber ?? null,
    payload: input.payload
  });
  await syncSummaryJobToLive(record, "AI 总结排队中...");
  return record;
}

async function updateDbSummaryJobLive(job: DebateSummaryJobRecord, message?: string | null, blockedReason?: string | null) {
  await syncSummaryJobToLive(job, message, blockedReason);
}

export async function runSummaryJobByRecord(job: DebateSummaryJobRecord) {
  const payload = job.payload;
  const workflow = await loadDebateWorkflow(String(payload.userId ?? ""), job.debateId);
  const summarizer = getWorkflowSummarizerConfig(workflow);
  if (!summarizer?.enabled) {
    const failed = await failDebateSummaryJob(job.id, "summarizer_disabled");
    await updateDbSummaryJobLive(failed, "总结器未启用");
    return failed;
  }
  if (!summarizer.aiAgentId) {
    const failed = await failDebateSummaryJob(job.id, "summarizer_ai_missing");
    await updateDbSummaryJobLive(failed, "总结器配置失效");
    return failed;
  }

  await updateDbSummaryJobLive(job, "AI 总结中...");
  try {
    if (job.kind === "turn_summary") {
      const result = await generateTurnSummary({
        userId: String(payload.userId),
        debateId: job.debateId,
        debateAgentId: String(payload.debateAgentId),
        debateQuestion: String(payload.debateQuestion),
        workflow,
        roundNumber: Number(payload.roundNumber),
        turnNumber: Number(payload.turnNumber),
        agentName: String(payload.agentName),
        content: String(payload.content ?? ""),
        now: new Date().toISOString(),
        refreshFactsBoard: Boolean(payload.refreshFactsBoard)
      });
      if (!result.ok) {
        const retried = await scheduleDebateSummaryJobRetry({
          id: job.id,
          attemptCount: job.attemptCount,
          errorMessage: truncateErrorMessage(String(result.error ?? "turn_summary_failed"))
        });
        await updateDbSummaryJobLive(retried, retried.status === "dead_letter" ? "回摘要进入死信" : "回摘要待重试");
        return retried;
      }
      const completed = await completeDebateSummaryJob(job.id);
      await updateDbSummaryJobLive(completed, "回摘要已完成");
      if (Boolean(payload.refreshFactsBoard) && result.content) {
        await enqueueFactsBoardJob({
          debateId: job.debateId,
          sourceKey: `turn:${Number(payload.turnNumber)}`,
          turnNumber: Number(payload.turnNumber),
          roundNumber: Number(payload.roundNumber),
          payload: {
            userId: String(payload.userId),
            debateId: job.debateId,
            debateAgentId: String(payload.debateAgentId),
            debateQuestion: String(payload.debateQuestion),
            sourceLabel: `turn-${Number(payload.turnNumber)}`,
            sourceSummary: result.content,
            turnNumber: Number(payload.turnNumber),
            roundNumber: Number(payload.roundNumber)
          }
        });
      }
      return completed;
    }

    if (job.kind === "round_summary") {
      const result = await generateRoundSummary({
        userId: String(payload.userId),
        debate: { id: job.debateId, question: String(payload.debateQuestion) },
        debateAgentId: String(payload.debateAgentId),
        workflow,
        participantCount: Number(payload.participantCount),
        endedRound: Number(payload.endedRound),
        now: new Date().toISOString(),
        refreshFactsBoard: Boolean(payload.refreshFactsBoard)
      });
      if (!result.ok) {
        const message =
          typeof result.error === "string" && result.error === "missing_turn_summaries"
            ? "missing_turn_summaries"
            : truncateErrorMessage(String(result.error ?? "round_summary_failed"));
        if (message === "missing_turn_summaries") {
          const blocked = await markBlockedDebateSummaryJob(job.id, message);
          await updateDbSummaryJobLive(blocked, "等待本轮回摘要完成", message);
          return blocked;
        }
        const retried = await scheduleDebateSummaryJobRetry({
          id: job.id,
          attemptCount: job.attemptCount,
          errorMessage: message
        });
        await updateDbSummaryJobLive(retried, retried.status === "dead_letter" ? "轮摘要进入死信" : "轮摘要待重试");
        return retried;
      }
      const completed = await completeDebateSummaryJob(job.id);
      await updateDbSummaryJobLive(completed, "轮摘要已完成");
      if (Boolean(payload.refreshFactsBoard) && result.content) {
        await enqueueFactsBoardJob({
          debateId: job.debateId,
          sourceKey: `round:${Number(payload.endedRound)}`,
          roundNumber: Number(payload.endedRound),
          payload: {
            userId: String(payload.userId),
            debateId: job.debateId,
            debateAgentId: String(payload.debateAgentId),
            debateQuestion: String(payload.debateQuestion),
            sourceLabel: `round-${Number(payload.endedRound)}`,
            sourceSummary: result.content,
            turnNumber: null,
            roundNumber: Number(payload.endedRound)
          }
        });
      }
      return completed;
    }

    const result = await refreshFactsBoardFromSummaries({
      userId: String(payload.userId),
      debateId: job.debateId,
      debateAgentId: String(payload.debateAgentId),
      debateQuestion: String(payload.debateQuestion),
      workflow,
      sourceLabel: String(payload.sourceLabel),
      sourceSummary: String(payload.sourceSummary ?? ""),
      turnNumber: payload.turnNumber === null || payload.turnNumber === undefined ? null : Number(payload.turnNumber),
      roundNumber: payload.roundNumber === null || payload.roundNumber === undefined ? null : Number(payload.roundNumber),
      now: new Date().toISOString()
    });
    if (!result.ok) {
      const retried = await scheduleDebateSummaryJobRetry({
        id: job.id,
        attemptCount: job.attemptCount,
        errorMessage: truncateErrorMessage(String(result.error ?? "facts_board_failed"))
      });
      await updateDbSummaryJobLive(retried, retried.status === "dead_letter" ? "事实板进入死信" : "事实板待重试");
      return retried;
    }
    const completed = await completeDebateSummaryJob(job.id);
    await updateDbSummaryJobLive(completed, "事实板已完成");
    return completed;
  } catch (error) {
    const retried = await scheduleDebateSummaryJobRetry({
      id: job.id,
      attemptCount: job.attemptCount,
      errorMessage: truncateErrorMessage(String(describeRuntimeError(error).message ?? "summary_job_failed"))
    });
    await updateDbSummaryJobLive(retried, retried.status === "dead_letter" ? "总结任务进入死信" : "总结任务待重试");
    await logRuntimeEvent("warn", "summary job execution failed", {
      debateId: job.debateId,
      jobKey: job.jobKey,
      kind: job.kind,
      error: describeRuntimeError(error)
    });
    return retried;
  }
}

export async function runDebate(id: string, userId: string) {
  const acquired = tryAcquireDebateRun(id, userId);
  if (!acquired.acquired) {
    const existing = getDebateRunSnapshot(id);
    await logRuntimeEvent("warn", "debate runtime skipped because another run is active", {
      debateId: id,
      userId,
      activeSince: existing ? new Date(existing.startedAt).toISOString() : null,
      lastHeartbeatAt: existing ? new Date(existing.heartbeatAt).toISOString() : null,
      activeRunUserId: existing?.userId ?? null,
      activeDurationMs: existing ? Math.max(0, Date.now() - existing.startedAt) : null
    });
    return;
  }

  const { runToken } = acquired.snapshot;
  let lastKnownPhase: Pick<DebateRecord, "workflowPhaseKind" | "workflowPhaseTitle" | "workflowPhaseRound"> | null = null;

  try {
    const pendingAutoSegmentByDebateAgentId = new Map<string, { reason: string }>();
    while (true) {
      touchDebateRun(id, runToken);
      const db = await ensureDb();
      const debateResult = await db
        .selectFrom("debates")
        .selectAll()
        .where("id", "=", id)
        .where("user_id", "=", userId)
        .executeTakeFirst();
      if (!debateResult) {
        break;
      }

      const debate = normalizeDebateRow(debateResult as Record<string, unknown>);
      if (debate.status !== "running") {
        break;
      }
      if (debate.runtimeNoticeKind === "recovering") {
        const recoveredAt = new Date().toISOString();
        await setDebateRuntimeNotice(id, {
          runtimeNoticeKind: "recovered",
          runtimeNoticeMessage: "进程中断后已自动恢复，当前辩论已重新接管并继续运行",
          runtimeNoticeAt: recoveredAt
        });
        emitDebateLiveEvent(id, {
          type: "status",
          debateId: id,
          message: "检测到进程中断，已自动恢复并继续运行",
          at: recoveredAt
        });
      }
      let participantRows = await db
        .selectFrom("debate_agents")
        .selectAll()
        .where("debate_id", "=", id)
        .orderBy("turn_order", "asc")
        .execute();
      const participantCount = participantRows.length;
      const roleAssignments = await loadDebateParticipantRoleTypes(userId, id);
      if (participantCount < 2) {
        throw new AppError("VALIDATION_ERROR", 400, "Debate requires at least 2 agents");
      }

      const workflowBeforeTurn = await loadDebateWorkflow(userId, id);
      const openVoteBeforeTurn = await loadOpenVote(userId, id);
      const latestVoteBeforeTurn = await loadLatestVote(userId, id);
      const closedVoteRoundsBeforeTurn = await listClosedOfficialVoteRounds(userId, id);
      const completedSpeakingRounds = Math.floor(debate.currentTurn / participantCount);
      const currentRoundNumberBeforeTurn = resolveCurrentRoundNumberForWorkflow({
        currentTurn: debate.currentTurn,
        participantCount,
        openVote: openVoteBeforeTurn,
        closedVoteRounds: closedVoteRoundsBeforeTurn
      });
      const phaseBeforeTurn = resolveCurrentWorkflowPhase({
        workflow: workflowBeforeTurn,
        roundNumber: currentRoundNumberBeforeTurn,
        openVote: openVoteBeforeTurn,
        latestVote: latestVoteBeforeTurn,
        persistedPhaseKind: debate.workflowPhaseKind
      });
      const phaseSnapshotBeforeTurn = getPhaseSnapshot(phaseBeforeTurn, currentRoundNumberBeforeTurn);
      const shouldPersistPhaseSnapshot =
        lastKnownPhase?.workflowPhaseKind !== phaseSnapshotBeforeTurn.workflowPhaseKind ||
        lastKnownPhase?.workflowPhaseTitle !== phaseSnapshotBeforeTurn.workflowPhaseTitle ||
        lastKnownPhase?.workflowPhaseRound !== phaseSnapshotBeforeTurn.workflowPhaseRound;
      if (shouldPersistPhaseSnapshot) {
        await persistDebatePhaseSnapshot(id, phaseSnapshotBeforeTurn);
        lastKnownPhase = phaseSnapshotBeforeTurn;
      }
      if (debate.maxTurns > 0 && completedSpeakingRounds >= debate.maxTurns) {
        const consensusRequiredBeforeTurn = workflowBeforeTurn?.consensus.enabled !== false;
        const consensusReachedBeforeTurn = !consensusRequiredBeforeTurn || Boolean(debate.consensusReached);
        const requiresFinalizationPhase = requiresWorkflowFinalizationPhaseForCompletion(workflowBeforeTurn);
        const requiresOutputs = requiresWorkflowOutputsForCompletion(workflowBeforeTurn);
        const earliestCompletionRound = getWorkflowEarliestCompletionRound(workflowBeforeTurn);
        const missingDeliverables = requiresOutputs
          ? await listMissingRequiredDeliverables({
              userId,
              debateId: id,
              workflow: workflowBeforeTurn
            })
          : [];
        if (
          consensusReachedBeforeTurn &&
          (!requiresFinalizationPhase || phaseBeforeTurn?.kind === "finalization") &&
          currentRoundNumberBeforeTurn >= earliestCompletionRound &&
          missingDeliverables.length === 0
        ) {
          await finishDebate(id, "completed", undefined, { phase: lastKnownPhase });
        } else if (missingDeliverables.length > 0) {
          await finishDebate(
            id,
            "stopped",
            `max turns reached before required deliverables were written: ${missingDeliverables.map((file) => file.path).join(", ")}`,
            { phase: lastKnownPhase }
          );
        } else if (currentRoundNumberBeforeTurn < earliestCompletionRound) {
          await finishDebate(id, "stopped", `max turns reached before workflow minimum completion round ${earliestCompletionRound}`, {
            phase: lastKnownPhase
          });
        } else if (!consensusReachedBeforeTurn) {
          await finishDebate(id, "stopped", "max turns reached before consensus was reached", { phase: lastKnownPhase });
        } else {
          await finishDebate(id, "stopped", "max turns reached before consolidation phase", { phase: lastKnownPhase });
        }
        break;
      }

      const currentIndex = debate.currentTurn % participantCount;
      const currentParticipant = participantRows[currentIndex];
      const agentResult = await db
        .selectFrom("ai_agents")
        .selectAll()
        .where("id", "=", String((currentParticipant as { ai_agent_id?: unknown }).ai_agent_id))
        .where("user_id", "=", userId)
        .executeTakeFirst();
      if (!agentResult) {
        throw new AppError("NOT_FOUND", 404, "Agent not found for debate");
      }

      const agent = normalizeAgentRow(agentResult as Record<string, unknown>);
      const seatNumberForEvent =
        typeof (currentParticipant as any).turn_order === "number"
          ? Number((currentParticipant as any).turn_order)
          : typeof (currentParticipant as any).turnOrder === "number"
            ? Number((currentParticipant as any).turnOrder)
            : currentIndex + 1;
      const displayNameForEvent =
        typeof (currentParticipant as any).display_name === "string"
          ? String((currentParticipant as any).display_name)
          : typeof (currentParticipant as any).displayName === "string"
            ? String((currentParticipant as any).displayName)
            : "";
      const baseRoleNameForEvent = getDebateParticipantRoleType(roleAssignments, String(currentParticipant.id));
      const eventAgentName = `Seat-${seatNumberForEvent}${displayNameForEvent ? ` · ${displayNameForEvent}` : ""}`;
      const currentSpeechRoundIndex = Math.floor(Math.max(0, debate.currentTurn) / Math.max(1, participantCount)) + 1;
      const actualRoundNumber = mapSpeechRoundIndexToActualRound(currentSpeechRoundIndex, closedVoteRoundsBeforeTurn);
      setDebateLiveProgress({
        debateId: id,
        roundNumber: actualRoundNumber,
        messageNumber: debate.currentTurn + 1,
        debateAgentId: String(currentParticipant.id),
        aiAgentId: String(currentParticipant.ai_agent_id),
        agentName: eventAgentName,
        baseRoleName: baseRoleNameForEvent,
        stage: "calling_model"
      });
      const startedAt = Date.now();
      let raw = "";
      let usage: { promptTokens: number | null; completionTokens: number | null; totalTokens: number | null } | null = null;
      let estimatedPromptTokens: number | null = null;
      let promptChars: number | null = null;
      let generationDiagnostics:
        | {
            provider: string;
            model: string;
            requestedMaxTokens: number;
            finishReason: string | null;
            toolCallsCount: number;
          }
        | null = null;
      let retryCount = 0;
      const messageNumber = debate.currentTurn + 1;
      const roundNumber = actualRoundNumber;

      while (retryCount <= 2) {
        try {
          const result = await callProvider(
            debate,
            agent,
            messageNumber,
            roundNumber,
            participantCount,
            userId,
            String(currentParticipant.id),
            eventAgentName,
            baseRoleNameForEvent
          );
          raw = result.raw;
          usage = result.usage;
          estimatedPromptTokens =
            typeof (result as { estimatedPromptTokens?: unknown }).estimatedPromptTokens === "number"
              ? Number((result as { estimatedPromptTokens: number }).estimatedPromptTokens)
              : null;
          promptChars =
            typeof (result as { promptChars?: unknown }).promptChars === "number"
              ? Number((result as { promptChars: number }).promptChars)
              : null;
          generationDiagnostics =
            result && typeof result === "object" && "diagnostics" in result
              ? ((result as {
                  diagnostics?: {
                    provider: string;
                    model: string;
                    requestedMaxTokens: number;
                    finishReason: string | null;
                    toolCallsCount: number;
                  };
                }).diagnostics ?? null)
              : null;
          break;
        } catch (error) {
          retryCount += 1;
          if (retryCount > 2) {
            throw error;
          }
          await sleep(500);
        }
      }

      setDebateLiveProgress({
        debateId: id,
        roundNumber,
        messageNumber,
        debateAgentId: String(currentParticipant.id),
        aiAgentId: String(currentParticipant.ai_agent_id),
        agentName: eventAgentName,
        baseRoleName: baseRoleNameForEvent,
        stage: "parsing"
      });
      const parsed = parseResponse(raw);
      const persistedResponse = parsed;
      emitDebateLiveEvent(id, {
        type: "status",
        debateId: id,
        message: "解析与保存中...",
        at: new Date().toISOString()
      });
      const tokenUsed = Math.max(80, Math.ceil(raw.length / 3));
      const responseTimeMs = Date.now() - startedAt;
      const createdAt = new Date().toISOString();

      setDebateLiveProgress({
        debateId: id,
        roundNumber,
        messageNumber,
        debateAgentId: String(currentParticipant.id),
        aiAgentId: String(currentParticipant.ai_agent_id),
        agentName: eventAgentName,
        baseRoleName: baseRoleNameForEvent,
        stage: "saving",
        updatedAt: createdAt
      });
      await db.executeQuery(sql`
        insert into debate_turns (
          id, debate_id, ai_agent_id, debate_agent_id, seat_number, turn_number, content, structured_output,
          parse_status, token_used, response_time_ms, retry_count, error_code, created_at
        ) values (
          ${randomUUID()},
          ${id},
          ${String((currentParticipant as { ai_agent_id?: unknown }).ai_agent_id)},
          ${String((currentParticipant as { id?: unknown }).id)},
          ${typeof (currentParticipant as any).turn_order === "number"
            ? Number((currentParticipant as any).turn_order)
            : typeof (currentParticipant as any).turnOrder === "number"
              ? Number((currentParticipant as any).turnOrder)
              : currentIndex + 1},
          ${debate.currentTurn + 1},
          ${persistedResponse.content},
          ${persistedResponse.structuredOutput ? JSON.stringify(persistedResponse.structuredOutput) : null},
          ${persistedResponse.parseStatus},
          ${tokenUsed},
          ${responseTimeMs},
          ${retryCount},
          ${null},
          ${createdAt}
        )
      `.compile(db));

      try {
        const turnChunks = splitTextIntoRetrievalChunks(persistedResponse.content, 1_200, 180);
        for (let chunkIndex = 0; chunkIndex < turnChunks.length; chunkIndex += 1) {
          // eslint-disable-next-line no-await-in-loop
          await indexDebateContextChunk({
            userId,
            debateId: id,
            debateAgentId: String(currentParticipant.id),
            chunkKey: `turn:${messageNumber}:chunk:${chunkIndex + 1}`,
            sourceType: "turn",
            turnNumberStart: messageNumber,
            turnNumberEnd: messageNumber,
            roundNumber,
            content: turnChunks[chunkIndex],
            now: createdAt
          });
        }
      } catch (error) {
        await logRuntimeEvent("warn", "turn retrieval indexing failed", {
          debateId: id,
          error: describeRuntimeError(error)
        });
      }

      try {
        await appendGenerationDiagnostics({
          userId,
          debateId: id,
          now: createdAt,
          entry: {
            at: createdAt,
            turnNumber: debate.currentTurn + 1,
            roundNumber,
            debateAgentId: String(currentParticipant.id),
            seatNumber:
              typeof (currentParticipant as any).turn_order === "number"
                ? Number((currentParticipant as any).turn_order)
                : typeof (currentParticipant as any).turnOrder === "number"
                  ? Number((currentParticipant as any).turnOrder)
                  : currentIndex + 1,
            agentName: eventAgentName,
            provider: generationDiagnostics?.provider ?? agent.provider,
            model: generationDiagnostics?.model ?? agent.model,
            requestedMaxTokens: generationDiagnostics?.requestedMaxTokens ?? null,
            finishReason: generationDiagnostics?.finishReason ?? null,
            toolCallsCount: generationDiagnostics?.toolCallsCount ?? 0,
            rawChars: raw.length,
            persistedChars: persistedResponse.content.length,
            parseStatus: persistedResponse.parseStatus,
            structuredOutput: Boolean(persistedResponse.structuredOutput),
            voteOnlyOverride: false
          }
        });
      } catch (error) {
        await logRuntimeEvent("warn", "generation diagnostics persistence failed", {
          debateId: id,
          error: describeRuntimeError(error)
        });
      }

      await db.executeQuery(sql`
        update debate_agents set turn_count = turn_count + 1 where id = ${String(currentParticipant.id)}
      `.compile(db));

      try {
        const apiPromptTokens =
          usage?.promptTokens && typeof usage.promptTokens === "number" && usage.promptTokens > 0
            ? Math.floor(usage.promptTokens)
            : null;
        const fallbackPromptTokens =
          estimatedPromptTokens !== null && Number.isFinite(estimatedPromptTokens) && estimatedPromptTokens > 0
            ? Math.floor(estimatedPromptTokens)
            : null;
        const usedPromptTokens = apiPromptTokens ?? fallbackPromptTokens;
        const completionTokens = usage?.completionTokens ?? null;

        if (usedPromptTokens !== null) {
          const seat = `Seat-${Number((currentParticipant as any).turn_order ?? (currentParticipant as any).turnOrder ?? currentIndex + 1)}`;
          const source = apiPromptTokens !== null ? "api" : "estimate";
          const totals = await appendContextUsageLogAndUpdateTotals({
            userId,
            debateId: id,
            debateAgentId: String(currentParticipant.id),
            seat,
            agent,
            contextLength: agent.contextLength,
            apiPromptTokens,
            estimatedPromptTokens: fallbackPromptTokens,
            usedPromptTokens,
            multiplier: 1,
            source,
            turnNumber: messageNumber,
            roundNumber,
            now: createdAt
          });
          if (totals.ratio !== null && Number.isFinite(totals.ratio) && totals.ratio >= 0.75) {
            pendingAutoSegmentByDebateAgentId.set(String(currentParticipant.id), {
              reason: `auto: session_prompt_tokens=${totals.sessionPromptTokens}; context_length=${totals.contextLength}; ratio=${totals.ratio.toFixed(4)}; agent=${agent.name}`
            });
          }
        }

        const promptCharRatio =
          promptChars !== null && promptChars > 0
            ? promptChars / getPromptHardMaxChars(agent)
            : null;
        if (promptCharRatio !== null && Number.isFinite(promptCharRatio) && promptCharRatio >= 0.82) {
          pendingAutoSegmentByDebateAgentId.set(String(currentParticipant.id), {
            reason: `auto: prompt_chars=${promptChars}; hard_cap=${getPromptHardMaxChars(agent)}; ratio=${promptCharRatio.toFixed(4)}; agent=${agent.name}`
          });
        }

        await updateContextUsageFile({
          userId,
          debateId: id,
          debateAgentId: String(currentParticipant.id),
          agent,
          usage: {
            promptTokens: usedPromptTokens,
            completionTokens,
            totalTokens:
              usage?.totalTokens ??
              (usedPromptTokens !== null && completionTokens !== null ? usedPromptTokens + completionTokens : null)
          },
          source: apiPromptTokens !== null ? "api" : "estimate",
          turnNumber: messageNumber,
          now: createdAt
        });
      } catch (error) {
        await logRuntimeEvent("warn", "context usage persistence failed", { debateId: id, error: describeRuntimeError(error) });
      }

       emitDebateLiveEvent(id, {
         type: "turn_end",
         debateId: id,
         turnNumber: messageNumber,
         agentName: eventAgentName,
         at: createdAt
       });

      try {
        await Promise.all([
          persistMemoryAfterTurn({
            userId,
            debateId: id,
            debateAgentId: String(currentParticipant.id),
            agentName: eventAgentName,
            debateQuestion: debate.question,
            turnNumber: messageNumber,
            content: persistedResponse.content,
            structuredOutput: persistedResponse.structuredOutput,
            now: createdAt
          }),
          persistAnswerAfterTurn({
            userId,
            debateId: id,
            roundNumber,
            turnNumber: messageNumber,
            agentName: eventAgentName,
            content: persistedResponse.content,
            now: createdAt
          })
        ]);
      } catch (error) {
        await logRuntimeEvent("warn", "memory persistence failed", { debateId: id, error: describeRuntimeError(error) });
      }

      const workflow = await loadDebateWorkflow(userId, id);
      try {
        await enqueueTurnSummaryJob({
          userId,
          debateId: id,
          debateAgentId: String(currentParticipant.id),
          debateQuestion: debate.question,
          workflow,
          roundNumber,
          turnNumber: messageNumber,
          agentName: eventAgentName,
          content: persistedResponse.content,
          refreshFactsBoard: debate.enableSharedFacts
        });
      } catch (error) {
        await logRuntimeEvent("warn", "turn summary enqueue failed", {
          debateId: id,
          error: describeRuntimeError(error)
        });
      }

      const turnRows = await db
        .selectFrom("debate_turns")
        .selectAll()
        .where("debate_id", "=", id)
        .orderBy("turn_number", "asc")
        .execute();
      const turns: DebateTurnRecord[] = turnRows.map((row) => ({
        id: String(row.id),
        debateId: String(row.debate_id),
        aiAgentId: String(row.ai_agent_id),
        debateAgentId: row.debate_agent_id ? String(row.debate_agent_id) : null,
        seatNumber: row.seat_number === null ? null : Number(row.seat_number),
        turnNumber: Number(row.turn_number),
        content: String(row.content),
        structuredOutput: (row.structured_output as StructuredOutput | null) ?? null,
        parseStatus: row.parse_status as "ok" | "fallback",
        tokenUsed: Number(row.token_used),
        responseTimeMs: row.response_time_ms === null ? null : Number(row.response_time_ms),
        retryCount: Number(row.retry_count),
        errorCode: (row.error_code as string | null) ?? null,
        createdAt: String(row.created_at)
      }));

      const consensus = aggregateConsensusByLastRound(turns, participantCount, workflow?.consensus ?? null);
      const nextTurn = debate.currentTurn + 1;
      const isBoundary = participantCount > 0 ? nextTurn % participantCount === 0 : false;
      const endedSpeechRoundIndex = participantCount > 0 ? Math.floor(nextTurn / participantCount) : 0;
      const endedRound = mapSpeechRoundIndexToActualRound(endedSpeechRoundIndex, closedVoteRoundsBeforeTurn);
      const openVoteBeforeUpdate = await loadOpenVote(userId, id);
      const latestVoteBeforeUpdate = await loadLatestVote(userId, id);
      const mustKeepRunningForVote = Boolean(openVoteBeforeUpdate);
      const finalizationPhase = resolveCurrentWorkflowPhase({
        workflow,
        roundNumber: endedRound + 1,
        openVote: openVoteBeforeUpdate,
        latestVote: latestVoteBeforeUpdate,
        persistedPhaseKind: debate.workflowPhaseKind
      });
      const requiresFinalizationPhase = requiresWorkflowFinalizationPhaseForCompletion(workflow);
      const requiresOutputs = requiresWorkflowOutputsForCompletion(workflow);
      const currentSpeechRoundIndexAfterTurn = Math.floor(Math.max(0, nextTurn - 1) / Math.max(1, participantCount)) + 1;
      const currentRoundNumberAfterTurn = mapSpeechRoundIndexToActualRound(
        currentSpeechRoundIndexAfterTurn,
        closedVoteRoundsBeforeTurn
      );
      const canCompleteByPhase =
        requiresFinalizationPhase
          ? finalizationPhase?.kind === "finalization" && currentRoundNumberAfterTurn >= getWorkflowEarliestCompletionRound(workflow)
          : currentRoundNumberAfterTurn >= getWorkflowEarliestCompletionRound(workflow);
      const missingDeliverables = requiresOutputs
        ? await listMissingRequiredDeliverables({
            userId,
            debateId: id,
            workflow
          })
        : [];
      const canCompleteByDeliverables = missingDeliverables.length === 0;
      const consensusRequired = workflow?.consensus.enabled !== false;
      const canCompleteByConsensus = !consensusRequired || consensus.reached;
      const consensusReachedForDb = mustKeepRunningForVote ? false : consensus.reached;
      const nextStatusForDb =
        !mustKeepRunningForVote && canCompleteByConsensus && canCompleteByPhase && canCompleteByDeliverables
          ? "completed"
          : "running";
      const phaseSnapshotAfterTurn = getPhaseSnapshot(finalizationPhase, currentRoundNumberAfterTurn);
      lastKnownPhase = phaseSnapshotAfterTurn;
      await db.executeQuery(sql`
        update debates
            set current_turn = ${nextTurn},
                token_used = ${debate.tokenUsed + tokenUsed},
                consensus_summary = ${consensus.leadingSolution
                  ? JSON.stringify({
                      leadingSolution: consensus.leadingSolution,
                      score: consensus.score
                    })
                  : null},
                consensus_reached = ${consensusReachedForDb},
                workflow_phase_kind = ${phaseSnapshotAfterTurn.workflowPhaseKind},
                workflow_phase_title = ${phaseSnapshotAfterTurn.workflowPhaseTitle},
                workflow_phase_round = ${phaseSnapshotAfterTurn.workflowPhaseRound},
                status = case
                  when status in ('paused', 'stopped') then status
                  else ${nextStatusForDb}
                end,
                finished_at = case
                  when ${nextStatusForDb} = 'completed' then ${createdAt}
                  else finished_at
                end,
                updated_at = ${createdAt}
          where id = ${id}
      `.compile(db));

      if (isBoundary && pendingAutoSegmentByDebateAgentId.size > 0 && !consensus.reached) {
        try {
          const pending = [...pendingAutoSegmentByDebateAgentId.entries()];
          pendingAutoSegmentByDebateAgentId.clear();
          for (const [debateAgentId, item] of pending) {
            emitDebateLiveEvent(id, {
              type: "status",
              debateId: id,
              message: `上下文接近上限：自动开始新会话（仅该席位；轮次边界）...`,
              at: new Date().toISOString()
            });
            // eslint-disable-next-line no-await-in-loop
            await startAutoSegmentForDebateAgentAtBoundary({
              userId,
              debateId: id,
              debateAgentId,
              participantCount,
              currentTurn: nextTurn,
              question: debate.question,
              reason: item.reason,
              now: createdAt
            });
            // eslint-disable-next-line no-await-in-loop
            await bumpUsageSessionForDebateAgent({
              userId,
              debateId: id,
              debateAgentId,
              now: createdAt,
              reason: "auto_75pct_threshold"
            });
          }
        } catch (error) {
          await logRuntimeEvent("warn", "auto segment failed", { debateId: id, error: describeRuntimeError(error) });
        }
      }

      if (isBoundary) {
        if (endedRound > 0) {
          let finalizationEnteredAtBoundary = false;
          try {
            emitDebateLiveEvent(id, {
              type: "status",
              debateId: id,
              message: `第 ${endedRound} 轮总结已入队，后台处理中...`,
              at: new Date().toISOString()
            });
            await enqueueRoundSummaryJob({
              userId,
              debateId: debate.id,
              debateAgentId: String(currentParticipant.id),
              debateQuestion: debate.question,
              workflow,
              participantCount,
              roundNumber: endedRound,
              refreshFactsBoard: debate.enableSharedFacts
            });
          } catch (error) {
            await logRuntimeEvent("warn", "round summary enqueue failed", { debateId: id, error: describeRuntimeError(error) });
          }

          try {
            const closed = await maybeAutoCloseOpenVoteAtBoundary({
              userId,
              debateId: id,
              participantCount,
              endedRound
            });
            if (closed.closed) {
              emitDebateLiveEvent(id, {
                type: "status",
                debateId: id,
                message: "官方投票已在轮次边界自动封票（结果来自投票）；下一轮首位席位将统计并公布",
                at: new Date().toISOString()
              });
              const closedVote =
                closed.result && typeof closed.result === "object" && (closed.result as any).closed
                  ? ((closed.result as any).closed as ClosedOfficialVote)
                  : null;
              if (closedVote) {
                if (closedVote.kind === "finalization" && Boolean((closedVote.result as any)?.passed)) {
                  const workflowPhase = getWorkflowPhaseByKind(workflow, "finalization");
                  const phaseSnapshot = {
                    workflowPhaseKind: "finalization" as const,
                    workflowPhaseTitle: workflowPhase?.title ?? "Consolidation · Final alignment and outputs",
                    workflowPhaseRound: endedRound + 1
                  };
                  await persistDebatePhaseSnapshot(id, phaseSnapshot);
                  lastKnownPhase = phaseSnapshot;
                  finalizationEnteredAtBoundary = true;
                  emitDebateLiveEvent(id, {
                    type: "status",
                    debateId: id,
                    message: `Consolidation vote passed. From round ${endedRound + 1}, the debate enters the consolidation phase.`,
                    at: new Date().toISOString()
                  });
                }
                try {
                  await maybeGenerateVoteAnnouncementWithSeat1({
                    userId,
                    debate,
                    participantCount,
                    closed: closedVote
                  });
                } catch (error) {
                  await logRuntimeEvent("warn", "auto vote announce failed", {
                    debateId: id,
                    error: describeRuntimeError(error)
                  });
                }
              }
            } else if (closed.reopened) {
              emitDebateLiveEvent(id, {
                type: "status",
                debateId: id,
                message: "官方投票平票：下一轮继续补充观点后重新投票，当前仍停留在投票阶段",
                at: new Date().toISOString()
              });
            }
          } catch (error) {
            await logRuntimeEvent("warn", "auto vote close failed", { debateId: id, error: describeRuntimeError(error) });
          }

          try {
            const opened = await maybeAutoOpenVoteAtBoundaryUsingWorkflow({
              userId,
              debateId: id,
              participantCount,
              endedRound,
              skipFinalizationAutoOpen: finalizationEnteredAtBoundary
            });
            if (opened.opened) {
              emitDebateLiveEvent(id, {
                type: "status",
                debateId: id,
                message: `已在第 ${endedRound} 轮结束后自动开票：请各席位使用官方工具完成投票`,
                at: new Date().toISOString()
              });
            }
          } catch (error) {
            await logRuntimeEvent("warn", "auto vote open failed", { debateId: id, error: describeRuntimeError(error) });
          }
        }
      }

      touchDebateRun(id, runToken);
      await sleep(1000);
    }
  } catch (error) {
    const details = describeRuntimeError(error);
    await logRuntimeEvent("error", "debate runtime failed", {
      debateId: id,
      userId,
      code: details.code,
      message: details.message,
      stack: details.stack
    });
    if (isRecoverableRuntimeInterruption(details)) {
      await pauseDebateAfterRuntimeInterruption(id, "runtime interrupted", {
        phase: lastKnownPhase,
        lastErrorCode: details.code,
        lastErrorMessage: truncateErrorMessage(details.message)
      });
    } else {
      await finishDebate(id, "failed", "runtime error", {
        phase: lastKnownPhase,
        lastErrorCode: details.code,
        lastErrorMessage: truncateErrorMessage(details.message)
      });
    }
  } finally {
    releaseDebateRun(id, runToken);
    clearDebateLiveProgress(id);
  }
}
