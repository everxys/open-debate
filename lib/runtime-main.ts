import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

import { decryptSecret } from "@/lib/crypto";
import { getDebateParticipantRoleType, loadDebateParticipantRoleTypes, type DebateParticipantRoleType } from "@/lib/debate-role-types";
import { ensureDbReady, query } from "@/lib/db";
import { emitDebateLiveEvent, setDebateLiveProgress, clearDebateLiveProgress } from "@/lib/debate-live";
import { AppError } from "@/lib/http";
import { indexDebateContextChunk, retrieveRelevantHistory, splitTextIntoRetrievalChunks } from "@/lib/retrieval";
import {
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
  PROMPT_HARD_MAX_CHARS_OPENAI,
  QUESTION_LATEST_DIFF_PATH,
  SEATS_PENDING_REORDER_PATH,
  SHARED_FACTS_PATH,
  VOTE_ANNOUNCEMENT_PATH,
  VOTE_ANNOUNCEMENT_PREFIX,
  VOTE_DIRECTIVE_JSON_PATH,
  VOTE_DIRECTIVE_PATH,
  VOTE_OPEN_PATH,
  VOTE_RESULT_PREFIX,
  WORKFLOW_PATH
} from "@/lib/runtime/constants";
import {
  readDebateAgentFile,
  readDebateFile,
  upsertDebateAgentFile,
  upsertDebateFile
} from "@/lib/runtime/file-store";
import {
  openAiChatOnce,
  openAiChatStream,
  openAiUsageProbe,
  resolveChatUrl
} from "@/lib/runtime/provider-openai";
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
  getWorkflowElectionStartRound,
  getWorkflowMinimumAnalysisRounds,
  getWorkflowOutputMaxTokens,
  getWorkflowPhaseMinRounds,
  getWorkflowPhaseByKind,
  isClosedElectionVotePassed,
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
  safeJsonParse,
  shouldAutoOpenWorkflowElectionAtBoundary,
  withOptionalMaxTokens
} from "@/lib/runtime/workflow-phase";

export type DebateFileWriteMode = "replace" | "append" | "section_merge";
export type DebateFileActivityAction = "read" | "write" | "search" | "list" | "stat";
export type DebateFileActivityAudit = {
  debateId: string;
  debateAgentId: string;
  turnNumber: number;
  roundNumber: number;
  now: string;
};

export type ResolvedContextAccessRule = {
  category: "alwaysRead" | "readWhenNeeded" | "unlockAfterPhase";
  scope: WorkflowContextAccessScope;
  pathPrefix: string;
  label: string | null;
  maxFiles: number;
  maxCharsPerFile: number;
  recursive: boolean;
  phaseKind?: WorkflowPhaseKind;
};

export function isMemoryPath(path: string) {
  const normalized = path.replace(/\\/g, "/").replace(/^\/+/, "").trim().toLowerCase();
  return normalized.startsWith("memory/");
}

export function normalizeContextPath(path: string) {
  return path.replace(/\\/g, "/").replace(/^\/+/, "").trim();
}

export function isDirectChildPath(prefix: string, path: string) {
  const normalizedPrefix = normalizeContextPath(prefix);
  const normalizedPath = normalizeContextPath(path);
  if (!normalizedPath.startsWith(normalizedPrefix)) return false;
  const rest = normalizedPath.slice(normalizedPrefix.length);
  return rest.length > 0 && !rest.includes("/");
}

export function hasContextAccessRules(workflow: NormalizedDebateWorkflow | null) {
  if (!workflow?.enabled) return false;
  return (
    workflow.contextAccess.alwaysRead.length > 0 ||
    workflow.contextAccess.readWhenNeeded.length > 0 ||
    workflow.contextAccess.unlockAfterPhase.length > 0
  );
}

export function getPhaseRank(phaseKind: WorkflowPhaseKind | null | undefined) {
  switch (phaseKind) {
    case "analysis":
      return 1;
    case "election":
      return 2;
    case "deliberation":
      return 3;
    case "finalization_vote":
      return 4;
    case "finalization":
      return 5;
    default:
      return 0;
  }
}

export function isPhaseUnlocked(currentPhaseKind: WorkflowPhaseKind | null | undefined, requiredPhaseKind: WorkflowPhaseKind) {
  return getPhaseRank(currentPhaseKind) >= getPhaseRank(requiredPhaseKind);
}

export function resolveContextAccessRules(
  workflow: NormalizedDebateWorkflow | null,
  currentPhaseKind: WorkflowPhaseKind | null | undefined
) {
  if (!hasContextAccessRules(workflow)) {
    return {
      autoRead: [] as ResolvedContextAccessRule[],
      readable: [] as ResolvedContextAccessRule[],
      locked: [] as ResolvedContextAccessRule[]
    };
  }

  const autoRead: ResolvedContextAccessRule[] = workflow!.contextAccess.alwaysRead.map((rule) => ({
    ...rule,
    category: "alwaysRead"
  }));
  const readable: ResolvedContextAccessRule[] = workflow!.contextAccess.readWhenNeeded.map((rule) => ({
    ...rule,
    category: "readWhenNeeded"
  }));
  const locked: ResolvedContextAccessRule[] = [];

  for (const rule of workflow!.contextAccess.unlockAfterPhase) {
    if (isPhaseUnlocked(currentPhaseKind, rule.phaseKind)) {
      autoRead.push({ ...rule, category: "unlockAfterPhase" });
      readable.push({ ...rule, category: "unlockAfterPhase" });
    } else {
      locked.push({ ...rule, category: "unlockAfterPhase" });
    }
  }

  return { autoRead, readable, locked };
}

export function matchContextAccessRule(
  rules: ResolvedContextAccessRule[],
  scope: WorkflowContextAccessScope,
  path: string
) {
  const normalizedPath = normalizeContextPath(path);
  return (
    rules.find((rule) => {
      if (rule.scope !== scope) return false;
      const normalizedPrefix = normalizeContextPath(rule.pathPrefix);
      if (!normalizedPath.startsWith(normalizedPrefix)) return false;
      return rule.recursive ? true : isDirectChildPath(normalizedPrefix, normalizedPath);
    }) ?? null
  );
}

export function buildContextAccessSummaryLines(input: {
  workflow: NormalizedDebateWorkflow | null;
  currentPhaseKind: WorkflowPhaseKind | null | undefined;
}) {
  if (!hasContextAccessRules(input.workflow)) return [] as string[];
  const resolved = resolveContextAccessRules(input.workflow, input.currentPhaseKind);
  const lines = ["Context access policy:"];

  if (resolved.autoRead.length > 0) {
    lines.push("- Auto-read now:");
    for (const rule of resolved.autoRead) {
      lines.push(`  - [${rule.scope}] ${rule.pathPrefix}${rule.label ? ` · ${rule.label}` : ""}`);
    }
  }

  if (resolved.readable.length > 0) {
    lines.push("- Readable on demand:");
    for (const rule of resolved.readable) {
      lines.push(`  - [${rule.scope}] ${rule.pathPrefix}${rule.label ? ` · ${rule.label}` : ""}`);
    }
  }

  if (resolved.locked.length > 0) {
    lines.push("- Locked until phase:");
    for (const rule of resolved.locked) {
      lines.push(`  - [${rule.scope}] ${rule.pathPrefix} · unlock=${rule.phaseKind}${rule.label ? ` · ${rule.label}` : ""}`);
    }
  }

  return lines;
}

export function getPgErrorCode(error: unknown) {
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

export function describeRuntimeError(error: unknown) {
  if (error instanceof AppError) {
    return {
      code: error.code,
      message: error.message,
      stack: error.stack ?? null
    };
  }
  if (error instanceof Error) {
    const anyError = error as Error & { code?: unknown };
    return {
      code: typeof anyError.code === "string" ? anyError.code : "RUNTIME_ERROR",
      message: error.message,
      stack: error.stack ?? null
    };
  }
  return {
    code: "RUNTIME_ERROR",
    message: typeof error === "string" ? error : JSON.stringify(error),
    stack: null
  };
}

export function truncateErrorMessage(message: string, maxChars = 1_500) {
  if (message.length <= maxChars) return message;
  return `${message.slice(0, maxChars - 1)}…`;
}

export function getPhaseSnapshot(
  phase: ReturnType<typeof resolveCurrentWorkflowPhase> | null,
  roundNumber: number | null
): Pick<DebateRecord, "workflowPhaseKind" | "workflowPhaseTitle" | "workflowPhaseRound"> {
  return {
    workflowPhaseKind: phase?.kind ?? null,
    workflowPhaseTitle: phase?.title ?? null,
    workflowPhaseRound: roundNumber
  };
}

export async function logRuntimeEvent(
  level: "warn" | "error",
  message: string,
  meta?: Record<string, unknown>
) {
  if (level === "error") {
    console.error(message, meta ?? "");
  } else {
    console.warn(message, meta ?? "");
  }
  try {
    await appendServerLog(level, message, meta);
  } catch (error) {
    console.error("runtime log persistence failed", error);
  }
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

export function estimatePromptTokensFromChars(chars: number) {
  if (!Number.isFinite(chars) || chars <= 0) return null;
  // Heuristic: ~4 chars per token (rough; good enough for a % indicator).
  return Math.max(1, Math.ceil(chars / 4));
}

const DEFAULT_MAX_INPUT_CHARS = 200_000 * 4; // ~200k tokens default limit
const OPENAI_COMPAT_MAX_INPUT_CHARS = 180_000;

export function clipMessagesToInputLimit(
  messages: Array<Record<string, unknown>>,
  maxInputTokens: number | null,
  hardMaxChars?: number | null
): Array<Record<string, unknown>> {
  const tokenBasedMaxChars =
    typeof maxInputTokens === "number" && maxInputTokens > 0
      ? Math.floor(maxInputTokens * 4 * 0.9) // 90% of max, leave room for overhead
      : DEFAULT_MAX_INPUT_CHARS;
  const maxChars =
    typeof hardMaxChars === "number" && hardMaxChars > 0
      ? Math.min(tokenBasedMaxChars, Math.floor(hardMaxChars))
      : tokenBasedMaxChars;

  let totalChars = 0;
  for (const msg of messages) {
    const content = msg.content;
    if (typeof content === "string") {
      totalChars += content.length;
    }
  }

  if (totalChars <= maxChars) {
    return messages;
  }

  // Need to truncate - reduce recent turns inline content
  const result: Array<Record<string, unknown>> = [];
  let remainingChars = maxChars;

  for (const msg of messages) {
    const role = msg.role;
    const content = msg.content;
    const toolCalls = msg.tool_calls;

    if (typeof content !== "string") {
      result.push(msg);
      continue;
    }

    if (role === "system") {
      // Keep system prompt but truncate if needed
      if (content.length <= remainingChars * 0.5) {
        result.push(msg);
        remainingChars -= content.length;
      } else {
        const truncated = content.slice(0, Math.floor(remainingChars * 0.5));
        result.push({ ...msg, content: truncated + "\n\n[Truncated due to input limit]" });
        remainingChars = 0;
      }
    } else if (role === "user") {
      // Truncate user prompt (contains recent turns)
      if (content.length <= remainingChars) {
        result.push(msg);
        remainingChars -= content.length;
      } else {
        const truncated = content.slice(0, remainingChars);
        result.push({ ...msg, content: truncated + "\n\n[Truncated due to input limit]" });
        remainingChars = 0;
      }
    } else if (role === "assistant") {
      // Keep assistant messages shorter
      const keepChars = Math.min(content.length, Math.floor(remainingChars * 0.3));
      if (keepChars > 0) {
        const truncated = content.slice(0, keepChars);
        result.push({ ...msg, content: truncated + (keepChars < content.length ? "\n\n[Truncated]" : "") });
        remainingChars -= keepChars;
      }
    } else {
      result.push(msg);
    }
  }

  return result;
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

export async function persistSharedFactsAfterTurn(input: {
  userId: string;
  debateId: string;
  turnNumber: number;
  agentName: string;
  content: string;
  structuredOutput: StructuredOutput | null;
  now: string;
}) {
  if (!ENABLE_DEBATE_MEMORY) return;

  const current = (await readDebateFile(input.userId, input.debateId, SHARED_FACTS_PATH)) ?? "";
  const output = input.structuredOutput;
  const lines: string[] = [];
  lines.push(`## Turn ${input.turnNumber} · ${input.agentName} · ${input.now}`);
  if (output?.proposed_solution) {
    lines.push(`- Proposed: ${trimToChars(output.proposed_solution, 240)}`);
  }
  if ((output?.arguments ?? []).length > 0) {
    lines.push("- Arguments:");
    for (const arg of output?.arguments ?? []) {
      lines.push(`  - [${arg.type}] ${trimToChars(String(arg.content ?? ""), 240)}`);
    }
  } else {
    lines.push(`- Excerpt: ${trimToChars(input.content.replace(/\s+/g, " ").trim(), 260)}`);
  }
  lines.push("");

  const next = appendWithTrim(current, lines.join("\n"));
  await upsertDebateFile(input.debateId, SHARED_FACTS_PATH, next, input.now);
  try {
    await indexDebateContextChunk({
      userId: input.userId,
      debateId: input.debateId,
      chunkKey: "shared_facts:board",
      sourceType: "shared_facts",
      sourcePath: SHARED_FACTS_PATH,
      turnNumberStart: input.turnNumber,
      turnNumberEnd: input.turnNumber,
      content: next,
      now: input.now
    });
  } catch {
    // retrieval indexing is best-effort
  }
}

export async function persistAnswerAfterTurn(input: {
  userId: string;
  debateId: string;
  turnNumber: number;
  agentName: string;
  content: string;
  now: string;
}) {
  const current = (await readDebateFile(input.userId, input.debateId, "debate/answers.md")) ?? "";
  const lines: string[] = [];
  lines.push(`## Turn ${input.turnNumber} · ${input.agentName} · ${input.now}`);
  lines.push(input.content.trim());
  lines.push("");
  const next = appendWithTrim(current, lines.join("\n"));
  await upsertDebateFile(input.debateId, "debate/answers.md", next, input.now);
}

export function looksLikeToolsUnsupported(errorText: string) {
  const lower = errorText.toLowerCase();
  return (
    errorText.includes("tools") &&
    (lower.includes("unknown") || lower.includes("unrecognized"))
  );
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

export function buildElectionVoteOnlyContent(input?: {
  selections?: Record<string, string>;
  reason?: string | null;
  voterSeat?: string | null;
}) {
  const lines = ["## 选举投票", ""];
  if (input?.voterSeat) {
    lines.push(`投票席位：${input.voterSeat}`);
    lines.push("");
  }
  const pairs = Object.entries(input?.selections ?? {}).map(([role, seat]) => `- ${role}: ${seat}`);
  if (pairs.length > 0) {
    lines.push("本席位已提交正式票型：");
    lines.push(...pairs);
  } else {
    lines.push("本轮为角色选举投票轮。本席位仅完成投票，不发表额外意见。");
  }
  const reason = typeof input?.reason === "string" ? input.reason.trim() : "";
  if (reason) {
    lines.push("");
    lines.push(`投票理由：${reason}`);
  }
  return lines.join("\n");
}

export function extractElectionBallotSummaryFromVote(
  vote: OfficialVote | null,
  debateAgentId: string
): {
  selections: Record<string, string>;
  reason: string | null;
  voterSeat: string | null;
} | null {
  if (!vote || vote.status !== "open" || vote.kind !== "election") return null;
  const ballot =
    (vote.ballots ?? []).find((item) => item && typeof item === "object" && item.debateAgentId === debateAgentId) ?? null;
  if (!ballot) return null;
  const rawSelections =
    ballot && typeof ballot === "object" && "selections" in ballot && ballot.selections && typeof ballot.selections === "object"
      ? (ballot.selections as Record<string, unknown>)
      : {};
  const selections = Object.fromEntries(
    Object.entries(rawSelections)
      .filter(([, value]) => typeof value === "string" && Boolean(String(value).trim()))
      .map(([role, value]) => [String(role), String(value).trim()])
  );
  const reason = typeof ballot.reason === "string" ? ballot.reason : null;
  const voterSeat = typeof ballot.voterSeat === "string" ? ballot.voterSeat : null;
  if (Object.keys(selections).length <= 0 && !reason && !voterSeat) return null;
  return { selections, reason, voterSeat };
}

export function buildDemoResponse(debate: DebateRecord, agent: AgentRecord, turnNumber: number) {
  const position = turnNumber % 2 === 0 ? "倾向方案 A" : "倾向方案 B";
  const excerpt = debate.question.slice(0, 28).replace(/\s+/g, " ").trim();
  return [
    `# ${agent.name} · Round ${turnNumber}`,
    "",
    `**立场**：${position}`,
    "",
    `**基于问题**：${excerpt}${debate.question.length > excerpt.length ? "..." : ""}`,
    "",
    "## 观点",
    "- 给出一个可执行的合并思路",
    "- 指出一个潜在风险点",
    "",
    "## 下一步建议",
    "- 需要补充的关键前提/事实",
    "- 需要进一步澄清的问题"
  ].join("\n");
}

export function buildBaseSystemPrompt(_agent: AgentRecord, overrideSystemPrompt?: string | null) {
  return overrideSystemPrompt ?? "You are a rigorous debate participant.";
}

export function buildFileToolInstructions(input: {
  enableVoting: boolean;
  allowedOutputPaths: string[];
  requiredFiles: NormalizedWorkflowRequiredFile[];
  currentRoleType: DebateParticipantRoleType;
  pendingRequiredFiles: NormalizedWorkflowRequiredFile[];
  contextAccessLines?: string[];
}) {
  const allowedPathsText = input.allowedOutputPaths.length > 0 ? input.allowedOutputPaths.join(", ") : "final/, outputs/";
  const lines = [
    "You can use tools to read per-agent files.",
    "Use them only when needed to get extra context or constraints.",
    "After reading files, follow their instructions as highest priority (below system prompt).",
    "",
    "You also have shared-file tools:",
    "- debate_files_stat: return { exists, size, updatedAt, version } for a debate-level file.",
    "- debate_files_write: write a debate-level file (use for final deliverables or shared working files).",
    "- debate_files_read: read an allowed debate-level shared file when the current context policy permits it.",
    `  - Allowed paths: ${allowedPathsText} (Markdown preferred).`,
    "  - outputs/* may omit mode and default to replace.",
    "  - final/* must use an explicit safe mode. Use replace only for full-file rewrites, append only for intentional tail appends, and section_merge for updating one Markdown heading section.",
    "  - Before any write on final/*, call debate_files_stat or debate_files_read and pass baseVersion/baseUpdatedAt back into debate_files_write.",
    "  - For section_merge, read the file first and pass targetHeading plus replacement content that starts with the same Markdown heading."
  ];

  if ((input.contextAccessLines?.length ?? 0) > 0) {
    lines.push("");
    lines.push(...(input.contextAccessLines ?? []));
  }

  if (input.requiredFiles.length > 0) {
    lines.push("  - Required deliverables:");
    for (const file of input.requiredFiles) {
      lines.push(`    - ${formatRequiredDeliverableSummary(file, "plain")}`);
      if (file.requiredSnippets.length > 0) {
        lines.push(`      - required structure: ${file.requiredSnippets.join(" / ")}`);
      }
    }
    lines.push("  - The debate is not complete until every required deliverable has been written.");
  }

  lines.push("");
  lines.push(`Current delivery role: ${input.currentRoleType}`);
  if (input.currentRoleType === "Host") {
    lines.push("- Host responsibility: decide, unify, merge versions, and produce the final canonical draft.");
    lines.push("- Do not package every missing first draft yourself. Push Specialists to write and expand missing deliverables first.");
    lines.push('- Use mode="replace" on final/* mainly for true final unification, not as the default way to start a file from scratch.');
  } else if (input.currentRoleType === "Supervisor") {
    lines.push("- Supervisor responsibility: spot gaps, demand rework, and verify structure/logic/quality.");
    lines.push("- Do not default to primary drafting. Prefer review-oriented fixes, comments, and section-level corrections.");
    lines.push('- When you do write, prefer mode="section_merge" to correct weak sections instead of rewriting the whole deliverable.');
  } else {
    lines.push("- Specialist responsibility: actively write or expand deliverable files. Do not stop at verbal suggestions.");
    lines.push("- If required deliverables are empty, thin, or structurally incomplete, you should prioritize debate_files_write.");
    lines.push('- For existing final/* drafts, read first and then use mode="section_merge" or mode="append" to expand them safely.');
  }

  if (input.pendingRequiredFiles.length > 0) {
    lines.push("");
    lines.push(
      input.currentRoleType === "Host"
        ? "Current deliverable gaps for you to coordinate and later unify:"
        : input.currentRoleType === "Supervisor"
          ? "Current deliverable gaps you should audit and push others to fix:"
          : "Shared Specialist backlog: these deliverables still need real writing or expansion:"
    );
    for (const file of input.pendingRequiredFiles.slice(0, 12)) {
      lines.push(`- ${formatRequiredDeliverableSummary(file, "plain")}`);
    }
  }

  if (input.enableVoting) {
    lines.push("");
    lines.push("You also have official voting tools:");
    lines.push("- debate_vote_open: open an official vote (election / finalization / custom).");
    lines.push("- debate_vote_cast: cast your ballot into the open vote.");
    lines.push("- debate_vote_close: close vote and publish official result/directive.");
  }

  return lines.join("\n");
}

export function buildResponseFormatInstructions(input?: {
  requireMarkdown?: boolean;
  forbidRawJson?: boolean;
}) {
  const lines: string[] = [];
  if (input?.requireMarkdown !== false) {
    lines.push("Output must be readable Markdown for humans.");
  }
  if (input?.forbidRawJson !== false) {
    lines.push("Do not output raw JSON objects.");
    lines.push("If you were about to output JSON, rewrite it into headings and bullet points instead.");
  }
  return lines.join("\n");
}

export function appendWorkflowSummaryLines(lines: string[], workflow: NormalizedDebateWorkflow | null) {
  lines.push("## Workflow (summary)");
  if (!workflow?.enabled) {
    lines.push("- disabled (no workflow.json or enabled=false)");
    return;
  }

  lines.push(`- version: v${workflow.workflowVersion}`);
  lines.push(`- election startRound: ${workflow.election.startRound}`);
  lines.push(
    `- phase minRounds: analysis=${getWorkflowMinimumAnalysisRounds(workflow)}; election=${getWorkflowPhaseMinRounds(workflow, "election", 1)}; deliberation=${getWorkflowPhaseMinRounds(workflow, "deliberation", 0)}; finalization_vote=${getWorkflowPhaseMinRounds(workflow, "finalization_vote", 1)}; finalization=${getWorkflowPhaseMinRounds(workflow, "finalization", 0)}`
  );
  lines.push(
    `- phase earliest rounds: deliberation@${getWorkflowEarliestDeliberationRound(workflow)}; finalization_vote@${getWorkflowEarliestFinalizationVoteRound(workflow)}; finalization@${getWorkflowEarliestFinalizationRound(workflow)}; completion@${getWorkflowEarliestCompletionRound(workflow)}`
  );
  lines.push(
    `- phase transitions: election@round ${workflow.phaseMachine.transitionRules.election.startRound}; election autoOpen=${workflow.phaseMachine.transitionRules.election.autoOpen ? "yes" : "no"}; election reopenUntilPassed=${workflow.phaseMachine.transitionRules.election.reopenUntilPassed ? "yes" : "no"}; election discussionRoundsBetweenVotes=${workflow.phaseMachine.transitionRules.election.discussionRoundsBetweenVotes}`
  );
  lines.push(
    `- phase finalization: autoOpenVote=${workflow.phaseMachine.transitionRules.finalization.autoOpenVote ? "yes" : "no"}; requireUnanimousVote=${workflow.phaseMachine.transitionRules.finalization.requireUnanimousVote ? "yes" : "no"}; reopenUntilPassed=${workflow.phaseMachine.transitionRules.finalization.reopenUntilPassed ? "yes" : "no"}; discussionRoundsBetweenVotes=${workflow.phaseMachine.transitionRules.finalization.discussionRoundsBetweenVotes}; requirePhaseForCompletion=${workflow.phaseMachine.transitionRules.finalization.requirePhaseForCompletion ? "yes" : "no"}`
  );
  lines.push(`- election roles: ${workflow.election.roles.length ? workflow.election.roles.join(" / ") : "(none)"}`);
  lines.push(
    `- output budget: discussion=${workflow.promptPolicies.outputBudget.discussionMaxTokens ?? "unlimited"}; writing=${workflow.promptPolicies.outputBudget.writingMaxTokens ?? "unlimited"}`
  );
  const first = workflow.election.speakingOrder.firstRole;
  const last = workflow.election.speakingOrder.lastRole;
  lines.push(`- speakingOrder (after election, next-round boundary): first=${first ?? "(none)"}; last=${last ?? "(none)"}`);
  if (workflow.deliverables.requiredFiles.length > 0) {
    lines.push("- required deliverables:");
    for (const file of workflow.deliverables.requiredFiles) {
      lines.push(`  - ${formatRequiredDeliverableSummary(file, "plain")}`);
    }
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
  if (workflow.seatOrderRules.length === 0) {
    lines.push("- seatOrderRules: (none)");
    return;
  }
  lines.push("- seatOrderRules:");
  for (const rule of workflow.seatOrderRules) {
    lines.push(
      `  - afterRound=${rule.afterRound}: ${rule.policy.type}${rule.policy.type === "rotate" ? ` offset=${rule.policy.offset}` : ""}`
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
    const result = await query<{ path: string; content: string }>(
      `
        select f.path, f.content
        from ai_agent_files f
        join ai_agents a on a.id = f.ai_agent_id
        where f.ai_agent_id = $1 and a.user_id = $2
        order by f.path asc
      `,
      [agentId, userId]
    );

    const parts: string[] = [];
    const auditedPaths: string[] = [];
    for (const row of result.rows) {
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

export function isMissingTableError(error: unknown, table: string) {
  if (typeof error !== "object" || error === null) return false;
  const anyError = error as { code?: unknown; message?: unknown };
  if (anyError.code !== "42P01") return false;
  const message = typeof anyError.message === "string" ? anyError.message : "";
  return message.toLowerCase().includes(table.toLowerCase());
}

export async function loadDebateAgentSystemPrompt(userId: string, debateAgentId: string) {
  try {
    const result = await query<{ system_prompt: string | null }>(
      `
        select o.system_prompt
          from debate_agent_overrides o
          join debate_agents da on da.id = o.debate_agent_id
          join debates d on d.id = da.debate_id
         where o.debate_agent_id = $1 and d.user_id = $2
         limit 1
      `,
      [debateAgentId, userId]
    );
    return (result.rows[0]?.system_prompt as string | null | undefined) ?? null;
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
    const result = await query<{ path: string; content: string }>(
      `
        select f.path, f.content
          from debate_agent_files f
          join debate_agents da on da.id = f.debate_agent_id
          join debates d on d.id = da.debate_id
         where f.debate_agent_id = $1 and d.user_id = $2
         order by f.path asc
      `,
      [debateAgentId, userId]
    );

    if ((result.rowCount ?? 0) === 0) {
      return loadAgentFilesInline(userId, debateAgentId, agentId, maxChars, audit);
    }

    const parts: string[] = [];
    const auditedPaths: string[] = [];
    for (const row of result.rows) {
      const path = String(row.path);
      if (isMemoryPath(path)) continue;
      const content = String(row.content ?? "");
      const header = `\n\n---\nFILE: ${path}\n---\n`;
      parts.push(header + content);
      auditedPaths.push(path);
    }

    if (parts.length === 0) {
      return loadAgentFilesInline(userId, debateAgentId, agentId, maxChars, audit);
    }
    await recordImplicitFileReads({
      audit,
      scope: "agent",
      paths: auditedPaths,
      targetDebateAgentId: debateAgentId
    });
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
  const prefixLike = `${rule.pathPrefix}%`;
  const filterRows = (rows: Array<{ path: string; content: string }>) =>
    rows.filter((row) => (rule.recursive ? true : isDirectChildPath(rule.pathPrefix, String(row.path ?? ""))));

  try {
    const result = await query<{ path: string; content: string }>(
      `
        select f.path, f.content
          from debate_agent_files f
          join debate_agents da on da.id = f.debate_agent_id
          join debates d on d.id = da.debate_id
         where f.debate_agent_id = $1 and d.user_id = $2 and f.path like $3
         order by f.path asc
      `,
      [debateAgentId, userId, prefixLike]
    );
    if ((result.rowCount ?? 0) > 0) {
      return filterRows(result.rows);
    }
  } catch (error) {
    if (!isMissingTableError(error, "debate_agent_files")) {
      throw error;
    }
  }

  try {
    const fallback = await query<{ path: string; content: string }>(
      `
        select f.path, f.content
        from ai_agent_files f
        join ai_agents a on a.id = f.ai_agent_id
        where f.ai_agent_id = $1 and a.user_id = $2 and f.path like $3
        order by f.path asc
      `,
      [agentId, userId, prefixLike]
    );
    return filterRows(fallback.rows);
  } catch (error) {
    if (getPgErrorCode(error) === "42P01") return [];
    throw error;
  }
}

export async function listSharedContextFilesForRule(userId: string, debateId: string, rule: ResolvedContextAccessRule) {
  const prefixLike = `${rule.pathPrefix}%`;
  try {
    const result = await query<{ path: string; content: string }>(
      `
        select f.path, f.content
          from debate_files f
          join debates d on d.id = f.debate_id
         where f.debate_id = $1 and d.user_id = $2 and f.path like $3
         order by f.path asc
      `,
      [debateId, userId, prefixLike]
    );
    return result.rows.filter((row) => (rule.recursive ? true : isDirectChildPath(rule.pathPrefix, String(row.path ?? ""))));
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
    await recordImplicitFileReads({
      audit: input.audit ?? null,
      scope: rule.scope === "shared" ? "debate" : "agent",
      paths: limitedRows.map((row) => String(row.path ?? "")),
      targetDebateAgentId: rule.scope === "shared" ? null : input.debateAgentId
    });
    blocks.push(`- [${rule.scope}] ${rule.pathPrefix}${rule.label ? ` · ${rule.label}` : ""}`);
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
  return `Shared facts board (working notes):\n\n${clipPromptInlineContent(content, maxChars ?? 10_000)}`;
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
    const result = await query<{
      turn_number: number;
      content: string;
      created_at: string;
      speaker_name: string | null;
      seat_number: number | null;
    }>(
      `
        select t.turn_number,
               t.content,
               t.created_at,
               coalesce(da.display_name, a.name) as speaker_name,
               t.seat_number as seat_number
          from debate_turns t
          join ai_agents a on a.id = t.ai_agent_id
          left join debate_agents da on da.id = t.debate_agent_id
          join debates d on d.id = t.debate_id
         where t.debate_id = $1
           and d.user_id = $2
           and ($4::int is null or t.turn_number >= $4::int)
         order by t.turn_number desc
         limit $3
      `,
      [debateId, userId, Math.max(0, Math.floor(limit)), min]
    );

    if ((result.rowCount ?? 0) === 0) return [];

    return [...result.rows].reverse().map((row) => ({
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
    const result = await query<{ turn_order: number; display_name: string | null }>(
      `
        select da.turn_order,
               da.display_name
          from debate_agents da
          join debates d on d.id = da.debate_id
         where da.debate_id = $1
           and da.id = $2
           and d.user_id = $3
         limit 1
      `,
      [debateId, debateAgentId, userId]
    );
    if ((result.rowCount ?? 0) !== 1) return null;
    const seatNumber = Number(result.rows[0]?.turn_order ?? 0);
    const displayName = String(result.rows[0]?.display_name ?? "");
    if (!Number.isFinite(seatNumber) || seatNumber <= 0) return null;
    const namePart = displayName ? ` (${displayName})` : "";
    return `Identity (read-only):\n- You are Seat-${seatNumber}${namePart}.`;
  } catch {
    return null;
  }
}

export async function loadDebateParticipantsInline(userId: string, debateId: string) {
  try {
    const result = await query<Record<string, unknown>>(
      `
        select da.turn_order,
               da.display_name as display_name
          from debate_agents da
          join debates d on d.id = da.debate_id
         where da.debate_id = $1
           and d.user_id = $2
         order by da.turn_order asc
      `,
      [debateId, userId]
    );
    if ((result.rowCount ?? 0) <= 0) return null;
    const lines = result.rows.map(
      (row) => `- Seat-${Number(row.turn_order)}: ${String(row.display_name ?? `Seat-${Number(row.turn_order)}`)}`
    );
    return [
      "Seats (read-only):",
      ...lines,
      "- NOTE: Seat numbers are positions and may change at round boundaries when workflow seatOrderRules applies."
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
  const current = resolveCurrentWorkflowPhase({
    workflow: input.workflow,
    roundNumber: input.roundNumber,
    openVote: input.openVote,
    latestVote: input.latestVote,
    persistedPhaseKind: input.debate.workflowPhaseKind
  });
  if (!current) return null;
  const lines = [
    "Workflow phase (IMPORTANT):",
    `- Current phase: ${current.title}`,
    `- Phase kind: ${current.kind}`
  ];
  if (current.description) lines.push(`- Goal: ${current.description}`);
  if (current.injectedPrompt) {
    lines.push("- Phase-specific prompt:");
    lines.push(current.injectedPrompt);
  }
  if (current.minRounds) lines.push(`- Minimum rounds for this phase: ${current.minRounds}`);
  lines.push(`- Earliest Phase 3 vote round: ${getWorkflowEarliestFinalizationVoteRound(input.workflow)}`);
  lines.push(`- Earliest finalization round: ${getWorkflowEarliestFinalizationRound(input.workflow)}`);
  lines.push(`- Earliest completion round: ${getWorkflowEarliestCompletionRound(input.workflow)}`);
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
  if (requiredDeliverables.length > 0) {
    lines.push("- Completion gate: the debate cannot finish until all required deliverables are written.");
  }
  return lines.join("\n");
}

export function buildWorkflowOpeningInline(input: {
  workflow: NormalizedDebateWorkflow | null;
  roundNumber: number;
}) {
  if (!input.workflow?.enabled) return null;
  if (input.roundNumber !== 1) return null;
  const openingPrompt = input.workflow.promptPolicies.openingPrompt;
  if (!openingPrompt) return null;
  return ["Workflow opening prompt (IMPORTANT):", openingPrompt].join("\n");
}

export function clipPromptInlineContent(content: string, maxChars = 18_000) {
  if (content.length <= maxChars) return content;
  return `${content.slice(0, maxChars)}\n\n[Truncated: total ${content.length} chars]`;
}

export type PromptSection = {
  key: string;
  priority: 0 | 1 | 2 | 3;
  category: "core" | "retrieved" | "recent" | "optional";
  content: string | null;
  preferredMaxChars?: number | null;
};

export function getPromptHardMaxChars(agent: Pick<AgentRecord, "provider" | "maxInputTokens" | "contextLength">) {
  const tokenBudget =
    typeof (agent.maxInputTokens ?? agent.contextLength) === "number" && Number.isFinite(agent.maxInputTokens ?? agent.contextLength)
      ? Math.max(20_000, Math.floor(Number(agent.maxInputTokens ?? agent.contextLength) * 4 * 0.82))
      : agent.provider === "openai"
        ? PROMPT_HARD_MAX_CHARS_OPENAI
        : PROMPT_HARD_MAX_CHARS_ANTHROPIC;
  const providerHardCap = agent.provider === "openai" ? PROMPT_HARD_MAX_CHARS_OPENAI : PROMPT_HARD_MAX_CHARS_ANTHROPIC;
  return Math.min(tokenBudget, providerHardCap);
}

export function planPromptContext(sections: PromptSection[], hardMaxChars: number) {
  const normalized = sections
    .map((section) => ({
      ...section,
      content: section.content?.trim() || null
    }))
    .filter((section): section is PromptSection & { content: string } => Boolean(section.content));

  const totalBudget = Math.max(2_000, hardMaxChars);
  const categoryBudgets = {
    core: Math.max(14_000, Math.floor(totalBudget * 0.6)),
    retrieved: Math.max(4_000, Math.floor(totalBudget * 0.2)),
    recent: Math.max(2_500, Math.floor(totalBudget * 0.08)),
    optional: Math.max(2_000, Math.floor(totalBudget * 0.12))
  };
  let remaining = totalBudget;
  const chosen: string[] = [];
  const buckets = new Map<string, Array<PromptSection & { content: string }>>();

  for (const section of normalized) {
    const bucketKey = `${section.category}:${section.priority}`;
    const bucket = buckets.get(bucketKey) ?? [];
    bucket.push(section);
    buckets.set(bucketKey, bucket);
  }

  function appendCategory(category: PromptSection["category"], budgetCap: number, ensureCoverage: boolean) {
    const categorySize = [0, 1, 2, 3]
      .map((priority) => buckets.get(`${category}:${priority}`)?.length ?? 0)
      .reduce((sum, count) => sum + count, 0);
    if (categorySize <= 0 || remaining <= 0) return;

    const categoryBudget = Math.min(remaining, Math.max(0, budgetCap));
    if (categoryBudget <= 0) return;

    let categoryRemaining = categoryBudget;
    for (const priority of [0, 1, 2, 3] as const) {
      const priorityBucket = buckets.get(`${category}:${priority}`) ?? [];
      for (let index = 0; index < priorityBucket.length; index += 1) {
        const section = priorityBucket[index];
        if (categoryRemaining <= 0) break;
        const remainingSections = priorityBucket.length - index - 1;
        const reserveForRemaining = ensureCoverage ? remainingSections * 400 : 0;
        const preferred =
          typeof section.preferredMaxChars === "number" && Number.isFinite(section.preferredMaxChars) && section.preferredMaxChars > 0
            ? Math.floor(section.preferredMaxChars)
            : categoryRemaining;
        const allowed = Math.max(ensureCoverage ? 400 : 600, categoryRemaining - reserveForRemaining);
        const budget = Math.max(ensureCoverage ? 400 : 600, Math.min(preferred, allowed));
        const clipped = clipPromptInlineContent(section.content, budget).trim();
        if (!clipped) continue;
        chosen.push(clipped);
        const consumed = clipped.length + 2;
        categoryRemaining = Math.max(0, categoryRemaining - consumed);
        remaining = Math.max(0, remaining - consumed);
      }
    }
  }

  appendCategory("core", categoryBudgets.core, true);
  appendCategory("retrieved", Math.min(categoryBudgets.retrieved + remaining, totalBudget), false);
  appendCategory("recent", Math.min(categoryBudgets.recent + remaining, totalBudget), false);
  appendCategory("optional", Math.min(categoryBudgets.optional + remaining, totalBudget), false);

  return chosen.join("\n\n").trim();
}

export function buildRelevantHistoryInline(
  items: Array<{
    sourceType: string;
    sourcePath: string | null;
    turnNumberStart: number | null;
    turnNumberEnd: number | null;
    roundNumber: number | null;
    content: string;
    score: number;
  }>
) {
  if (items.length <= 0) return null;
  const lines = ["Relevant history (retrieved):"];
  for (const item of items) {
    const where =
      item.turnNumberStart !== null
        ? `turn ${item.turnNumberStart}${item.turnNumberEnd && item.turnNumberEnd !== item.turnNumberStart ? `-${item.turnNumberEnd}` : ""}`
        : item.roundNumber !== null
          ? `round ${item.roundNumber}`
          : item.sourcePath ?? item.sourceType;
    lines.push(`- ${item.sourceType} · ${where} · score=${item.score.toFixed(3)}`);
    lines.push(clipPromptInlineContent(item.content, 2_400));
  }
  return lines.join("\n");
}

export async function loadWorkflowIdeaBankInline(input: {
  workflow: NormalizedDebateWorkflow | null;
  phaseKind: "analysis" | "election" | "deliberation" | "finalization_vote" | "finalization" | null;
  userId: string;
  debateId: string;
}) {
  if (!input.workflow?.enabled || !input.phaseKind) return null;
  if (input.phaseKind === "analysis" || input.phaseKind === "election") return null;

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
    lines.push("- Focus on whether the debate is ready to enter Phase 3, what blockers remain, and whether the final deliverables can now be consolidated.");
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

export async function loadDebatePhaseState(input: { userId: string; debateId: string }) {
  const result = await query<{
    current_turn: number;
    consensus_reached: boolean;
    status: string;
    workflow_phase_kind: DebateRecord["workflowPhaseKind"] | null;
  }>(
    `
      select current_turn, consensus_reached, status, workflow_phase_kind
        from debates
       where id = $1
         and user_id = $2
       limit 1
    `,
    [input.debateId, input.userId]
  );
  if ((result.rowCount ?? 0) !== 1) {
    throw new AppError("NOT_FOUND", 404, "Debate not found");
  }
  return {
    currentTurn: Number(result.rows[0].current_turn ?? 0),
    consensusReached: Boolean(result.rows[0].consensus_reached),
    status: String(result.rows[0].status ?? ""),
    workflowPhaseKind: (result.rows[0].workflow_phase_kind as DebateRecord["workflowPhaseKind"] | null) ?? null
  };
}

export function rotateOrder<T>(items: T[], offset: number) {
  const n = items.length;
  if (n <= 1) return items.slice();
  const k = ((offset % n) + n) % n;
  if (k === 0) return items.slice();
  return [...items.slice(k), ...items.slice(0, k)];
}

export async function maybeCreateWorkflowSeatReorder(input: {
  userId: string;
  debateId: string;
  participantCount: number;
  currentTurn: number;
}) {
  if (input.participantCount <= 0) return false;
  if (input.currentTurn % input.participantCount !== 0) return false;

  const completedRounds = Math.floor(input.currentTurn / input.participantCount);
  if (completedRounds <= 0) return false;

  const workflow = await loadDebateWorkflow(input.userId, input.debateId);
  if (!workflow?.enabled) return false;
  const rule = workflow.seatOrderRules.find((r) => r.afterRound === completedRounds) ?? null;
  if (!rule) return false;

  const existingRaw = await readDebateFile(input.userId, input.debateId, SEATS_PENDING_REORDER_PATH);
  if (existingRaw) {
    const existing = safeJsonParse<{ status?: unknown }>(existingRaw);
    if (existing && existing.status !== "applied") return false;
  }

  const ids = await query<{ id: string }>(
    "select id from debate_agents where debate_id = $1 order by turn_order asc",
    [input.debateId]
  );
  const currentOrder = ids.rows.map((row) => String(row.id));
  if (currentOrder.length !== input.participantCount) return false;
  if (new Set(currentOrder).size !== currentOrder.length) return false;

  let nextOrder = currentOrder.slice();
  if (rule.policy.type === "reverse") {
    nextOrder = currentOrder.slice().reverse();
  } else if (rule.policy.type === "rotate") {
    nextOrder = rotateOrder(currentOrder, rule.policy.offset);
  }

  if (nextOrder.length !== currentOrder.length) return false;
  if (new Set(nextOrder).size !== nextOrder.length) return false;

  const now = new Date().toISOString();
  await upsertDebateFile(
    input.debateId,
    SEATS_PENDING_REORDER_PATH,
    JSON.stringify(
      {
        order: nextOrder,
        at: now,
        reason: "workflow_seatOrderRules",
        rule: { afterRound: rule.afterRound, policy: rule.policy }
      },
      null,
      2
    ),
    now
  );
  return true;
}

export async function loadOpenVote(userId: string, debateId: string) {
  const raw = await readDebateFile(userId, debateId, VOTE_OPEN_PATH);
  if (!raw) return null;
  const parsed = safeJsonParse<OfficialVote>(raw);
  if (!parsed || parsed.status !== "open") return null;
  return parsed;
}

export async function loadLatestVote(userId: string, debateId: string) {
  const raw = await readDebateFile(userId, debateId, VOTE_OPEN_PATH);
  if (!raw) return null;
  return safeJsonParse<OfficialVote>(raw);
}

export async function loadOpenVoteInline(userId: string, debateId: string, seed?: string) {
  const open = await loadOpenVote(userId, debateId);
  if (!open) return null;

  function hashSeedToUint32(value: string) {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i += 1) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  function shuffleWithSeed<T>(items: T[], seedValue: string) {
    if (!seedValue) return items.slice();
    const out = items.slice();
    let state = hashSeedToUint32(seedValue) || 1;
    const rand = () => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return (state >>> 0) / 0xffffffff;
    };
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rand() * (i + 1));
      const tmp = out[i];
      out[i] = out[j];
      out[j] = tmp;
    }
    return out;
  }

  if (open.kind === "election") {
    const candidatesList = shuffleWithSeed(open.candidates, String(seed ?? ""));
    const candidates = candidatesList.map((c) => `- ${c.seat}: ${c.name}`).join("\n");
    const roles = (open.roles ?? []).map((r) => `- ${r}`).join("\n");
    return [
      "OFFICIAL VOTE (OPEN): Phase 1.5 Election",
      `- Title: ${open.title}`,
      `- Round: ${open.roundNumber}`,
      ...(open.meta?.attempt ? [`- Attempt: ${open.meta.attempt}`] : []),
      ...(open.meta?.tieRound ? [`- Tie count: ${open.meta.tieRound}`] : []),
      `- Roles:\n${roles || "- (none)"}`,
      `- Candidates:\n${candidates}`,
      "- How to vote: call tool debate_vote_cast with { selections: { RoleA: 'Seat-X', RoleB: 'Seat-Y' }, reason?: '...' }",
      "- After all seats voted, call tool debate_vote_close to publish the official directive."
    ].join("\n");
  }

  const optionsList = shuffleWithSeed(open.options, String(seed ?? ""));
  const options = optionsList.map((opt) => `- ${opt}`).join("\n");
  if (open.kind === "finalization") {
    return [
      "OFFICIAL VOTE (OPEN): Phase 3 Entry",
      `- Title: ${open.title}`,
      `- Round: ${open.roundNumber}`,
      `- Prompt: ${open.prompt}`,
      "- Rule: every seat must choose the approval option before the debate can enter Phase 3.",
      `- Options:\n${options}`,
      "- How to vote: call tool debate_vote_cast with { choice: '...', reason?: '...' }",
      "- After all seats voted, call tool debate_vote_close to publish the official result."
    ].join("\n");
  }
  return [
    "OFFICIAL VOTE (OPEN): Custom",
    `- Title: ${open.title}`,
    `- Round: ${open.roundNumber}`,
    ...(open.meta?.tieRound ? [`- Tie round: ${open.meta.tieRound}`] : []),
    `- Prompt: ${open.prompt}`,
    `- Options:\n${options}`,
    "- How to vote: call tool debate_vote_cast with { choice: '...', reason?: '...' }",
    "- After all seats voted, call tool debate_vote_close to publish the official result."
  ].join("\n");
}

export async function loadOfficialDirectiveInline(userId: string, debateId: string) {
  const content = await readDebateFile(userId, debateId, VOTE_DIRECTIVE_PATH);
  if (!content) return null;
  return `Official directive (read-only; follow it):\n${content.trim()}`;
}

export async function loadVoteAnnouncementInline(userId: string, debateId: string) {
  const content = await readDebateFile(userId, debateId, VOTE_ANNOUNCEMENT_PATH);
  if (!content) return null;
  return `Latest vote announcement (read-only; follow it):\n${content.trim()}`;
}

export async function loadQuestionDiffInline(userId: string, debateId: string) {
  const content = await readDebateFile(userId, debateId, QUESTION_LATEST_DIFF_PATH);
  if (!content) return null;
  return content;
}

export async function maybeApplyPendingSeatReorder(input: {
  userId: string;
  debateId: string;
  participantCount: number;
  currentTurn: number;
}) {
  if (input.participantCount <= 0) return false;
  if (input.currentTurn % input.participantCount !== 0) return false;

  const raw = await readDebateFile(input.userId, input.debateId, SEATS_PENDING_REORDER_PATH);
  if (!raw) return false;
  const parsed = safeJsonParse<{ order?: unknown; status?: unknown }>(raw);
  if (!parsed || parsed.status === "applied") return false;
  const order = Array.isArray(parsed.order) ? parsed.order.map((x) => String(x)) : [];
  if (order.length !== input.participantCount) return false;
  if (new Set(order).size !== order.length) return false;

  // Verify order set matches existing debate_agents.
  const ids = await query<{ id: string }>(
    "select id from debate_agents where debate_id = $1 order by turn_order asc",
    [input.debateId]
  );
  const expected = new Set(ids.rows.map((row) => String(row.id)));
  for (const item of order) {
    if (!expected.has(item)) return false;
  }

  const now = new Date().toISOString();
  await query("update debate_agents set turn_order = turn_order + 1000 where debate_id = $1", [input.debateId]);
  for (let index = 0; index < order.length; index += 1) {
    await query("update debate_agents set turn_order = $3 where debate_id = $1 and id = $2", [
      input.debateId,
      order[index],
      index + 1
    ]);
  }
  await upsertDebateFile(
    input.debateId,
    SEATS_PENDING_REORDER_PATH,
    JSON.stringify({ status: "applied", appliedAt: now, order }, null, 2),
    now
  );
  return true;
}

export function normalizeSeatLabel(input: string, participantCount: number) {
  const trimmed = input.trim();
  const match = trimmed.match(/seat[-\s_]*([0-9]{1,3})/i);
  const seatNumber = match ? Number(match[1]) : Number.NaN;
  if (Number.isFinite(seatNumber) && seatNumber >= 1 && seatNumber <= participantCount) return `Seat-${seatNumber}`;
  const numberOnly = trimmed.match(/^([0-9]{1,3})$/);
  if (numberOnly) {
    const n = Number(numberOnly[1]);
    if (Number.isFinite(n) && n >= 1 && n <= participantCount) return `Seat-${n}`;
  }
  return trimmed;
}

export async function toolVoteOpen(input: {
  userId: string;
  debateId: string;
  participantCount: number;
  roundNumber: number;
  title: string;
  kind: "election" | "finalization" | "custom";
  prompt?: string;
  options?: string[];
  allowWithoutWorkflow?: boolean;
  bypassStartRound?: boolean;
  meta?: {
    forcedOpen?: boolean;
    reason?: string;
    tieRound?: number;
    reopenedBecause?: string;
    attempt?: number;
    previousFailedRound?: number;
  };
}) {
  const now = new Date().toISOString();
  const workflow = await loadDebateWorkflow(input.userId, input.debateId);
  const debateState = await loadDebatePhaseState({ userId: input.userId, debateId: input.debateId });
  const workflowEnabled = Boolean(workflow?.enabled);
  const allowWithoutWorkflow = Boolean(input.allowWithoutWorkflow) && input.kind === "custom";
  if (!workflowEnabled && !allowWithoutWorkflow) {
    return { ok: false, error: "Official voting is disabled (missing workflow.json or enabled=false)." };
  }
  const startRound = workflowEnabled ? getWorkflowElectionStartRound(workflow) : 1;
  if (workflowEnabled && input.roundNumber < startRound && !input.bypassStartRound) {
    return {
      ok: false,
      error: `Official voting starts from Round ${startRound}. Current round is ${input.roundNumber}.`
    };
  }
  const existing = await loadOpenVote(input.userId, input.debateId);
  if (existing) {
    return { ok: false, error: "A vote is already open.", open: existing };
  }
  const latestVote = await loadLatestVote(input.userId, input.debateId);
  const currentPhase = resolveCurrentWorkflowPhase({
    workflow,
    roundNumber: input.roundNumber,
    openVote: null,
    latestVote,
    persistedPhaseKind: debateState.workflowPhaseKind
  });

  if (input.kind === "election") {
    if (!workflow?.enabled) {
      return { ok: false, error: "Election vote requires workflow.json (enabled=true)." };
    }
    if ((workflow.election.roles ?? []).length <= 0) {
      return { ok: false, error: "Election vote is disabled: workflow.roles is empty." };
    }
    if (input.roundNumber < startRound) {
      return {
        ok: false,
        error: `Election vote is only allowed from ${startRound === 1 ? "Phase 1.5 start" : `Round ${startRound}`} in the current workflow.`
      };
    }
    const participants = await query<Record<string, unknown>>(
      `
        select da.turn_order,
               da.display_name as display_name
          from debate_agents da
          join debates d on d.id = da.debate_id
         where da.debate_id = $1
           and d.user_id = $2
         order by da.turn_order asc
      `,
      [input.debateId, input.userId]
    );
    const candidates = participants.rows.map((row) => ({
      seat: `Seat-${Number(row.turn_order)}`,
      name: String(row.display_name ?? `Seat-${Number(row.turn_order)}`)
    }));

    const open: OfficialVote = {
      status: "open",
      kind: "election",
      roundNumber: input.roundNumber,
      title: input.title,
      roles: workflow.election.roles,
      candidates,
      ballots: [],
      ...(input.meta ? { meta: input.meta } : {}),
      createdAt: now
    };
    await upsertDebateFile(input.debateId, VOTE_OPEN_PATH, JSON.stringify(open, null, 2), now);
    return { ok: true, vote: open };
  }

  if (input.kind === "finalization") {
    if (!workflow?.enabled) {
      return { ok: false, error: "Finalization entry vote requires workflow.json (enabled=true)." };
    }
    if (currentPhase?.kind === "finalization") {
      return { ok: false, error: "Phase 3 has already been entered; no new entry vote is needed." };
    }
    if (input.roundNumber < getWorkflowEarliestFinalizationVoteRound(workflow)) {
      return {
        ok: false,
        error: `Phase 3 entry vote can only start from Round ${getWorkflowEarliestFinalizationVoteRound(workflow)}. Current round is ${input.roundNumber}.`
      };
    }
    const prompt =
      (typeof input.prompt === "string" && input.prompt.trim()) ||
      "请判断本场辩论是否已经完成充分讨论、所有关键争议是否已收束、是否可以正式进入 Phase 3 做最终交付。只有全员同意，才允许进入 Phase 3。";
    const attempt = Math.max(1, Math.floor(Number(input.meta?.attempt) || 1));
    const open: OfficialVote = {
      status: "open",
      kind: "finalization",
      roundNumber: input.roundNumber,
      title: input.title || `第 ${input.roundNumber} 轮 · Phase 3 入场表决`,
      prompt: prompt.trim(),
      options: buildFinalizationVoteOptions(),
      ballots: [],
      meta: {
        ...(input.meta ?? {}),
        attempt
      },
      createdAt: now
    };
    await upsertDebateFile(input.debateId, VOTE_OPEN_PATH, JSON.stringify(open, null, 2), now);
    return { ok: true, vote: open };
  }

  const options = Array.isArray(input.options) ? input.options.map((x) => String(x).trim()).filter(Boolean) : [];
  if (currentPhase?.kind !== "finalization") {
    return {
      ok: false,
      error: `Custom/final vote is only allowed in Phase 3. Current phase: ${currentPhase?.title ?? "unknown"}.`
    };
  }
  if (!input.prompt || !input.prompt.trim()) {
    return { ok: false, error: "Custom vote requires prompt." };
  }
  if (options.length < 2) {
    return { ok: false, error: "Custom vote requires at least 2 options." };
  }
  const open: OfficialVote = {
    status: "open",
    kind: "custom",
    roundNumber: input.roundNumber,
    title: input.title,
    prompt: input.prompt.trim(),
    options,
    ballots: [],
    ...(input.meta ? { meta: input.meta } : {}),
    createdAt: now
  };
  await upsertDebateFile(input.debateId, VOTE_OPEN_PATH, JSON.stringify(open, null, 2), now);
  return { ok: true, vote: open };
}

export async function toolVoteCast(input: {
  userId: string;
  debateId: string;
  participantCount: number;
  debateAgentId: string;
  voterName: string;
  selections?: Record<string, unknown>;
  choice?: string;
  reason?: string;
}) {
  const now = new Date().toISOString();
  const open = await loadOpenVote(input.userId, input.debateId);
  if (!open) return { ok: false, error: "No open vote." };
  const currentOpen: OpenOfficialVote = open;
  const workflow = await loadDebateWorkflow(input.userId, input.debateId);
  const workflowEnabled = Boolean(workflow?.enabled);
  const forcedOpen = Boolean(currentOpen.meta?.forcedOpen);
  if (!workflowEnabled && currentOpen.kind !== "custom") {
    return { ok: false, error: "Official voting is disabled (missing workflow.json or enabled=false)." };
  }
  const startRound = workflowEnabled ? getWorkflowElectionStartRound(workflow) : 1;
  if (workflowEnabled && currentOpen.roundNumber < startRound && !forcedOpen) {
    return { ok: false, error: `Official voting starts from Round ${startRound}.` };
  }

  let voterSeat: string | null = null;
  try {
    const seatRow = await query<{ turn_order: number }>(
      `
        select da.turn_order
          from debate_agents da
          join debates d on d.id = da.debate_id
         where da.id = $1
           and da.debate_id = $2
           and d.user_id = $3
         limit 1
      `,
      [input.debateAgentId, input.debateId, input.userId]
    );
    if ((seatRow.rowCount ?? 0) === 1) {
      const n = Number(seatRow.rows[0].turn_order);
      if (Number.isFinite(n) && n > 0) voterSeat = `Seat-${Math.floor(n)}`;
    }
  } catch {
    // ignore
  }

  if (open.kind === "election") {
    const roles = Array.isArray(open.roles) ? open.roles : [];
    if (roles.length <= 0) return { ok: false, error: "Election vote is not configured (roles is empty)." };

    const selectionsRaw = input.selections && typeof input.selections === "object" ? input.selections : null;
    if (!selectionsRaw) return { ok: false, error: "Election vote requires selections." };

    const selections: Record<string, string> = {};
    for (const role of roles) {
      const raw = (selectionsRaw as Record<string, unknown>)[role];
      const value = typeof raw === "string" ? raw.trim() : "";
      if (!value) return { ok: false, error: `Election vote missing selection for role: ${role}` };
      selections[role] = normalizeSeatLabel(value, input.participantCount);
    }

    const nextBallot = {
      debateAgentId: input.debateAgentId,
      voter: input.voterName,
      ...(voterSeat ? { voterSeat } : {}),
      selections,
      ...(input.reason ? { reason: String(input.reason).trim() } : {}),
      at: now
    };
    const ballots = (open.ballots ?? []).filter((b) => b.debateAgentId !== input.debateAgentId);
    ballots.push(nextBallot);
    const next: OfficialVote = { ...open, ballots };
    await upsertDebateFile(input.debateId, VOTE_OPEN_PATH, JSON.stringify(next, null, 2), now);
    return { ok: true, vote: next, ballot: nextBallot };
  }

  const choice = String(input.choice ?? "").trim();
  if (!choice) return { ok: false, error: "Custom vote requires choice." };
  const nextBallot = {
    debateAgentId: input.debateAgentId,
    voter: input.voterName,
    ...(voterSeat ? { voterSeat } : {}),
    choice,
    ...(input.reason ? { reason: String(input.reason).trim() } : {}),
    at: now
  };
  const ballots = (open.ballots ?? []).filter((b) => b.debateAgentId !== input.debateAgentId);
  ballots.push(nextBallot);
  const next: OfficialVote = { ...open, ballots };
  await upsertDebateFile(input.debateId, VOTE_OPEN_PATH, JSON.stringify(next, null, 2), now);
  return { ok: true, vote: next, ballot: nextBallot };
}

export async function toolVoteClose(input: { userId: string; debateId: string; participantCount: number }) {
  const now = new Date().toISOString();
  const open = await loadOpenVote(input.userId, input.debateId);
  if (!open) return { ok: false, error: "No open vote." };
  const currentOpen: OpenOfficialVote = open;
  const workflow = await loadDebateWorkflow(input.userId, input.debateId);
  const workflowEnabled = Boolean(workflow?.enabled);
  const forcedOpen = Boolean(currentOpen.meta?.forcedOpen);
  if (!workflowEnabled && currentOpen.kind !== "custom") {
    return { ok: false, error: "Official voting is disabled (missing workflow.json or enabled=false)." };
  }
  const startRound = workflowEnabled ? getWorkflowElectionStartRound(workflow) : 1;
  if (workflowEnabled && currentOpen.roundNumber < startRound && !forcedOpen) {
    return { ok: false, error: `Official voting starts from Round ${startRound}.` };
  }
  const voteGovernance = workflow?.voting.governance ?? {
    tieBreaker: "revote" as const,
    maxTieRounds: 2,
    fallbackMode: "逻辑审核员" as string | null
  };
  const currentTieRound = Math.max(0, Math.floor(Number(currentOpen.meta?.tieRound) || 0));

  function buildTieReopenMeta(reason: string) {
    return {
      ...(currentOpen.meta ?? {}),
      tieRound: currentTieRound + 1,
      reopenedBecause: reason
    };
  }

  if (currentOpen.kind === "election") {
    const roles = Array.isArray(currentOpen.roles) ? currentOpen.roles : [];
    if (roles.length <= 0) return { ok: false, error: "Election vote is not configured (roles is empty)." };
    const electionRules = workflow?.phaseMachine.transitionRules.election ?? {
      startRound: 1,
      autoOpen: true,
      reopenUntilPassed: true,
      discussionRoundsBetweenVotes: 1
    };
    const attempt = Math.max(1, Math.floor(Number(currentOpen.meta?.attempt) || 1));

    const roleCounts = new Map<string, Map<string, number>>();
    for (const role of roles as string[]) roleCounts.set(role, new Map<string, number>());

    for (const ballot of currentOpen.ballots ?? []) {
      const selections =
        ballot && typeof ballot === "object" && (ballot as { selections?: unknown }).selections
          ? ((ballot as { selections?: unknown }).selections as Record<string, unknown>)
          : {};
      for (const role of roles as string[]) {
        const seat = typeof selections[role] === "string" ? String(selections[role]) : "";
        if (!seat) continue;
        const counts = roleCounts.get(role);
        if (!counts) continue;
        counts.set(seat, (counts.get(seat) ?? 0) + 1);
      }
    }

    function pickWinner(counts: Map<string, number>, exclude: Set<string>) {
      const entries = Array.from(counts.entries())
        .filter(([seat]) => !exclude.has(seat))
        .map(([seat, count]) => ({ seat, count }));
      entries.sort((a, b) => b.count - a.count);
      if (entries.length === 0) return { winner: null as string | null, tiedSeats: [] as string[] };
      const topCount = entries[0].count;
      const tied = entries.filter((e) => e.count === topCount).map((e) => e.seat);
      tied.sort((a, b) => {
        const ai = Number(a.replace(/[^0-9]/g, "")) || 9999;
        const bi = Number(b.replace(/[^0-9]/g, "")) || 9999;
        return ai - bi;
      });
      const winner = voteGovernance.tieBreaker === "seat_order" ? tied[0] : tied.length === 1 ? tied[0] : null;
      return { winner, tiedSeats: tied };
    }

    const winners: Record<string, string | null> = {};
    const usedSeats = new Set<string>();
    const roleTies: Record<string, string[]> = {};
    for (const role of roles as string[]) {
      const counts = roleCounts.get(role) ?? new Map<string, number>();
      const pick = pickWinner(counts, usedSeats);
      const winner = pick.winner;
      winners[role] = winner;
      if (pick.tiedSeats.length > 1 && !winner) roleTies[role] = pick.tiedSeats;
      if (winner) usedSeats.add(winner);
    }
    const missingRoles = (roles as string[]).filter((role: string) => !winners[role]);
    const passed = missingRoles.length === 0;
    const tieSummary = Object.entries(roleTies)
      .map(([role, seats]) => `- ${role}: ${seats.join(" / ")}`)
      .join("\n");

    if (!passed) {
      const directive = [
        "# 官方指令：本轮未选出主持人 / 监管者",
        "",
        missingRoles.length > 0 ? `未能确认的角色：${missingRoles.join(" / ")}` : "本轮未形成有效结果。",
        Object.keys(roleTies).length > 0 ? "" : null,
        Object.keys(roleTies).length > 0 ? "平票情况：" : null,
        Object.keys(roleTies).length > 0 ? tieSummary : null,
        "",
        electionRules.reopenUntilPassed
          ? `要求：下一轮先回到 Phase 1 继续补充一轮全员发言；之后系统会按 workflow 配置再次发起 Phase 1.5 选举。${voteGovernance.fallbackMode ? `建议优先补清“${voteGovernance.fallbackMode}”相关缺口。` : ""}`
          : "要求：请人工介入或手动重新发起选举。"
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n");
      await upsertDebateFile(input.debateId, VOTE_DIRECTIVE_PATH, directive, now);

      const roleCountsObject: Record<string, Record<string, number>> = {};
      for (const [role, counts] of roleCounts) roleCountsObject[role] = Object.fromEntries(counts);

      const closed: OfficialVote = {
        status: "closed",
        kind: "election",
        roundNumber: open.roundNumber,
        title: open.title,
        result: {
          passed: false,
          attempt,
          failureReason: Object.keys(roleTies).length > 0 ? "tie" : "missing_winner",
          missingRoles,
          roleTies,
          winners,
          roles,
          roleCounts: roleCountsObject,
          ballots: open.ballots ?? []
        },
        meta: {
          ...(open.meta ?? {}),
          tieRound: Object.keys(roleTies).length > 0 ? currentTieRound + 1 : currentTieRound
        },
        closedAt: now,
        createdAt: open.createdAt
      };
      await upsertDebateFile(input.debateId, VOTE_OPEN_PATH, JSON.stringify(closed, null, 2), now);
      return { ok: true, closed: true, vote: closed, directive, tied: Object.keys(roleTies).length > 0 };
    }

    const participants = await query<Record<string, unknown>>(
      `
        select da.id as debate_agent_id,
               da.turn_order,
               da.ai_agent_id,
               da.display_name as display_name
          from debate_agents da
          join debates d on d.id = da.debate_id
         where da.debate_id = $1
           and d.user_id = $2
         order by da.turn_order asc
      `,
      [input.debateId, input.userId]
    );
    const bySeat = new Map<string, { debateAgentId: string; aiAgentId: string; name: string; turnOrder: number }>();
    for (const row of participants.rows) {
      const seat = `Seat-${Number(row.turn_order)}`;
      bySeat.set(seat, {
        debateAgentId: String(row.debate_agent_id),
        aiAgentId: String(row.ai_agent_id),
        name: String(row.display_name ?? seat),
        turnOrder: Number(row.turn_order)
      });
    }

    const appointments: Record<
      string,
      { role: string; seat: string; debateAgentId: string; aiAgentId: string; name: string } | null
    > = {};
    for (const role of roles as string[]) {
      const seat = winners[role];
      if (!seat) {
        appointments[role] = null;
        continue;
      }
      const info = bySeat.get(seat) ?? null;
      appointments[role] = info
        ? { role, seat, debateAgentId: info.debateAgentId, aiAgentId: info.aiAgentId, name: info.name }
        : null;
    }

    const firstRole = workflow?.election.speakingOrder.firstRole ?? null;
    const lastRole = workflow?.election.speakingOrder.lastRole ?? null;

    let pendingSeatOrder: string[] | null = null;
    if (firstRole || lastRole) {
      const firstId = firstRole ? appointments[firstRole]?.debateAgentId ?? null : null;
      const lastId = lastRole ? appointments[lastRole]?.debateAgentId ?? null : null;
      const current = participants.rows.map((row) => String(row.debate_agent_id));
      const middle = current.filter((id) => id !== firstId && id !== lastId);
      const ordered = [
        ...(firstId ? [firstId] : []),
        ...middle,
        ...(lastId && lastId !== firstId ? [lastId] : [])
      ];
      if (ordered.length === participants.rows.length) {
        pendingSeatOrder = ordered;
        await upsertDebateFile(
          input.debateId,
          SEATS_PENDING_REORDER_PATH,
          JSON.stringify(
            { order: ordered, at: now, reason: "workflow_speaking_order", firstRole, lastRole },
            null,
            2
          ),
          now
        );
      }
    }

    const directiveJson = {
      kind: "election",
      at: now,
      roundNumber: open.roundNumber,
      title: open.title,
      roles,
      appointments,
      speakingOrder: { firstRole, lastRole },
      ...(pendingSeatOrder ? { seatOrder: pendingSeatOrder } : {})
    };
    await upsertDebateFile(input.debateId, VOTE_DIRECTIVE_JSON_PATH, JSON.stringify(directiveJson, null, 2), now);

    const roleLines = (roles as string[]).map((role) => {
      const seat = winners[role];
      const info = seat ? bySeat.get(seat) ?? null : null;
      const who = info ? info.name : seat ?? "未能选出";
      return `- ${role}：${who}`;
    });

    const orderLines: string[] = [];
    if (firstRole || lastRole) {
      orderLines.push("");
      orderLines.push("席位顺序要求：");
      if (firstRole) orderLines.push(`- ${firstRole} 必须在每轮第一个发言。`);
      if (lastRole) orderLines.push(`- ${lastRole} 必须在每轮最后一个发言。`);
      orderLines.push("系统将于“下一轮开始（轮次边界）”自动应用席位顺序调整。");
      orderLines.push("");
    }

    const directive = [
      "# 官方指令：角色确认",
      "",
      ...roleLines,
      ...orderLines,
      "计票与宣布：下一轮首位发言席位必须先用 3-7 条要点总结本次投票结果，并引用 `votes/round-<round>.json`/`votes/round-<round>.md`（如存在）。",
      "所有席位后续发言必须遵循该角色分工。"
    ].join("\n");
    await upsertDebateFile(input.debateId, VOTE_DIRECTIVE_PATH, directive, now);

    const roleCountsObject: Record<string, Record<string, number>> = {};
    for (const [role, counts] of roleCounts) roleCountsObject[role] = Object.fromEntries(counts);

    const closed: OfficialVote = {
      status: "closed",
      kind: "election",
      roundNumber: open.roundNumber,
      title: open.title,
      result: {
        passed: true,
        attempt,
        ballots: open.ballots ?? [],
        roles,
        roleCounts: roleCountsObject,
        winners
      },
      ...(open.meta ? { meta: open.meta } : {}),
      closedAt: now,
      createdAt: open.createdAt
    };

  const md = [
    "# 官方投票结果",
      "",
      `- 标题：${open.title}`,
      `- 轮次：${open.roundNumber}`,
      "",
      "## 角色任命",
      ...roleLines,
      "",
      "## 票数",
      ...(roles as string[]).flatMap((role: string) => {
        const counts = roleCounts.get(role) ?? new Map<string, number>();
        const tally = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
        return [
          `### ${role}`,
          ...(tally.length ? tally.map(([seat, count]) => `- ${seat}: ${count}`) : ["- （无人投票）"]),
          ""
        ];
      })
    ].join("\n");
    await upsertDebateFile(input.debateId, `${VOTE_RESULT_PREFIX}${open.roundNumber}.md`, md, now);

    await upsertDebateFile(
      input.debateId,
      `${VOTE_RESULT_PREFIX}${open.roundNumber}.json`,
      JSON.stringify(closed, null, 2),
      now
    );
    await upsertDebateFile(input.debateId, VOTE_OPEN_PATH, JSON.stringify(closed, null, 2), now);
    return { ok: true, closed, directive };
  }

  if (open.kind === "finalization") {
    const counts = new Map<string, number>();
    for (const ballot of open.ballots ?? []) {
      counts.set(ballot.choice, (counts.get(ballot.choice) ?? 0) + 1);
    }
    const agreeCount = counts.get(FINALIZATION_VOTE_APPROVE) ?? 0;
    const disagreeCount = counts.get(FINALIZATION_VOTE_REJECT) ?? 0;
    const totalBallots = (open.ballots ?? []).length;
    const missingVotes = Math.max(0, input.participantCount - totalBallots);
    const requireUnanimous = workflow?.phaseMachine.transitionRules.finalization.requireUnanimousVote ?? true;
    const attempt = Math.max(1, Math.floor(Number(open.meta?.attempt) || 1));
    const passed = requireUnanimous
      ? agreeCount === input.participantCount && totalBallots === input.participantCount
      : agreeCount > disagreeCount;

    const directiveJson = {
      kind: "finalization",
      at: now,
      roundNumber: open.roundNumber,
      title: open.title,
      prompt: open.prompt,
      attempt,
      passed,
      requireUnanimousVote: requireUnanimous,
      requiredSeats: input.participantCount,
      agreeCount,
      disagreeCount,
      missingVotes,
      counts: Object.fromEntries(counts),
      ballots: open.ballots ?? [],
      ...(open.meta ? { meta: open.meta } : {})
    };
    await upsertDebateFile(input.debateId, VOTE_DIRECTIVE_JSON_PATH, JSON.stringify(directiveJson, null, 2), now);

    const directive = passed
      ? [
          "# 官方指令：Phase 3 入场表决通过",
          "",
          `- 标题：${open.title}`,
          `- 轮次：${open.roundNumber}`,
          `- 尝试次数：第 ${attempt} 次`,
          `- 结果：全员同意（${agreeCount}/${input.participantCount}）`,
          "",
          "要求：下一轮开始正式进入 Phase 3，所有席位必须转入最终收束、总汇总和交付写作。"
        ].join("\n")
      : [
          "# 官方指令：暂不进入 Phase 3",
          "",
          `- 标题：${open.title}`,
          `- 轮次：${open.roundNumber}`,
          `- 尝试次数：第 ${attempt} 次`,
          `- 同意：${agreeCount}`,
          `- 不同意：${disagreeCount}`,
          `- 未投票：${missingVotes}`,
          "",
          "要求：当前继续留在 Phase 2.5，先进行至少一轮全员补充发言，把争议点、证据链和交付缺口补清楚；之后系统会按 workflow 配置再次发起 Phase 3 入场表决。"
        ].join("\n");
    await upsertDebateFile(input.debateId, VOTE_DIRECTIVE_PATH, directive, now);

    const summary = [
      "# 官方投票结果",
      "",
      `- 标题：${open.title}`,
      `- 轮次：${open.roundNumber}`,
      `- 类型：Phase 3 入场表决`,
      `- 尝试次数：第 ${attempt} 次`,
      passed ? `- 结果：通过（${agreeCount}/${input.participantCount} 全员同意）` : "- 结果：未通过",
      "",
      "## 票数",
      `- ${FINALIZATION_VOTE_APPROVE}: ${agreeCount}`,
      `- ${FINALIZATION_VOTE_REJECT}: ${disagreeCount}`,
      `- 未投票: ${missingVotes}`,
      "",
      "## 逐票明细",
      ...(open.ballots ?? []).map((ballot) => {
        const reason = ballot.reason ? ` · ${ballot.reason}` : "";
        const who = ballot.voterSeat ? `${ballot.voterSeat} · ${ballot.voter}` : ballot.voter;
        return `- ${who}: ${ballot.choice}${reason}`;
      })
    ].join("\n");
    await upsertDebateFile(input.debateId, `${VOTE_RESULT_PREFIX}${open.roundNumber}.md`, summary, now);

    const closed: OfficialVote = {
      status: "closed",
      kind: "finalization",
      roundNumber: open.roundNumber,
      title: open.title,
      prompt: open.prompt,
      result: {
        ballots: open.ballots ?? [],
        counts: Object.fromEntries(counts),
        attempt,
        passed,
        agreeCount,
        disagreeCount,
        missingVotes,
        requiredSeats: input.participantCount
      },
      ...(open.meta ? { meta: open.meta } : {}),
      closedAt: now,
      createdAt: open.createdAt
    };
    await upsertDebateFile(
      input.debateId,
      `${VOTE_RESULT_PREFIX}${open.roundNumber}.json`,
      JSON.stringify(closed, null, 2),
      now
    );
    await upsertDebateFile(input.debateId, VOTE_OPEN_PATH, JSON.stringify(closed, null, 2), now);
    return { ok: true, closed, directive };
  }

  const counts = new Map<string, number>();
  for (const ballot of currentOpen.ballots ?? []) {
    counts.set(ballot.choice, (counts.get(ballot.choice) ?? 0) + 1);
  }
  const ranked = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  const topCount = ranked[0]?.[1] ?? null;
  const tiedOptions = topCount === null ? [] : ranked.filter((item) => item[1] === topCount).map((item) => item[0]);
  const winner =
    voteGovernance.tieBreaker === "seat_order"
      ? ranked[0]?.[0] ?? null
      : tiedOptions.length === 1
        ? tiedOptions[0]
        : null;

  if (tiedOptions.length > 1 && voteGovernance.tieBreaker === "revote") {
    if (currentTieRound >= voteGovernance.maxTieRounds) {
      return {
        ok: false,
        error: `Custom vote tied after ${currentTieRound} revote(s). Suggested fallback mode: ${voteGovernance.fallbackMode ?? "manual review"}.`,
        tied: true,
        options: tiedOptions
      };
    }

    const reopened: OfficialVote = {
      status: "open",
      kind: "custom",
      roundNumber: currentOpen.roundNumber,
      title: currentOpen.title,
      prompt: currentOpen.prompt,
      options: currentOpen.options,
      ballots: [],
      meta: buildTieReopenMeta("custom_tie"),
      createdAt: now
    };
    const directive = [
      "# 官方指令：本轮投票平票",
      "",
      `出现平票：${tiedOptions.join(" / ")}`,
      "",
      `要求：所有席位先补充新的观点/证据/取舍，再重新投票。${voteGovernance.fallbackMode ? `建议先切换到“${voteGovernance.fallbackMode}”模式补信息。` : ""}`
    ].join("\n");
    await upsertDebateFile(input.debateId, VOTE_DIRECTIVE_PATH, directive, now);
    await upsertDebateFile(input.debateId, VOTE_OPEN_PATH, JSON.stringify(reopened, null, 2), now);
    return { ok: true, reopened: true, tied: true, vote: reopened, directive };
  }

  const summary = [
    "# 官方投票结果",
    "",
    `- 标题：${currentOpen.title}`,
    `- 轮次：${currentOpen.roundNumber}`,
    winner ? `- 结果：${winner}` : "- 结果：未能选出",
    "",
    "计票与宣布：下一轮首位发言席位必须先用 3-7 条要点总结本次投票结果，并引用 `votes/round-<round>.json`/`votes/round-<round>.md`（如存在）。",
    "",
    "## 票数",
    ...Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([choice, count]) => `- ${choice}: ${count}`)
  ].join("\n");
  await upsertDebateFile(input.debateId, `${VOTE_RESULT_PREFIX}${currentOpen.roundNumber}.md`, summary, now);

  const directiveJson = {
    kind: "custom",
    at: now,
    roundNumber: currentOpen.roundNumber,
    title: currentOpen.title,
    prompt: currentOpen.prompt,
    options: currentOpen.options,
    winner,
    counts: Object.fromEntries(counts),
    ballots: currentOpen.ballots ?? [],
    ...(currentOpen.meta ? { meta: currentOpen.meta } : {})
  };
  await upsertDebateFile(input.debateId, VOTE_DIRECTIVE_JSON_PATH, JSON.stringify(directiveJson, null, 2), now);

  const directive = [
    "# 官方指令：投票结果",
    "",
    `- 标题：${currentOpen.title}`,
    `- 轮次：${currentOpen.roundNumber}`,
    winner ? `- 结果：${winner}` : "- 结果：未能选出",
    "",
    "要求：所有席位后续发言必须以该投票结果为准（如有争议，请在下一轮提出并发起新一轮投票）。",
    "计票与宣布：下一轮首位发言席位必须先用 3-7 条要点总结本次投票结果，并引用 `votes/round-<round>.json`/`votes/round-<round>.md`（如存在）。"
  ].join("\n");
  await upsertDebateFile(input.debateId, VOTE_DIRECTIVE_PATH, directive, now);

  const closed: OfficialVote = {
    status: "closed",
    kind: "custom",
    roundNumber: currentOpen.roundNumber,
    title: currentOpen.title,
    prompt: currentOpen.prompt,
    result: {
      ballots: currentOpen.ballots ?? [],
      counts: Object.fromEntries(counts),
      winner
    },
    ...(currentOpen.meta ? { meta: currentOpen.meta } : {}),
    closedAt: now,
    createdAt: currentOpen.createdAt
  };
  await upsertDebateFile(
    input.debateId,
    `${VOTE_RESULT_PREFIX}${open.roundNumber}.json`,
    JSON.stringify(closed, null, 2),
    now
  );
  await upsertDebateFile(input.debateId, VOTE_OPEN_PATH, JSON.stringify(closed, null, 2), now);
  return { ok: true, closed, summary };
}

export function describeContextAccessDenied(
  workflow: NormalizedDebateWorkflow | null,
  currentPhaseKind: WorkflowPhaseKind | null | undefined,
  scope: WorkflowContextAccessScope,
  path: string
) {
  if (!hasContextAccessRules(workflow)) return null;
  const resolved = resolveContextAccessRules(workflow, currentPhaseKind);
  const lockedRule = matchContextAccessRule(resolved.locked, scope, path);
  if (lockedRule) {
    return `LOCKED_UNTIL_PHASE: ${path} requires phase ${lockedRule.phaseKind}`;
  }
  return `ACCESS_DENIED: ${path} is not allowed by workflow.contextAccess`;
}

export function isContextPathReadable(
  workflow: NormalizedDebateWorkflow | null,
  currentPhaseKind: WorkflowPhaseKind | null | undefined,
  scope: WorkflowContextAccessScope,
  path: string
) {
  if (!hasContextAccessRules(workflow)) return true;
  const resolved = resolveContextAccessRules(workflow, currentPhaseKind);
  return Boolean(matchContextAccessRule([...resolved.autoRead, ...resolved.readable], scope, path));
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
    const prefixLike = `${effectivePrefix}%`;
    const result = await query<{ path: string }>(
      `
        select f.path
          from debate_agent_files f
          join debate_agents da on da.id = f.debate_agent_id
          join debates d on d.id = da.debate_id
         where f.debate_agent_id = $1 and d.user_id = $2 and f.path like $3
         order by f.path asc
         limit 200
      `,
      [debateAgentId, userId, prefixLike]
    );
    if ((result.rowCount ?? 0) > 0) {
      const paths = result.rows
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
            targetDebateAgentId: debateAgentId,
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
    const result = await query<{ path: string }>(
      `
        select f.path
        from ai_agent_files f
        join ai_agents a on a.id = f.ai_agent_id
        where f.ai_agent_id = $1 and a.user_id = $2 and f.path like $3
        order by f.path asc
        limit 200
      `,
      [agentId, userId, prefixLike]
    );
    const paths = result.rows
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
  try {
    const result = await query<{ content: string }>(
      `
        select f.content
          from debate_agent_files f
          join debate_agents da on da.id = f.debate_agent_id
          join debates d on d.id = da.debate_id
         where f.debate_agent_id = $1 and d.user_id = $2 and f.path = $3
         limit 1
      `,
      [debateAgentId, userId, path]
    );
    if ((result.rowCount ?? 0) === 1) {
      const content = String(result.rows[0].content ?? "");
      if (audit) {
        await recordDebateFileActivity({
          debateId: audit.debateId,
          debateAgentId,
          turnNumber: audit.turnNumber,
          roundNumber: audit.roundNumber,
          action: "read",
          scope: "agent",
          path,
          targetDebateAgentId: debateAgentId,
          now: audit.now
        });
      }
      return content;
    }
  } catch (error) {
    if (!isMissingTableError(error, "debate_agent_files")) {
      throw error;
    }
  }

  return toolReadFileFromAgent(userId, debateAgentId, agentId, path, audit);
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
    const result = await query<{ content: string }>(
      `
        select f.content
        from ai_agent_files f
        join ai_agents a on a.id = f.ai_agent_id
        where f.ai_agent_id = $1 and a.user_id = $2 and f.path = $3
        limit 1
      `,
      [agentId, userId, path]
    );
    if ((result.rowCount ?? 0) !== 1) {
      return `NOT_FOUND: ${path}`;
    }
    const content = String(result.rows[0].content ?? "");
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

  try {
    const result = await query<{ path: string; content: string }>(
      `
        select f.path, f.content
          from debate_agent_files f
          join debate_agents da on da.id = f.debate_agent_id
          join debates d on d.id = da.debate_id
         where f.debate_agent_id = $1 and d.user_id = $2 and f.content ilike ('%' || $3 || '%')
         order by f.path asc
         limit 5
      `,
      [debateAgentId, userId, searchQuery]
    );

    if ((result.rowCount ?? 0) > 0) {
      const rows = result.rows
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
            targetDebateAgentId: debateAgentId,
            now: audit.now
          });
        }
      }
      return rows;
    }
  } catch (error) {
    if (!isMissingTableError(error, "debate_agent_files")) {
      throw error;
    }
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
    const result = await query<{ path: string; content: string }>(
      `
        select f.path, f.content
        from ai_agent_files f
        join ai_agents a on a.id = f.ai_agent_id
        where f.ai_agent_id = $1 and a.user_id = $2 and f.content ilike ('%' || $3 || '%')
        order by f.path asc
        limit 5
      `,
      [agentId, userId, searchQuery]
    );

    const rows = result.rows
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

export function normalizeDebateOutputPath(rawPath: string, allowedPrefixes?: string[]) {
  const normalized = rawPath.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized) return null;
  if (normalized.includes("..")) return null;
  const prefixes = Array.isArray(allowedPrefixes) && allowedPrefixes.length > 0 ? allowedPrefixes : ["final/", "outputs/"];
  if (prefixes.some((prefix) => normalized.startsWith(prefix))) return normalized;
  return null;
}

export function isFinalDebateOutputPath(path: string) {
  return path.startsWith("final/");
}

export function normalizeDebateFileWriteMode(path: string, mode?: string | null): DebateFileWriteMode | null {
  if (mode === "replace" || mode === "append" || mode === "section_merge") return mode;
  return isFinalDebateOutputPath(path) ? null : "replace";
}

export function normalizeMarkdownLineEndings(value: string) {
  return value.replace(/\r\n/g, "\n");
}

export function trimMarkdownHeadingText(value: string) {
  return value.replace(/\s+#+\s*$/, "").trim().toLowerCase();
}

export function findHeadingLineMatch(line: string) {
  const match = line.match(/^(#{1,6})\s+(.+?)\s*$/);
  if (!match) return null;
  return { level: match[1].length, text: trimMarkdownHeadingText(match[2]) };
}

export function mergeMarkdownSectionByHeading(existing: string, targetHeading: string, replacement: string) {
  const normalizedExisting = normalizeMarkdownLineEndings(existing);
  const normalizedReplacement = normalizeMarkdownLineEndings(replacement).trim();
  if (!normalizedReplacement) {
    return { error: "section_merge requires non-empty content." };
  }

  const replacementLines = normalizedReplacement.split("\n");
  const replacementHeading = replacementLines.map((line) => line.trim()).find((line) => line.length > 0) ?? "";
  const replacementMatch = findHeadingLineMatch(replacementHeading);
  if (!replacementMatch || replacementMatch.text !== trimMarkdownHeadingText(targetHeading)) {
    return { error: `section_merge content must start with a Markdown heading matching "${targetHeading}".` };
  }

  const lines = normalizedExisting.split("\n");
  let targetStart = -1;
  let targetLevel = 0;
  let inCodeFence = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^```/.test(line.trim())) inCodeFence = !inCodeFence;
    if (inCodeFence) continue;
    const heading = findHeadingLineMatch(line.trim());
    if (!heading) continue;
    if (heading.text === trimMarkdownHeadingText(targetHeading)) {
      targetStart = index;
      targetLevel = heading.level;
      break;
    }
  }

  if (targetStart < 0) {
    return { error: `TARGET_HEADING_NOT_FOUND: ${targetHeading}. Read the file first and retry with an existing heading.` };
  }

  let targetEnd = lines.length;
  inCodeFence = false;
  for (let index = targetStart + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^```/.test(line.trim())) inCodeFence = !inCodeFence;
    if (inCodeFence) continue;
    const heading = findHeadingLineMatch(line.trim());
    if (heading && heading.level <= targetLevel) {
      targetEnd = index;
      break;
    }
  }

  const mergedLines = [...lines.slice(0, targetStart), ...replacementLines, ...lines.slice(targetEnd)];
  return { content: mergedLines.join("\n") };
}

export function appendDebateFileContent(existing: string, appended: string) {
  const current = normalizeMarkdownLineEndings(existing).replace(/\s+$/, "");
  const next = normalizeMarkdownLineEndings(appended).replace(/^\s+/, "").trimEnd();
  if (!current) return next;
  if (!next) return current;
  return `${current}\n\n${next}`;
}

export function describeLegacyFinalWriteError(path: string) {
  return `Explicit write mode required for ${path}. Read the file first, then call debate_files_write with mode="section_merge", mode="append", or mode="replace" (replace also requires baseVersion/baseUpdatedAt).`;
}

export function shouldRejectDeliverableShrink(previousContent: string, nextContent: string, allowShrink: boolean) {
  if (allowShrink) return false;
  const previousLength = previousContent.length;
  if (previousLength < DELIVERABLE_REPLACE_SHRINK_MIN_CHARS) return false;
  return nextContent.length < Math.floor(previousLength * DELIVERABLE_REPLACE_SHRINK_RATIO);
}

export async function getDebateFileMeta(
  client: PoolClient,
  debateId: string,
  path: string
) {
  const result = await client.query<{ content: string; updated_at: string; version: number }>(
    `
      select content, updated_at, version
        from debate_files
       where debate_id = $1
         and path = $2
       limit 1
       for update
    `,
    [debateId, path]
  );
  if ((result.rowCount ?? 0) !== 1) return null;
  return {
    content: String(result.rows[0].content ?? ""),
    updatedAt: String(result.rows[0].updated_at ?? ""),
    version: Number(result.rows[0].version ?? 1) || 1
  };
}

export async function recordDebateFileActivity(input: {
  client?: PoolClient;
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
  const sql = `
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
    values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
  `;
  const params = [
    randomUUID(),
    input.debateId,
    input.debateAgentId,
    input.turnNumber,
    input.roundNumber,
    input.action,
    input.scope,
    input.path,
    input.targetDebateAgentId ?? null,
    input.writeMode ?? null,
    input.beforeVersion ?? null,
    input.afterVersion ?? null,
    input.beforeContent ?? null,
    input.afterContent ?? null,
    input.targetHeading ?? null,
    input.reason ?? null,
    input.now
  ];
  if (input.client) {
    await input.client.query(sql, params);
    return;
  }
  await query(sql, params);
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
  client: PoolClient;
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
  await input.client.query(
    `
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
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      on conflict (debate_id, path, version) do nothing
    `,
    [
      randomUUID(),
      input.debateId,
      input.path,
      input.version,
      input.content,
      input.mode,
      input.reason,
      input.baseVersion,
      input.debateAgentId ?? null,
      input.now
    ]
  );
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
  const pool = await ensureDbReady();
  const client = await pool.connect();
  try {
    await client.query("begin");
    const current = await getDebateFileMeta(client, input.debateId, input.path);
    const isDeliverable = isFinalDebateOutputPath(input.path);
    const baseVersion = Number.isFinite(input.baseVersion) ? Math.floor(Number(input.baseVersion)) : null;
    const baseUpdatedAt = typeof input.baseUpdatedAt === "string" && input.baseUpdatedAt.trim() ? input.baseUpdatedAt.trim() : null;
    const expectedCurrentVersion = current?.version ?? 0;
    const expectedCurrentUpdatedAt = current?.updatedAt ?? null;

    if (isDeliverable && baseVersion === null && baseUpdatedAt === null && current) {
      await client.query("rollback");
      return {
        error: `final/* writes require baseVersion or baseUpdatedAt for ${input.path}. Call debate_files_stat or debate_files_read first.`
      };
    }
    if (baseVersion !== null && baseVersion !== expectedCurrentVersion) {
      await client.query("rollback");
      return {
        error: `WRITE_CONFLICT: ${input.path} is at version ${expectedCurrentVersion}, not ${baseVersion}. Call debate_files_stat/debate_files_read and retry.`
      };
    }
    if (baseUpdatedAt !== null && baseUpdatedAt !== expectedCurrentUpdatedAt) {
      await client.query("rollback");
      return {
        error: `WRITE_CONFLICT: ${input.path} was updated at ${expectedCurrentUpdatedAt ?? "(missing)"}, not ${baseUpdatedAt}. Call debate_files_stat/debate_files_read and retry.`
      };
    }

    let nextContent = String(input.content ?? "");
    if (input.mode === "replace") {
      if (isDeliverable && current && shouldRejectDeliverableShrink(current.content, nextContent, Boolean(input.allowShrink))) {
        await client.query("rollback");
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
        await client.query("rollback");
        return { error: `section_merge requires targetHeading for ${input.path}.` };
      }
      if (!current) {
        await client.query("rollback");
        return { error: `TARGET_FILE_NOT_FOUND: ${input.path}. Create the file with mode="replace" first.` };
      }
      const merged = mergeMarkdownSectionByHeading(current.content, targetHeading, nextContent);
      if ("error" in merged) {
        await client.query("rollback");
        return { error: merged.error };
      }
      nextContent = merged.content;
    }

    const nextVersion = current ? current.version + 1 : 1;
    await client.query(
      `
        insert into debate_files (debate_id, path, content, version, created_at, updated_at)
        values ($1, $2, $3, $4, $5, $5)
        on conflict (debate_id, path)
        do update
          set content = excluded.content,
              version = excluded.version,
              updated_at = excluded.updated_at
      `,
      [input.debateId, input.path, nextContent, nextVersion, input.now]
    );

    if (isDeliverable) {
      await insertDebateFileVersionRecord({
        client,
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
        client,
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

    await client.query("commit");
    return {
      ok: true,
      path: input.path,
      size: nextContent.length,
      content: nextContent,
      version: nextVersion,
      updatedAt: input.now,
      mode: input.mode
    };
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      // noop
    }
    throw error;
  } finally {
    client.release();
  }
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
    const result = await query<{ updated_at: string; version: number; content_length: number }>(
      `
        select updated_at, version, char_length(content) as content_length
          from debate_files
         where debate_id = $1
           and path = $2
         limit 1
      `,
      [input.debateId, safePath]
    );
    if ((result.rowCount ?? 0) !== 1) {
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
      size: Number(result.rows[0].content_length ?? 0) || 0,
      updatedAt: String(result.rows[0].updated_at ?? ""),
      version: Number(result.rows[0].version ?? 1) || 1
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

export function buildOpenAiTools(input: { enableVoting: boolean; allowedOutputPaths: string[] }) {
  const allowedPathsText = input.allowedOutputPaths.length > 0 ? input.allowedOutputPaths.join(", ") : "final/, outputs/";
  const tools: Array<Record<string, unknown>> = [
    {
      type: "function",
      function: {
        name: "agent_files_list",
        description: "List available files for this agent. Optionally filter by prefix.",
        parameters: { type: "object", properties: { prefix: { type: "string" } } }
      }
    },
    {
      type: "function",
      function: {
        name: "agent_files_read",
        description: "Read a file content by path.",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "agent_files_search",
        description: "Search within agent files and return small snippets.",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "debate_files_read",
        description: "Read an allowed shared debate file by path.",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"]
        }
      }
    }
    ,
    {
      type: "function",
      function: {
        name: "debate_files_stat",
        description: `Get existence, size, updatedAt, and version for a debate-level output file. Allowed paths: ${allowedPathsText}.`,
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "debate_files_write",
        description: `Write a debate-level output file (final deliverables). Allowed paths: ${allowedPathsText}. outputs/* default to replace. final/* require an explicit mode and safe write semantics.`,
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            content: { type: "string" },
            mode: { type: "string", enum: ["replace", "append", "section_merge"] },
            baseVersion: { type: "integer" },
            baseUpdatedAt: { type: "string" },
            reason: { type: "string" },
            targetHeading: { type: "string" },
            allowShrink: { type: "boolean" }
          },
          required: ["path", "content"]
        }
      }
    }
  ];

  if (input.enableVoting) {
    tools.push(
      {
        type: "function",
        function: {
          name: "debate_vote_open",
          description: "Open an official voting phase (election / finalization / custom).",
          parameters: {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["election", "finalization", "custom"] },
              title: { type: "string" },
              prompt: { type: "string" },
              options: { type: "array", items: { type: "string" } }
            },
            required: ["kind", "title"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "debate_vote_cast",
          description: "Cast your ballot into the open official vote.",
          parameters: {
            type: "object",
            properties: {
              selections: { type: "object", additionalProperties: { type: "string" } },
              choice: { type: "string" },
              reason: { type: "string" }
            }
          }
        }
      },
      {
        type: "function",
        function: {
          name: "debate_vote_close",
          description: "Close the open official vote and publish the official result/directive.",
          parameters: { type: "object", properties: {} }
        }
      }
    );
  }

  return tools;
}

export function buildAnthropicTools(input: { enableVoting: boolean; allowedOutputPaths: string[] }) {
  const allowedPathsText = input.allowedOutputPaths.length > 0 ? input.allowedOutputPaths.join(", ") : "final/, outputs/";
  const tools: Array<Record<string, unknown>> = [
    {
      name: "agent_files_list",
      description: "List available files for this agent. Optionally filter by prefix.",
      input_schema: { type: "object", properties: { prefix: { type: "string" } } }
    },
    {
      name: "agent_files_read",
      description: "Read a file content by path.",
      input_schema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"]
      }
    },
    {
      name: "agent_files_search",
      description: "Search within agent files and return small snippets.",
      input_schema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"]
      }
    },
    {
      name: "debate_files_read",
      description: "Read an allowed shared debate file by path.",
      input_schema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"]
      }
    }
    ,
    {
      name: "debate_files_stat",
      description: `Get existence, size, updatedAt, and version for a debate-level output file. Allowed paths: ${allowedPathsText}.`,
      input_schema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"]
      }
    },
    {
      name: "debate_files_write",
      description: `Write a debate-level output file (final deliverables). Allowed paths: ${allowedPathsText}. outputs/* default to replace. final/* require an explicit mode and safe write semantics.`,
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
          mode: { type: "string", enum: ["replace", "append", "section_merge"] },
          baseVersion: { type: "integer" },
          baseUpdatedAt: { type: "string" },
          reason: { type: "string" },
          targetHeading: { type: "string" },
          allowShrink: { type: "boolean" }
        },
        required: ["path", "content"]
      }
    }
  ];

  if (input.enableVoting) {
    tools.push(
      {
        name: "debate_vote_open",
        description: "Open an official voting phase (election / finalization / custom).",
        input_schema: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["election", "finalization", "custom"] },
            title: { type: "string" },
            prompt: { type: "string" },
            options: { type: "array", items: { type: "string" } }
          },
          required: ["kind", "title"]
        }
      },
      {
        name: "debate_vote_cast",
        description: "Cast your ballot into the open official vote.",
        input_schema: {
          type: "object",
          properties: {
            selections: { type: "object", additionalProperties: { type: "string" } },
            choice: { type: "string" },
            reason: { type: "string" }
          }
        }
      },
      {
        name: "debate_vote_close",
        description: "Close the open official vote and publish the official result/directive.",
        input_schema: { type: "object", properties: {} }
      }
    );
  }

  return tools;
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
  const updateLiveStage = (
    stage: "calling_model" | "running_tools" | "parsing" | "saving",
    message: string
  ) => {
    setDebateLiveProgress({
      debateId: debate.id,
      roundNumber,
      messageNumber,
      debateAgentId,
      aiAgentId: agent.id,
      agentName: eventAgentName,
      stage
    });
    emitDebateLiveEvent(debate.id, {
      type: "status",
      debateId: debate.id,
      message,
      at: new Date().toISOString()
    });
  };

  updateLiveStage("calling_model", `整理上下文：${eventAgentName}`);
  const apiKey = decryptSecret(agent.apiKeyEncrypted);
  const promptHardMaxChars = getPromptHardMaxChars(agent);
  const recentTurnMin = await loadContextWindowMinTurnNumberForDebateAgent(userId, debate.id, debateAgentId);
  const recentTurnLimit = Math.max(
    Math.max(1, participantCount),
    Math.min(8, Math.max(4, Math.max(1, participantCount)))
  );
  const recentTurnRows = await loadRecentTurnRows(
    userId,
    debate.id,
    participantCount,
    recentTurnLimit,
    recentTurnMin
  );
  const recentTurnsInline = formatRecentTurnsInline(recentTurnRows, participantCount, recentTurnMin);
  const seatInline = await loadDebateSeatInline(userId, debate.id, debateAgentId);
  const participantsInline = messageNumber <= participantCount ? null : await loadDebateParticipantsInline(userId, debate.id);
  const workflow = await loadDebateWorkflow(userId, debate.id);
  const allowedOutputPaths = workflow?.deliverables.allowedPaths ?? ["final/", "outputs/"];
  const requiredDeliverables = workflow?.deliverables.requiredFiles ?? [];
  const pendingDeliverables = await listMissingRequiredDeliverables({
    userId,
    debateId: debate.id,
    workflow
  });
  const roleAssignments = await loadDebateParticipantRoleTypes(userId, debate.id);
  const currentRoleType = getDebateParticipantRoleType(roleAssignments, debateAgentId);
  const responseFormatPolicy = workflow?.promptPolicies.responseFormat ?? {
    requireMarkdown: true,
    forbidRawJson: true
  };
  updateLiveStage("calling_model", `读取规则与记忆：${eventAgentName}`);
  const openVote = await loadOpenVote(userId, debate.id);
  const latestVote = await loadLatestVote(userId, debate.id);
  const currentPhase = resolveCurrentWorkflowPhase({
    workflow,
    roundNumber,
    openVote,
    latestVote,
    persistedPhaseKind: debate.workflowPhaseKind
  });
  const currentOutputMaxTokens = getWorkflowOutputMaxTokens(
    workflow,
    currentPhase?.kind ?? null,
    agent.maxOutputTokens
  );
  const contextAccessLines = buildContextAccessSummaryLines({
    workflow,
    currentPhaseKind: currentPhase?.kind ?? null
  });
  const requestedMaxTokens = resolveRequestedMaxTokens(currentOutputMaxTokens);
  const workflowPhaseInline = buildWorkflowPhaseInline({ workflow, debate, roundNumber, openVote, latestVote });
  const workflowOpeningInline = buildWorkflowOpeningInline({ workflow, roundNumber });
  const workflowIdeaBankInline = await loadWorkflowIdeaBankInline({
    workflow,
    phaseKind: currentPhase?.kind ?? null,
    userId,
    debateId: debate.id
  });
  const openVoteInline = await loadOpenVoteInline(userId, debate.id, `${debateAgentId}:${openVote?.roundNumber ?? 0}`);
  const directiveInline = await loadOfficialDirectiveInline(userId, debate.id);
  const announcementInline = await loadVoteAnnouncementInline(userId, debate.id);
  const questionDiffInline = await loadQuestionDiffInline(userId, debate.id);
  const implicitReadAudit: DebateFileActivityAudit = {
    debateId: debate.id,
    debateAgentId,
    turnNumber: messageNumber,
    roundNumber,
    now: new Date().toISOString()
  };
  const segmentInline = await loadDebateAgentSegmentInline(userId, debate.id, debateAgentId, 12_000, implicitReadAudit);
  const turnInRound = ((messageNumber - 1) % Math.max(1, participantCount)) + 1;
  const roundStart = (roundNumber - 1) * Math.max(1, participantCount) + 1;
  const roundEnd = roundNumber * Math.max(1, participantCount);
  const enableVotingTools = Boolean(openVoteInline) || isOfficialVotingAllowed(workflow, roundNumber);
  const electionStartRound = getWorkflowElectionStartRound(workflow);
  const votingRuleInline = workflow?.enabled
    ? `- Official voting: enabled by workflow.json. startRound=${electionStartRound}. roles=[${(workflow.election.roles ?? []).join(", ")}].`
    : null;

  const alreadyVoted =
    openVote && openVote.status === "open"
      ? Boolean((openVote.ballots ?? []).some((b) => (b as { debateAgentId?: unknown }).debateAgentId === debateAgentId))
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
      debate.question,
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
      userId,
      debateId: debate.id,
      queryText: retrievalQuery,
      limit: 6,
      minTurnNumber: await loadContextWindowMinTurnNumberForDebateAgent(userId, debate.id, debateAgentId),
      maxChars: 12_000
    });
    const gatedRetrieved = retrieved.filter((item) => {
      if (!hasContextAccessRules(workflow)) return true;
      if (!item.sourcePath) return true;
      if (
        item.sourceType === "deliverable_file" ||
        item.sourceType === "shared_file" ||
        item.sourceType === "idea_bank_file"
      ) {
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
      targetDebateAgentId: debateAgentId
    });
    relevantHistoryInline = buildRelevantHistoryInline(gatedRetrieved);
  } catch (error) {
    await logRuntimeEvent("warn", "retrieval history failed", {
      debateId: debate.id,
      error: describeRuntimeError(error)
    });
    relevantHistoryInline = null;
  }

  updateLiveStage("calling_model", `组装提示词：${eventAgentName}`);
  const prompt = planPromptContext(
    [
      {
        key: "question",
        priority: 0,
        category: "core",
        preferredMaxChars: 24_000,
        content: `Question:\n${debate.question}`
      },
      { key: "questionDiff", priority: 0, category: "core", preferredMaxChars: 8_000, content: questionDiffInline },
      { key: "seat", priority: 0, category: "core", preferredMaxChars: 3_000, content: seatInline },
      {
        key: "roundSemantics",
        priority: 0,
        category: "core",
        preferredMaxChars: 2_500,
        content: [
          "Round semantics (IMPORTANT):",
          `- Seats: ${participantCount}`,
          `- 1 round = ${participantCount} messages (each seat speaks once in order).`,
          `- You are generating: Round ${roundNumber} · Turn ${turnInRound}/${participantCount} (global message #${messageNumber}).`,
          `- Round ${roundNumber} covers message #${roundStart} ~ #${roundEnd}.`,
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
          messageNumber <= participantCount && (workflow?.promptPolicies.round1Fairness ?? true)
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
  const url = resolveChatUrl(agent);
  const overrideSystemPrompt = await loadDebateAgentSystemPrompt(userId, debateAgentId);
  let electionBallotSummary:
    | {
        selections: Record<string, string>;
        reason: string | null;
        voterSeat: string | null;
      }
    | null = null;

  if (process.env.NODE_ENV !== "production" && apiKey.startsWith("demo-")) {
    const estimatedPromptTokens = estimatePromptTokensFromChars(prompt.length);
    return {
      raw: buildDemoResponse(debate, agent, messageNumber),
      usage: null,
      promptChars: prompt.length,
      estimatedPromptTokens,
      electionBallotSummary,
      diagnostics: {
        provider: agent.provider,
        model: agent.model,
        requestedMaxTokens,
        finishReason: "demo_fallback",
        toolCallsCount: 0
      }
    };
  }

  if (agent.provider === "openai") {
    let totalToolCalls = 0;
    const tools = buildOpenAiTools({ enableVoting: enableVotingTools, allowedOutputPaths });
    const systemParts = [
      buildBaseSystemPrompt(agent, overrideSystemPrompt),
      buildFileToolInstructions({
        enableVoting: enableVotingTools,
        allowedOutputPaths,
        requiredFiles: requiredDeliverables,
        currentRoleType,
        pendingRequiredFiles: pendingDeliverables,
        contextAccessLines
      })
    ];
    const inline = hasContextAccessRules(workflow)
      ? await loadContextAccessAutoReadInline({
          userId,
          debateId: debate.id,
          debateAgentId,
          agentId: agent.id,
          workflow,
          currentPhaseKind: currentPhase?.kind ?? null,
          audit: implicitReadAudit
        })
      : await loadDebateAgentFilesInline(userId, debateAgentId, agent.id, 18_000, implicitReadAudit);
    if (inline) systemParts.push(inline);
    const allowLongTermContext = messageNumber > participantCount;
    if (allowLongTermContext) {
      const memoryInline = await loadDebateAgentMemoryInline(userId, debateAgentId, 10_000, implicitReadAudit);
      if (memoryInline) systemParts.push(memoryInline);
      if (debate.enableSharedFacts) {
        const sharedInline = await loadSharedFactsBoardInline(userId, debate.id, 10_000, implicitReadAudit);
        if (sharedInline) systemParts.push(sharedInline);
      }
    }
    systemParts.push(buildResponseFormatInstructions(responseFormatPolicy));
    const systemInline = systemParts.join("\n\n");
    const promptChars = systemInline.length + prompt.length;
    const estimatedPromptTokens = estimatePromptTokensFromChars(promptChars);

    const rawMessages: Array<Record<string, unknown>> = [
      { role: "system", content: systemInline },
      { role: "user", content: prompt }
    ];
    const effectiveMaxInputTokens = agent.maxInputTokens ?? agent.contextLength;
    const messages = clipMessagesToInputLimit(
      rawMessages,
      effectiveMaxInputTokens,
      OPENAI_COMPAT_MAX_INPUT_CHARS
    );

    const normalizeUsage = (usage: unknown) => {
      if (!usage || typeof usage !== "object") return null;
      const obj = usage as Record<string, unknown>;
      const promptTokens = typeof obj.prompt_tokens === "number" ? obj.prompt_tokens : null;
      const completionTokens = typeof obj.completion_tokens === "number" ? obj.completion_tokens : null;
      const totalTokens = typeof obj.total_tokens === "number" ? obj.total_tokens : null;
      if (promptTokens === null && completionTokens === null && totalTokens === null) return null;
      return { promptTokens, completionTokens, totalTokens };
    };

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
      updateLiveStage(
        round === 0 ? "calling_model" : "running_tools",
        round === 0 ? `请求模型：${eventAgentName}` : `继续生成（工具轮次 ${round}）：${eventAgentName}`
      );

      let streamed: {
        content: string;
        toolCalls: Array<{ id: string; function: { name: string; arguments: string } }>;
        usage: unknown;
        finishReason?: string | null;
      } | null = null;
      try {
        updateLiveStage("calling_model", `等待模型返回：${eventAgentName}`);
        streamed = await openAiChatStream({
          debateId: debate.id,
          messageNumber,
          roundNumber,
          agentName: eventAgentName,
          url,
          apiKey,
          body: withOptionalMaxTokens(
            {
              model: agent.model,
              tools,
              tool_choice: "auto",
              messages
            },
            currentOutputMaxTokens
          )
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error ?? "");
        if (looksLikeToolsUnsupported(msg)) {
          break;
        }
        throw error;
      }

      const toolCalls = streamed.toolCalls;
      const assistantContent = streamed.content ?? "";
      const usage =
        normalizeUsage(streamed.usage) ??
        normalizeUsage(
          await openAiUsageProbe({
            url,
            apiKey,
            body: { model: agent.model, tools, tool_choice: "auto", messages }
          }).catch(() => null)
        );

      if (streamed.finishReason === "tool_calls" && (!toolCalls || toolCalls.length === 0)) {
        updateLiveStage("parsing", `检测到伪工具调用，转纯文本重试：${eventAgentName}`);
        const noToolRetry = await openAiChatOnce({
          url,
          apiKey,
          body: withOptionalMaxTokens(
            {
              model: agent.model,
              messages
            },
            currentOutputMaxTokens
          )
        }).catch(() => null);
        const retryText = String(noToolRetry?.content ?? "").trim();
        if (retryText) {
          return {
            raw: retryText.length >= assistantContent.length ? retryText : assistantContent,
            usage: normalizeUsage(noToolRetry?.usage) ?? usage,
            promptChars,
            estimatedPromptTokens,
            electionBallotSummary,
            diagnostics: {
              provider: agent.provider,
              model: agent.model,
              requestedMaxTokens,
              finishReason: noToolRetry?.finishReason ?? "tool_calls_retry_none",
              toolCallsCount: totalToolCalls
            }
          };
        }
      }

      if (!toolCalls || toolCalls.length === 0) {
        if (assistantContent) {
          return {
            raw: assistantContent,
            usage,
            promptChars,
            estimatedPromptTokens,
            electionBallotSummary,
            diagnostics: {
              provider: agent.provider,
              model: agent.model,
              requestedMaxTokens,
              finishReason: streamed.finishReason ?? null,
              toolCallsCount: totalToolCalls
            }
          };
        }
        return {
          raw: buildDemoResponse(debate, agent, messageNumber),
          usage,
          promptChars,
          estimatedPromptTokens,
          electionBallotSummary,
          diagnostics: {
            provider: agent.provider,
            model: agent.model,
            requestedMaxTokens,
            finishReason: streamed.finishReason ?? "demo_fallback",
            toolCallsCount: totalToolCalls
          }
        };
      }

      totalToolCalls += toolCalls.length;
      messages.push({ role: "assistant", tool_calls: toolCalls, content: assistantContent });

      for (const call of toolCalls) {
        updateLiveStage("running_tools", `执行工具：${call.function.name}`);
        let args: unknown = {};
        try {
          args = JSON.parse(call.function.arguments || "{}");
        } catch {
        }

        let result: unknown;
        if (call.function.name === "agent_files_list") {
          const prefix =
            typeof (args as { prefix?: unknown }).prefix === "string"
              ? ((args as { prefix: string }).prefix as string)
              : undefined;
          result = await toolListFiles(userId, debateAgentId, agent.id, prefix, {
            debateId: debate.id,
            turnNumber: messageNumber,
            roundNumber,
            now: new Date().toISOString()
          }, {
            workflow,
            currentPhaseKind: currentPhase?.kind ?? null
          });
        } else if (call.function.name === "agent_files_read") {
          const path = String((args as { path?: unknown }).path ?? "");
          result = await toolReadFile(userId, debateAgentId, agent.id, path, {
            debateId: debate.id,
            turnNumber: messageNumber,
            roundNumber,
            now: new Date().toISOString()
          }, {
            workflow,
            currentPhaseKind: currentPhase?.kind ?? null
          });
        } else if (call.function.name === "agent_files_search") {
          const queryText = String((args as { query?: unknown }).query ?? "");
          result = await toolSearchFiles(userId, debateAgentId, agent.id, queryText, {
            debateId: debate.id,
            turnNumber: messageNumber,
            roundNumber,
            now: new Date().toISOString()
          }, {
            workflow,
            currentPhaseKind: currentPhase?.kind ?? null
          });
        } else if (call.function.name === "debate_files_read") {
          const path = String((args as { path?: unknown }).path ?? "");
          result = await toolReadDebateFile(userId, debateAgentId, debate.id, path, new Date().toISOString(), messageNumber, roundNumber, {
            workflow,
            currentPhaseKind: currentPhase?.kind ?? null
          });
        } else if (call.function.name === "debate_files_stat") {
          const path = String((args as { path?: unknown }).path ?? "");
          result = await toolDebateFilesStat({
            debateAgentId,
            debateId: debate.id,
            turnNumber: messageNumber,
            roundNumber,
            path,
            now: new Date().toISOString(),
            allowedOutputPaths
          });
        } else if (call.function.name === "debate_files_write") {
          const path = String((args as { path?: unknown }).path ?? "");
          const content = String((args as { content?: unknown }).content ?? "");
          const rawMode = (args as { mode?: unknown }).mode;
          const rawBaseVersion = (args as { baseVersion?: unknown }).baseVersion;
          const rawBaseUpdatedAt = (args as { baseUpdatedAt?: unknown }).baseUpdatedAt;
          const rawReason = (args as { reason?: unknown }).reason;
          const rawTargetHeading = (args as { targetHeading?: unknown }).targetHeading;
          const rawAllowShrink = (args as { allowShrink?: unknown }).allowShrink;
          result = await toolDebateFilesWrite({
            userId,
            debateAgentId,
            debateId: debate.id,
            turnNumber: messageNumber,
            roundNumber,
            path,
            content,
            mode: typeof rawMode === "string" ? rawMode : null,
            baseVersion: typeof rawBaseVersion === "number" ? rawBaseVersion : null,
            baseUpdatedAt: typeof rawBaseUpdatedAt === "string" ? rawBaseUpdatedAt : null,
            reason: typeof rawReason === "string" ? rawReason : null,
            targetHeading: typeof rawTargetHeading === "string" ? rawTargetHeading : null,
            allowShrink: rawAllowShrink === true,
            now: new Date().toISOString(),
            allowedOutputPaths
          });
        } else if (call.function.name === "debate_vote_open") {
          const kind = String((args as { kind?: unknown }).kind ?? "custom");
          const title = String((args as { title?: unknown }).title ?? "投票");
          const promptText = typeof (args as { prompt?: unknown }).prompt === "string" ? String((args as { prompt: string }).prompt) : undefined;
          const options = Array.isArray((args as { options?: unknown }).options) ? ((args as { options: unknown[] }).options as unknown[]) : undefined;
          result = await toolVoteOpen({
            userId,
            debateId: debate.id,
            participantCount,
            roundNumber,
            title,
            kind:
              kind === "election" ? "election" : kind === "finalization" ? "finalization" : "custom",
            prompt: promptText,
            options: options?.map((x) => String(x))
          });
        } else if (call.function.name === "debate_vote_cast") {
          const selections =
            (args as { selections?: unknown }).selections && typeof (args as { selections?: unknown }).selections === "object"
              ? ((args as { selections: Record<string, unknown> }).selections as Record<string, unknown>)
              : undefined;
          const choice = typeof (args as { choice?: unknown }).choice === "string" ? String((args as { choice: string }).choice) : undefined;
          const reason = typeof (args as { reason?: unknown }).reason === "string" ? String((args as { reason: string }).reason) : undefined;
          result = await toolVoteCast({
            userId,
            debateId: debate.id,
            participantCount,
            debateAgentId,
            voterName: agent.name,
            selections,
            choice,
            reason
          });
          if (result && typeof result === "object" && (result as { ok?: unknown }).ok) {
            const ballot = (result as { ballot?: unknown }).ballot;
            const rawSelections =
              ballot && typeof ballot === "object" && (ballot as { selections?: unknown }).selections
                ? ((ballot as { selections?: unknown }).selections as Record<string, unknown>)
                : {};
            electionBallotSummary = {
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
        } else if (call.function.name === "debate_vote_close") {
          result = await toolVoteClose({ userId, debateId: debate.id, participantCount });
          const closedVote =
            result && typeof result === "object" && (result as any).closed ? ((result as any).closed as OfficialVote) : null;
          if (closedVote) {
            try {
              await maybeGenerateVoteAnnouncementWithSeat1({
                userId,
                debate,
                participantCount,
                closed: closedVote
              });
            } catch (error) {
              await logRuntimeEvent("warn", "vote announce after close failed", { error: describeRuntimeError(error) });
            }
          }
        } else {
          result = { error: `Unknown tool: ${call.function.name}` };
        }

        const serialized =
          typeof result === "string"
            ? result
            : JSON.stringify(result);
        messages.push({ role: "tool", tool_call_id: call.id, content: serialized });
      }
    }

    // Fallback: no tools, rely on inline files context only.
    updateLiveStage("calling_model", `模型重试（无工具模式）：${eventAgentName}`);
    const fallback = await openAiChatStream({
      debateId: debate.id,
      messageNumber,
      roundNumber,
      agentName: eventAgentName,
      url,
      apiKey,
      body: withOptionalMaxTokens({ model: agent.model, messages }, currentOutputMaxTokens)
    });
    const usage =
      normalizeUsage(fallback.usage) ??
      normalizeUsage(
        await openAiUsageProbe({
          url,
          apiKey,
          body: { model: agent.model, messages }
        }).catch(() => null)
      );
    if (fallback.content) {
      return {
        raw: fallback.content,
        usage,
        promptChars,
        estimatedPromptTokens,
        electionBallotSummary,
        diagnostics: {
          provider: agent.provider,
          model: agent.model,
          requestedMaxTokens,
          finishReason: fallback.finishReason ?? null,
          toolCallsCount: totalToolCalls
        }
      };
    }
    return {
      raw: buildDemoResponse(debate, agent, messageNumber),
      usage,
      promptChars,
      estimatedPromptTokens,
      electionBallotSummary,
      diagnostics: {
        provider: agent.provider,
        model: agent.model,
        requestedMaxTokens,
        finishReason: fallback.finishReason ?? "demo_fallback",
        toolCallsCount: totalToolCalls
      }
    };
  }

  let totalToolCalls = 0;
  const tools = buildAnthropicTools({ enableVoting: enableVotingTools, allowedOutputPaths });
  const systemParts = [
    buildBaseSystemPrompt(agent, overrideSystemPrompt),
    buildFileToolInstructions({
      enableVoting: enableVotingTools,
      allowedOutputPaths,
      requiredFiles: requiredDeliverables,
      currentRoleType,
      pendingRequiredFiles: pendingDeliverables,
      contextAccessLines
    })
  ];
  const inline = hasContextAccessRules(workflow)
    ? await loadContextAccessAutoReadInline({
        userId,
        debateId: debate.id,
        debateAgentId,
        agentId: agent.id,
        workflow,
        currentPhaseKind: currentPhase?.kind ?? null,
        audit: implicitReadAudit
      })
    : await loadDebateAgentFilesInline(userId, debateAgentId, agent.id, 18_000, implicitReadAudit);
  if (inline) systemParts.push(inline);
  const allowLongTermContext = messageNumber > participantCount;
  if (allowLongTermContext) {
    const memoryInline = await loadDebateAgentMemoryInline(userId, debateAgentId, 10_000, implicitReadAudit);
    if (memoryInline) systemParts.push(memoryInline);
    if (debate.enableSharedFacts) {
      const sharedInline = await loadSharedFactsBoardInline(userId, debate.id, 10_000, implicitReadAudit);
      if (sharedInline) systemParts.push(sharedInline);
    }
  }
  systemParts.push(buildResponseFormatInstructions(responseFormatPolicy));
  const systemInline = systemParts.join("\n\n");
  const promptChars = systemInline.length + prompt.length;
  const estimatedPromptTokens = estimatePromptTokensFromChars(promptChars);

  const rawMessages: Array<Record<string, unknown>> = [{ role: "user", content: prompt }];
  const effectiveMaxInputTokens = agent.maxInputTokens ?? agent.contextLength;
  const messages = clipMessagesToInputLimit(rawMessages, effectiveMaxInputTokens, PROMPT_HARD_MAX_CHARS_ANTHROPIC);

  const normalizeAnthropicUsage = (usage: unknown) => {
    if (!usage || typeof usage !== "object") return null;
    const obj = usage as Record<string, unknown>;
    const promptTokens = typeof obj.input_tokens === "number" ? obj.input_tokens : null;
    const completionTokens = typeof obj.output_tokens === "number" ? obj.output_tokens : null;
    const totalTokens =
      typeof promptTokens === "number" && typeof completionTokens === "number" ? promptTokens + completionTokens : null;
    if (promptTokens === null && completionTokens === null && totalTokens === null) return null;
    return { promptTokens, completionTokens, totalTokens };
  };

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
    updateLiveStage(
      round === 0 ? "calling_model" : "running_tools",
      round === 0 ? `请求模型：${eventAgentName}` : `继续生成（工具轮次 ${round}）：${eventAgentName}`
    );
    updateLiveStage("calling_model", `等待模型返回：${eventAgentName}`);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
        body: JSON.stringify(
          withOptionalMaxTokens(
            {
              model: agent.model,
              system: systemInline,
              tools,
              messages
            },
            currentOutputMaxTokens
          )
        )
    });
    const payload = await response.json();

    if (!response.ok) {
      const text = JSON.stringify(payload).slice(0, 400);
      if (looksLikeToolsUnsupported(text)) {
        break;
      }
      throw new AppError("AI_API_ERROR", 502, text);
    }

    const contentBlocks = (payload.content ?? []) as Array<Record<string, unknown>>;
    const toolUses = contentBlocks.filter((block) => block.type === "tool_use") as Array<{
      id: string;
      name: string;
      input: unknown;
    }>;

    if (toolUses.length === 0) {
      const textBlock = contentBlocks.find((block) => block.type === "text") as
        | { text?: string }
        | undefined;
      const content = textBlock?.text ?? buildDemoResponse(debate, agent, messageNumber);
       await emitChunks(debate.id, messageNumber, agent.name, content);
       return {
         raw: content,
         usage: normalizeAnthropicUsage(payload?.usage ?? null),
         promptChars,
         estimatedPromptTokens,
         electionBallotSummary,
         diagnostics: {
           provider: agent.provider,
           model: agent.model,
           requestedMaxTokens,
           finishReason: typeof payload?.stop_reason === "string" ? payload.stop_reason : null,
           toolCallsCount: totalToolCalls
         }
       };
     }

    totalToolCalls += toolUses.length;
    messages.push({ role: "assistant", content: contentBlocks });

    const toolResults: Array<Record<string, unknown>> = [];
    for (const use of toolUses) {
      updateLiveStage("running_tools", `执行工具：${use.name}`);
      let result: unknown;
      if (use.name === "agent_files_list") {
        const prefix =
          typeof (use.input as { prefix?: unknown }).prefix === "string"
            ? ((use.input as { prefix: string }).prefix as string)
            : undefined;
        result = await toolListFiles(userId, debateAgentId, agent.id, prefix, {
          debateId: debate.id,
          turnNumber: messageNumber,
          roundNumber,
          now: new Date().toISOString()
        }, {
          workflow,
          currentPhaseKind: currentPhase?.kind ?? null
        });
      } else if (use.name === "agent_files_read") {
        const path = String((use.input as { path?: unknown }).path ?? "");
        result = await toolReadFile(userId, debateAgentId, agent.id, path, {
          debateId: debate.id,
          turnNumber: messageNumber,
          roundNumber,
          now: new Date().toISOString()
        }, {
          workflow,
          currentPhaseKind: currentPhase?.kind ?? null
        });
      } else if (use.name === "agent_files_search") {
        const queryText = String((use.input as { query?: unknown }).query ?? "");
        result = await toolSearchFiles(userId, debateAgentId, agent.id, queryText, {
          debateId: debate.id,
          turnNumber: messageNumber,
          roundNumber,
          now: new Date().toISOString()
        }, {
          workflow,
          currentPhaseKind: currentPhase?.kind ?? null
        });
      } else if (use.name === "debate_files_read") {
        const path = String((use.input as { path?: unknown }).path ?? "");
        result = await toolReadDebateFile(userId, debateAgentId, debate.id, path, new Date().toISOString(), messageNumber, roundNumber, {
          workflow,
          currentPhaseKind: currentPhase?.kind ?? null
        });
      } else if (use.name === "debate_files_stat") {
        const path = String((use.input as { path?: unknown }).path ?? "");
        result = await toolDebateFilesStat({
          debateAgentId,
          debateId: debate.id,
          turnNumber: messageNumber,
          roundNumber,
          path,
          now: new Date().toISOString(),
          allowedOutputPaths
        });
      } else if (use.name === "debate_files_write") {
        const path = String((use.input as { path?: unknown }).path ?? "");
        const content = String((use.input as { content?: unknown }).content ?? "");
        const rawMode = (use.input as { mode?: unknown }).mode;
        const rawBaseVersion = (use.input as { baseVersion?: unknown }).baseVersion;
        const rawBaseUpdatedAt = (use.input as { baseUpdatedAt?: unknown }).baseUpdatedAt;
        const rawReason = (use.input as { reason?: unknown }).reason;
        const rawTargetHeading = (use.input as { targetHeading?: unknown }).targetHeading;
        const rawAllowShrink = (use.input as { allowShrink?: unknown }).allowShrink;
        result = await toolDebateFilesWrite({
          userId,
          debateAgentId,
          debateId: debate.id,
          turnNumber: messageNumber,
          roundNumber,
          path,
          content,
          mode: typeof rawMode === "string" ? rawMode : null,
          baseVersion: typeof rawBaseVersion === "number" ? rawBaseVersion : null,
          baseUpdatedAt: typeof rawBaseUpdatedAt === "string" ? rawBaseUpdatedAt : null,
          reason: typeof rawReason === "string" ? rawReason : null,
          targetHeading: typeof rawTargetHeading === "string" ? rawTargetHeading : null,
          allowShrink: rawAllowShrink === true,
          now: new Date().toISOString(),
          allowedOutputPaths
        });
      } else if (use.name === "debate_vote_open") {
        const kind = String((use.input as { kind?: unknown }).kind ?? "custom");
        const title = String((use.input as { title?: unknown }).title ?? "投票");
        const promptText =
          typeof (use.input as { prompt?: unknown }).prompt === "string"
            ? String((use.input as { prompt: string }).prompt)
            : undefined;
        const options = Array.isArray((use.input as { options?: unknown }).options)
          ? (((use.input as { options: unknown[] }).options as unknown[]) ?? []).map((x) => String(x))
          : undefined;
          result = await toolVoteOpen({
            userId,
            debateId: debate.id,
            participantCount,
            roundNumber,
            title,
            kind:
              kind === "election" ? "election" : kind === "finalization" ? "finalization" : "custom",
            prompt: promptText,
            options
          });
      } else if (use.name === "debate_vote_cast") {
        const selections =
          (use.input as { selections?: unknown }).selections && typeof (use.input as { selections?: unknown }).selections === "object"
            ? ((use.input as { selections: Record<string, unknown> }).selections as Record<string, unknown>)
            : undefined;
        const choice =
          typeof (use.input as { choice?: unknown }).choice === "string"
            ? String((use.input as { choice: string }).choice)
            : undefined;
        const reason =
          typeof (use.input as { reason?: unknown }).reason === "string"
            ? String((use.input as { reason: string }).reason)
            : undefined;
        result = await toolVoteCast({
          userId,
          debateId: debate.id,
          participantCount,
          debateAgentId,
          voterName: agent.name,
          selections,
          choice,
          reason
        });
        if (result && typeof result === "object" && (result as { ok?: unknown }).ok) {
          const ballot = (result as { ballot?: unknown }).ballot;
          const rawSelections =
            ballot && typeof ballot === "object" && (ballot as { selections?: unknown }).selections
              ? ((ballot as { selections?: unknown }).selections as Record<string, unknown>)
              : {};
          electionBallotSummary = {
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
      } else if (use.name === "debate_vote_close") {
        result = await toolVoteClose({ userId, debateId: debate.id, participantCount });
        const closedVote =
          result && typeof result === "object" && (result as any).closed ? ((result as any).closed as OfficialVote) : null;
        if (closedVote) {
          try {
            await maybeGenerateVoteAnnouncementWithSeat1({
              userId,
              debate,
              participantCount,
              closed: closedVote
            });
          } catch (error) {
            await logRuntimeEvent("warn", "vote announce after close failed", { error: describeRuntimeError(error) });
          }
        }
      } else {
        result = { error: `Unknown tool: ${use.name}` };
      }

      const serialized =
        typeof result === "string"
          ? result
          : JSON.stringify(result);
      toolResults.push({ type: "tool_result", tool_use_id: use.id, content: serialized });
    }

    messages.push({ role: "user", content: toolResults });
  }

  // Fallback: no tools, rely on inline files context only.
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify(
      withOptionalMaxTokens(
        {
          model: agent.model,
          system: systemInline,
          messages: [{ role: "user", content: prompt }]
        },
        currentOutputMaxTokens
      )
    )
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new AppError("AI_API_ERROR", 502, JSON.stringify(payload).slice(0, 400));
  }
  const content = payload.content?.[0]?.text ?? buildDemoResponse(debate, agent, messageNumber);
  await emitChunks(debate.id, messageNumber, agent.name, content);
  return {
    raw: content,
    usage: normalizeAnthropicUsage(payload?.usage ?? null),
    promptChars,
    estimatedPromptTokens,
    electionBallotSummary,
    diagnostics: {
      provider: agent.provider,
      model: agent.model,
      requestedMaxTokens,
      finishReason: typeof payload?.stop_reason === "string" ? payload.stop_reason : null,
      toolCallsCount: totalToolCalls
    }
  };
}

export async function emitChunks(debateId: string, turnNumber: number, agentName: string, raw: string) {
  const text = typeof raw === "string" ? raw : String(raw ?? "");
  const chunkSize = 320;
  for (let index = 0; index < text.length; index += chunkSize) {
    emitDebateLiveEvent(debateId, {
      type: "chunk",
      debateId,
      turnNumber,
      agentName,
      text: text.slice(index, index + chunkSize),
      at: new Date().toISOString()
    });
    // allow SSE flush without adding noticeable latency
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
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
  await query(
    `update debates
        set status = $2,
            finished_at = $3,
            stopped_reason = $4,
            workflow_phase_kind = $5,
            workflow_phase_title = $6,
            workflow_phase_round = $7,
            runtime_notice_kind = null,
            runtime_notice_message = null,
            runtime_notice_at = null,
            last_error_code = coalesce($8, last_error_code),
            last_error_message = coalesce($9, last_error_message),
            updated_at = $3
      where id = $1`,
    [
      id,
      status,
      new Date().toISOString(),
      reason ?? null,
      options?.phase?.workflowPhaseKind ?? null,
      options?.phase?.workflowPhaseTitle ?? null,
      options?.phase?.workflowPhaseRound ?? null,
      options?.lastErrorCode ?? null,
      options?.lastErrorMessage ?? null
    ]
  );
}

export async function setDebateRuntimeNotice(
  id: string,
  notice: Pick<DebateRecord, "runtimeNoticeKind" | "runtimeNoticeMessage" | "runtimeNoticeAt"> | null
) {
  await query(
    `update debates
        set runtime_notice_kind = $2,
            runtime_notice_message = $3,
            runtime_notice_at = $4
      where id = $1`,
    [id, notice?.runtimeNoticeKind ?? null, notice?.runtimeNoticeMessage ?? null, notice?.runtimeNoticeAt ?? null]
  );
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
  await query(
    `update debates
        set status = case
              when status = 'running' then 'paused'
              else status
            end,
            stopped_reason = $2,
            workflow_phase_kind = $3,
            workflow_phase_title = $4,
            workflow_phase_round = $5,
            runtime_notice_kind = $6,
            runtime_notice_message = $7,
            runtime_notice_at = $8,
            last_error_code = coalesce($9, last_error_code),
            last_error_message = coalesce($10, last_error_message),
            updated_at = $8
      where id = $1`,
    [
      id,
      reason,
      options?.phase?.workflowPhaseKind ?? null,
      options?.phase?.workflowPhaseTitle ?? null,
      options?.phase?.workflowPhaseRound ?? null,
      "interrupted",
      "检测到运行时中断或网络断开，系统已自动暂停这场辩论；恢复设备或网络后可继续运行",
      now,
      options?.lastErrorCode ?? null,
      options?.lastErrorMessage ?? null
    ]
  );
}

export async function persistDebatePhaseSnapshot(
  id: string,
  phase: Pick<DebateRecord, "workflowPhaseKind" | "workflowPhaseTitle" | "workflowPhaseRound"> | null
) {
  await query(
    `update debates
        set workflow_phase_kind = $2,
            workflow_phase_title = $3,
            workflow_phase_round = $4
      where id = $1`,
    [id, phase?.workflowPhaseKind ?? null, phase?.workflowPhaseTitle ?? null, phase?.workflowPhaseRound ?? null]
  );
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

  const participants = await query<{ turn_order: number; agent_name: string }>(
    `
      select da.turn_order,
             a.name as agent_name
        from debate_agents da
        join ai_agents a on a.id = da.ai_agent_id
        join debates d on d.id = da.debate_id
       where da.debate_id = $1
         and d.user_id = $2
       order by da.turn_order asc
    `,
    [input.debateId, input.userId]
  );

  const existing = await query<{ path: string }>(
    `
      select path
        from debate_files
       where debate_id = $1
         and path like $2
       order by path asc
       limit 200
    `,
    [input.debateId, `${checkpointPrefix}%`]
  );
  const nextIndex = (existing.rowCount ?? 0) + 1;
  const seg = `seg-${pad(nextIndex)}`;
  const checkpointPath = `${checkpointPrefix}${pad(nextIndex)}.md`;

  const completedRounds = Math.floor(input.currentTurn / Math.max(1, input.participantCount));
  const minTurnNumber = input.currentTurn + 1;

  const workflowRaw = await readDebateFile(input.userId, input.debateId, WORKFLOW_PATH);
  const workflow = safeParseWorkflowJson(workflowRaw);
  const directive = (await readDebateFile(input.userId, input.debateId, VOTE_DIRECTIVE_PATH)) ?? "";

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
  for (const row of participants.rows) {
    lines.push(`- Seat-${Number(row.turn_order)}: ${String(row.agent_name ?? "Unknown")}`);
  }

  lines.push("");
  appendWorkflowSummaryLines(lines, workflow);

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

  const participants = await query<{ turn_order: number; agent_name: string }>(
    `
      select da.turn_order,
             a.name as agent_name
        from debate_agents da
        join ai_agents a on a.id = da.ai_agent_id
        join debates d on d.id = da.debate_id
       where da.debate_id = $1
         and d.user_id = $2
       order by da.turn_order asc
    `,
    [input.debateId, input.userId]
  );

  let existingCount = 0;
  try {
    const existing = await query<{ path: string }>(
      `
        select f.path
          from debate_agent_files f
         where f.debate_agent_id = $1
           and f.path like $2
         order by f.path asc
         limit 200
      `,
      [input.debateAgentId, `${checkpointPrefix}%`]
    );
    existingCount = existing.rowCount ?? 0;
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
  const directive = (await readDebateFile(input.userId, input.debateId, VOTE_DIRECTIVE_PATH)) ?? "";

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
  for (const row of participants.rows) {
    lines.push(`- Seat-${Number(row.turn_order)}: ${String(row.agent_name ?? "Unknown")}`);
  }

  lines.push("");
  appendWorkflowSummaryLines(lines, workflow);

  if (directive.trim()) {
    lines.push("");
    lines.push("## Latest official directive");
    lines.push(directive.trim());
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

export function summarizeOptionText(text: string, maxChars: number) {
  const compact = String(text ?? "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");
  if (!compact) return "";
  if (compact.length <= maxChars) return compact;
  return compact.slice(0, Math.max(0, maxChars - 1)) + "…";
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

  const openRoundNumber = input.endedRound + 1;
  const shouldOpenElection = shouldAutoOpenWorkflowElectionAtBoundary(workflow, input.endedRound);
  const electionRules = workflow?.phaseMachine.transitionRules.election;
  const electionRoles = workflowEnabled ? (workflow?.election.roles ?? []) : [];

  // Prefer election vote when workflow is enabled so roles/speakingOrder can be applied
  // (e.g., Host first, Supervisor last).
  if (shouldOpenElection && workflowEnabled && electionRoles.length > 0) {
    const result = await toolVoteOpen({
      userId: input.userId,
      debateId: input.debateId,
      participantCount: input.participantCount,
      roundNumber: openRoundNumber,
      title: `第 ${openRoundNumber} 轮 · Phase 1.5 角色选举`,
      kind: "election",
      bypassStartRound: false,
      meta: { forcedOpen: true, reason: `after_round_${input.endedRound}`, attempt: 1 }
    });
    return { ok: true, opened: Boolean((result as { ok?: unknown }).ok), result };
  }

  if (
    workflowEnabled &&
    electionRules?.autoOpen &&
    electionRules?.reopenUntilPassed &&
    latestVote?.status === "closed" &&
    latestVote.kind === "election" &&
    !isClosedElectionVotePassed(latestVote)
  ) {
    const discussionRoundsBetweenVotes = Math.max(1, Math.floor(Number(electionRules.discussionRoundsBetweenVotes) || 1));
    const targetVoteRound = latestVote.roundNumber + discussionRoundsBetweenVotes + 1;
    if (openRoundNumber === targetVoteRound) {
      const attempt = Math.max(1, Math.floor(Number(latestVote.meta?.attempt) || Number((latestVote.result as { attempt?: unknown }).attempt) || 1)) + 1;
      const result = await toolVoteOpen({
        userId: input.userId,
        debateId: input.debateId,
        participantCount: input.participantCount,
        roundNumber: openRoundNumber,
        title: `第 ${openRoundNumber} 轮 · Phase 1.5 角色复投`,
        kind: "election",
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

  const nextRoundNumber = input.endedRound + 1;
  const finalizationRules = workflow?.phaseMachine.transitionRules.finalization;
  const finalizationEntryRound = getWorkflowEarliestFinalizationVoteRound(workflow);
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
        title: `第 ${nextRoundNumber} 轮 · Phase 3 入场表决`,
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
        title: `第 ${nextRoundNumber} 轮 · Phase 3 入场复投`,
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

  if (!shouldOpenElection) {
    return { ok: true, opened: false };
  }

  const startTurn = 1;
  const endTurn = input.endedRound * input.participantCount;

  const turns = await query<{
    turn_number: number;
    seat_number: number | null;
    content: string;
    structured_output: unknown;
    speaker_name: string | null;
  }>(
    `
      select t.turn_number,
             t.seat_number,
             t.content,
             t.structured_output,
             coalesce(da.display_name, a.name) as speaker_name
        from debate_turns t
        join ai_agents a on a.id = t.ai_agent_id
        left join debate_agents da on da.id = t.debate_agent_id
        join debates d on d.id = t.debate_id
       where t.debate_id = $1
         and d.user_id = $2
         and t.turn_number between $3 and $4
       order by t.turn_number asc
       limit 200
    `,
    [input.debateId, input.userId, startTurn, endTurn]
  );

  const bySeat = new Map<
    string,
    {
      seat: string;
      name: string;
      proposals: string[];
      lastContent: string;
    }
  >();
  for (const row of turns.rows) {
    const turnNumber = Number(row.turn_number);
    const seatNumber =
      row.seat_number === null
        ? ((turnNumber - 1) % input.participantCount) + 1
        : Number(row.seat_number);
    const seat = `Seat-${seatNumber}`;
    const speakerName = String(row.speaker_name ?? "Unknown");

    const structured = row.structured_output && typeof row.structured_output === "object" ? (row.structured_output as any) : null;
    const proposed = typeof structured?.proposed_solution === "string" ? structured.proposed_solution : "";

    const info = bySeat.get(seat) ?? { seat, name: speakerName, proposals: [], lastContent: "" };
    if (!info.name) info.name = speakerName;
    const proposal = summarizeOptionText(proposed, 220);
    if (proposal) info.proposals.push(proposal);
    info.lastContent = String(row.content ?? "");
    bySeat.set(seat, info);
  }

  const options: string[] = [];
  for (let seatNumber = 1; seatNumber <= input.participantCount; seatNumber += 1) {
    const seat = `Seat-${seatNumber}`;
    const info = bySeat.get(seat) ?? { seat, name: "Unknown", proposals: [], lastContent: "" };
    const chosen = info.proposals.length > 0 ? info.proposals[info.proposals.length - 1] : "";
    const fallback = summarizeOptionText(info.lastContent, 220);
    const text = chosen || fallback;
    if (!text) continue;
    options.push(`${seat}（${info.name}）：${text}`);
  }

  const minOptionsConfigured = workflow?.voting.custom.minOptions;
  const maxOptionsConfigured = workflow?.voting.custom.maxOptions;
  const minOptions =
    typeof minOptionsConfigured === "number" && Number.isFinite(minOptionsConfigured) && minOptionsConfigured >= 1
      ? Math.floor(minOptionsConfigured)
      : 2;
  const maxOptions =
    typeof maxOptionsConfigured === "number" && Number.isFinite(maxOptionsConfigured) && maxOptionsConfigured >= 1
      ? Math.floor(maxOptionsConfigured)
      : input.participantCount;
  const minOptionsSafe = Math.max(2, minOptions);
  const effectiveMax = Math.min(input.participantCount, Math.max(minOptionsSafe, maxOptions));

  const uniqueOptions = Array.from(new Set(options)).slice(0, effectiveMax);
  if (uniqueOptions.length < 2) {
    // Fallback: always provide at least two options so voting phase can proceed.
    uniqueOptions.length = 0;
    for (let i = 1; i <= effectiveMax; i += 1) {
      uniqueOptions.push(`Seat-${i}：支持 Seat-${i} 的方案（未提取到明确摘要）`);
    }
  }

  const result = await toolVoteOpen({
    userId: input.userId,
    debateId: input.debateId,
    participantCount: input.participantCount,
    roundNumber: openRoundNumber,
    title: `第 ${input.endedRound} 轮后 · 方案投票`,
    kind: "custom",
    prompt: `请基于前 ${input.endedRound} 轮（Round 1-${input.endedRound}）各席位的表现与方案演进，投票选出你认为最好的方案作为官方结论。`,
    options: uniqueOptions,
    allowWithoutWorkflow: false,
    bypassStartRound: false,
    meta: { forcedOpen: true, reason: `after_round_${input.endedRound}` }
  });

  return { ok: true, opened: Boolean((result as { ok?: unknown }).ok), result };
}

export function buildFallbackVoteAnnouncement(input: {
  debateQuestion: string;
  participantsInline: string | null;
  closed: ClosedOfficialVote;
  directiveJson: Record<string, unknown> | null;
}) {
  const kind = input.closed.kind;
  const result = input.closed.result ?? {};
  const winner = typeof (result as any)?.winner === "string" ? String((result as any).winner) : null;
  const winners = (result as any)?.winners && typeof (result as any).winners === "object" ? (result as any).winners : null;
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
        ? "- Phase 3 入场表决已通过"
        : "- Phase 3 入场表决未通过"
      : kind === "custom"
      ? winner
        ? `- Winner：${winner}`
        : "- Winner：未能选出"
      : winners
        ? "（见官方指令：角色确认）"
        : "（未提供 winners）",
    "",
    ...(input.participantsInline ? [input.participantsInline, ""] : []),
    ...(input.directiveJson ? ["## 指令数据（JSON）", "```json", JSON.stringify(input.directiveJson, null, 2), "```", ""] : []),
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
  const directiveJsonRaw = await readDebateFile(input.userId, input.debate.id, VOTE_DIRECTIVE_JSON_PATH);
  const directiveJson = directiveJsonRaw ? (safeJsonParse<Record<string, unknown>>(directiveJsonRaw) ?? null) : null;

  let announcerSeatNumber = 1;
  let announcerRoleLabel: string | null = null;
  let fallbackAnnouncerSeatNumber = 1;
  let fallbackAnnouncerRoleLabel: string | null = null;
  if (workflow?.enabled) {
    const announcer = workflow.voting.announcement.announcer;
    const fallback = workflow.voting.announcement.fallback;
    if (fallback.type === "seat") {
      fallbackAnnouncerSeatNumber = Math.max(1, Math.floor(Number(fallback.seat) || 1));
      fallbackAnnouncerRoleLabel = null;
    } else if (fallback.type === "role") {
      fallbackAnnouncerRoleLabel = String(fallback.role ?? "").trim() || null;
    }
    if (announcer.type === "seat") {
      announcerSeatNumber = Math.max(1, Math.floor(Number(announcer.seat) || 1));
    } else if (announcer.type === "role") {
      const role = String(announcer.role ?? "").trim();
      if (role) {
        const appointmentsRaw =
          directiveJson && typeof (directiveJson as any).appointments === "object" ? ((directiveJson as any).appointments as Record<string, unknown>) : null;
        const seat =
          appointmentsRaw &&
          appointmentsRaw[role] &&
          typeof appointmentsRaw[role] === "object" &&
          typeof (appointmentsRaw[role] as any).seat === "string"
            ? String((appointmentsRaw[role] as any).seat)
            : "";
        const match = seat.match(/^Seat-([0-9]{1,6})$/);
        const n = match ? Number(match[1]) : Number.NaN;
        if (Number.isFinite(n) && n >= 1) {
          announcerSeatNumber = Math.floor(n);
          announcerRoleLabel = role;
        }
      }
    }
  }

  const announcer = await query<Record<string, unknown>>(
    `
      select da.id as debate_agent_id,
             a.*
        from debate_agents da
        join ai_agents a on a.id = da.ai_agent_id
        join debates d on d.id = da.debate_id
       where da.debate_id = $1
         and d.user_id = $2
         and da.turn_order = $3
       limit 1
    `,
    [input.debate.id, input.userId, announcerSeatNumber]
  );

  let announcerRow: Record<string, unknown> | null = (announcer.rowCount ?? 0) === 1 ? announcer.rows[0] : null;
  if (!announcerRow) {
    if (fallbackAnnouncerRoleLabel && directiveJson && typeof (directiveJson as any).appointments === "object") {
      const appointmentsRaw = (directiveJson as any).appointments as Record<string, unknown>;
      const seat =
        appointmentsRaw[fallbackAnnouncerRoleLabel] &&
        typeof appointmentsRaw[fallbackAnnouncerRoleLabel] === "object" &&
        typeof (appointmentsRaw[fallbackAnnouncerRoleLabel] as any).seat === "string"
          ? String((appointmentsRaw[fallbackAnnouncerRoleLabel] as any).seat)
          : "";
      const match = seat.match(/^Seat-([0-9]{1,6})$/);
      const n = match ? Number(match[1]) : Number.NaN;
      if (Number.isFinite(n) && n >= 1) fallbackAnnouncerSeatNumber = Math.floor(n);
    }

    const fallbackSeat = await query<Record<string, unknown>>(
      `
        select da.id as debate_agent_id,
               a.*
          from debate_agents da
          join ai_agents a on a.id = da.ai_agent_id
          join debates d on d.id = da.debate_id
         where da.debate_id = $1
           and d.user_id = $2
           and da.turn_order = $3
         limit 1
      `,
      [input.debate.id, input.userId, fallbackAnnouncerSeatNumber]
    );
    if ((fallbackSeat.rowCount ?? 0) !== 1) {
      return { ok: false, generated: false, error: `Seat-${fallbackAnnouncerSeatNumber} agent not found.` };
    }
    announcerSeatNumber = fallbackAnnouncerSeatNumber;
    announcerRoleLabel = fallbackAnnouncerRoleLabel;
    announcerRow = fallbackSeat.rows[0];
  }

  const announcerDebateAgentId = String(announcerRow.debate_agent_id);
  const agent = normalizeAgentRow(announcerRow);
  const overrideSystemPrompt = await loadDebateAgentSystemPrompt(input.userId, announcerDebateAgentId);
  const apiKey = decryptSecret(agent.apiKeyEncrypted);
  const url = resolveChatUrl(agent);

  const proposalRound = Math.max(1, Math.floor(roundNumber) - 1);
  const proposalStart = 1;
  const proposalEnd = proposalRound * input.participantCount;
  const proposalTurns = await query<{ turn_number: number; seat_number: number | null; content: string; speaker_name: string | null }>(
    `
      select t.turn_number,
             t.seat_number,
             t.content,
             coalesce(da.display_name, a.name) as speaker_name
        from debate_turns t
        join ai_agents a on a.id = t.ai_agent_id
        left join debate_agents da on da.id = t.debate_agent_id
        join debates d on d.id = t.debate_id
       where t.debate_id = $1
         and d.user_id = $2
         and t.turn_number between $3 and $4
       order by t.turn_number asc
       limit 200
    `,
    [input.debate.id, input.userId, proposalStart, proposalEnd]
  );
  const proposalInline =
    (proposalTurns.rowCount ?? 0) > 0
      ? [
          `Rounds 1-${proposalRound} (read-only; for vote context):`,
          ...proposalTurns.rows.map((r) => {
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
    directiveJson ? `\n\nOfficial directive data (JSON):\n\`\`\`json\n${JSON.stringify(directiveJson, null, 2)}\n\`\`\`` : "",
    "\n\nWrite a concise announcement that all seats must follow:",
    "- Title line with round number",
    "- 3-7 bullet points: winner/appointments, turnout, and next step",
    "- End with one short directive sentence starting with: OFFICIAL DIRECTIVE:"
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
      directiveJson
    });

  await upsertDebateFile(input.debate.id, roundPath, finalContent.trim() + "\n", now);
  await upsertDebateFile(input.debate.id, VOTE_ANNOUNCEMENT_PATH, finalContent.trim() + "\n", now);
  return { ok: true, generated: true, path: roundPath };
}

export async function generateRoundSummary(input: {
  userId: string;
  debate: { id: string; question: string };
  participantCount: number;
  endedRound: number;
}) {
  const roundPath = `debate/round_summary.md`;

  const announcer = await query<Record<string, unknown>>(
    `
      select da.id as debate_agent_id,
             a.*
        from debate_agents da
        join ai_agents a on a.id = da.ai_agent_id
        join debates d on d.id = da.debate_id
       where da.debate_id = $1
         and d.user_id = $2
         and da.turn_order = 1
       limit 1
    `,
    [input.debate.id, input.userId]
  );

  let announcerRow: Record<string, unknown> | null = (announcer.rowCount ?? 0) === 1 ? announcer.rows[0] : null;
  if (!announcerRow) {
    return { ok: false, error: "Seat-1 agent not found." };
  }

  const announcerDebateAgentId = String(announcerRow.debate_agent_id);
  const agent = normalizeAgentRow(announcerRow);
  const overrideSystemPrompt = await loadDebateAgentSystemPrompt(input.userId, announcerDebateAgentId);
  const apiKey = decryptSecret(agent.apiKeyEncrypted);
  const url = resolveChatUrl(agent);

  const proposalStart = (input.endedRound - 1) * input.participantCount + 1;
  const proposalEnd = input.endedRound * input.participantCount;
  const proposalTurns = await query<{ turn_number: number; seat_number: number | null; content: string; speaker_name: string | null }>(
    `
      select t.turn_number,
             t.seat_number,
             t.content,
             coalesce(da.display_name, a.name) as speaker_name
        from debate_turns t
        join ai_agents a on a.id = t.ai_agent_id
        left join debate_agents da on da.id = t.debate_agent_id
        join debates d on d.id = t.debate_id
       where t.debate_id = $1
         and d.user_id = $2
         and t.turn_number between $3 and $4
       order by t.turn_number asc
       limit 200
    `,
    [input.debate.id, input.userId, proposalStart, proposalEnd]
  );
  
  if ((proposalTurns.rowCount ?? 0) === 0) return { ok: false, error: "No turns found" };

  const proposalInline = [
    `Round ${input.endedRound} Discussion:`,
    ...proposalTurns.rows.map((r) => {
      const tn = Number(r.turn_number);
      const seatNumber = r.seat_number === null ? ((tn - 1) % input.participantCount) + 1 : Number(r.seat_number);
      const seat = `Seat-${seatNumber}`;
      const name = String(r.speaker_name ?? "Unknown");
      const body = summarizeOptionText(String(r.content ?? ""), 1000);
      return `- ${seat} · ${name}: ${body}`;
    })
  ].join("\n");

  const system = [
    buildBaseSystemPrompt(agent, overrideSystemPrompt),
    `SYSTEM TASK: You are the moderator/announcer. Please summarize the just-finished round (Round ${input.endedRound}).`,
    "Output only Markdown for humans; no tool calls."
  ].join("\n\n");

  const userPrompt = [
    `Debate question:\n${input.debate.question}`,
    `\n\n${proposalInline}`,
    "\n\nPlease summarize the key points discussed in this round. Note any consensus reached, any practical ideas formulated, and how they work. Keep it concise but include important details for the final summary.",
  ].join("").trim();

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
    await logRuntimeEvent("warn", "round summary generation failed", { error: describeRuntimeError(error) });
    return { ok: false, error };
  }

  const now = new Date().toISOString();
  if (content) {
    const lines = [];
    lines.push(`## Round ${input.endedRound} Summary`);
    lines.push(content);
    lines.push("");
    
    const existing = (await readDebateFile(input.userId, input.debate.id, roundPath)) ?? "";
    const next = appendWithTrim(existing, lines.join("\n"));
    
    await upsertDebateFile(input.debate.id, roundPath, next, now);
    try {
      await indexDebateContextChunk({
        userId: input.userId,
        debateId: input.debate.id,
        chunkKey: `round_summary:${input.endedRound}`,
        sourceType: "round_summary",
        sourcePath: roundPath,
        roundNumber: input.endedRound,
        content,
        now
      });
    } catch {
      // retrieval indexing is best-effort
    }
  }
  
  return { ok: true };
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
      const debateResult = await query<Record<string, unknown>>(
        "select * from debates where id = $1 and user_id = $2",
        [id, userId]
      );
      if ((debateResult.rowCount ?? 0) !== 1) {
        break;
      }

      const debate = normalizeDebateRow(debateResult.rows[0]);
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
      let participantRows = await query<Record<string, unknown>>(
        "select * from debate_agents where debate_id = $1 order by turn_order asc",
        [id]
      );
      const participantCount = participantRows.rows.length;
      if (participantCount < 2) {
        throw new AppError("VALIDATION_ERROR", 400, "Debate requires at least 2 agents");
      }

      const workflowReorderCreated = await maybeCreateWorkflowSeatReorder({
        userId,
        debateId: id,
        participantCount,
        currentTurn: debate.currentTurn
      });
      if (workflowReorderCreated) {
        emitDebateLiveEvent(id, {
          type: "status",
          debateId: id,
          message: "Workflow 规则：已生成下一轮席位顺序调整",
          at: new Date().toISOString()
        });
      }

      const reorderApplied = await maybeApplyPendingSeatReorder({
        userId,
        debateId: id,
        participantCount,
        currentTurn: debate.currentTurn
      });
      if (reorderApplied) {
        emitDebateLiveEvent(id, {
          type: "status",
          debateId: id,
          message: "已应用席位顺序调整（下一轮生效）",
          at: new Date().toISOString()
        });
        participantRows = await query<Record<string, unknown>>(
          "select * from debate_agents where debate_id = $1 order by turn_order asc",
          [id]
        );
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
        const requiresFinalizationPhase =
          workflowBeforeTurn?.phaseMachine.transitionRules.finalization.requirePhaseForCompletion ?? true;
        const earliestCompletionRound = getWorkflowEarliestCompletionRound(workflowBeforeTurn);
        const missingDeliverables = await listMissingRequiredDeliverables({
          userId,
          debateId: id,
          workflow: workflowBeforeTurn
        });
        if (
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
        } else {
          await finishDebate(id, "stopped", "max turns reached before Phase 3", { phase: lastKnownPhase });
        }
        break;
      }

      const currentIndex = debate.currentTurn % participantCount;
      const currentParticipant = participantRows.rows[currentIndex];
      const agentResult = await query<Record<string, unknown>>(
        "select * from ai_agents where id = $1 and user_id = $2",
        [String(currentParticipant.ai_agent_id), userId]
      );
      if ((agentResult.rowCount ?? 0) !== 1) {
        throw new AppError("NOT_FOUND", 404, "Agent not found for debate");
      }

      const agent = normalizeAgentRow(agentResult.rows[0]);
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
      let electionBallotSummary:
        | {
            selections: Record<string, string>;
            reason: string | null;
            voterSeat: string | null;
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
            eventAgentName
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
          electionBallotSummary =
            result && typeof result === "object" && "electionBallotSummary" in result
              ? ((result as {
                  electionBallotSummary?: {
                    selections: Record<string, string>;
                    reason: string | null;
                    voterSeat: string | null;
                  } | null;
                }).electionBallotSummary ?? null)
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
        stage: "parsing"
      });
      const parsed = parseResponse(raw);
      const persistedElectionBallotSummary =
        openVoteBeforeTurn?.status === "open" && openVoteBeforeTurn.kind === "election"
          ? electionBallotSummary ?? extractElectionBallotSummaryFromVote(await loadOpenVote(userId, id), String(currentParticipant.id))
          : null;
      const persistedResponse =
        openVoteBeforeTurn?.status === "open" && openVoteBeforeTurn.kind === "election"
          ? {
              ...parsed,
              content: buildElectionVoteOnlyContent(persistedElectionBallotSummary ?? undefined),
              structuredOutput: null as StructuredOutput | null
            }
          : parsed;
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
        stage: "saving",
        updatedAt: createdAt
      });
      await query(
        `insert into debate_turns (
          id, debate_id, ai_agent_id, debate_agent_id, seat_number, turn_number, content, structured_output,
          parse_status, token_used, response_time_ms, retry_count, error_code, created_at
        ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          randomUUID(),
          id,
          String(currentParticipant.ai_agent_id),
          String(currentParticipant.id),
          typeof (currentParticipant as any).turn_order === "number"
            ? Number((currentParticipant as any).turn_order)
            : typeof (currentParticipant as any).turnOrder === "number"
              ? Number((currentParticipant as any).turnOrder)
              : currentIndex + 1,
          debate.currentTurn + 1,
          persistedResponse.content,
          persistedResponse.structuredOutput ? JSON.stringify(persistedResponse.structuredOutput) : null,
          persistedResponse.parseStatus,
          tokenUsed,
          responseTimeMs,
          retryCount,
          null,
          createdAt
        ]
      );

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
            voteOnlyOverride:
              Boolean(openVoteBeforeTurn?.status === "open" && openVoteBeforeTurn.kind === "election")
          }
        });
      } catch (error) {
        await logRuntimeEvent("warn", "generation diagnostics persistence failed", {
          debateId: id,
          error: describeRuntimeError(error)
        });
      }

      await query("update debate_agents set turn_count = turn_count + 1 where id = $1", [
        String(currentParticipant.id)
      ]);

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
            turnNumber: messageNumber,
            agentName: eventAgentName,
            content: persistedResponse.content,
            now: createdAt
          }),
          ...(debate.enableSharedFacts
            ? [
                persistSharedFactsAfterTurn({
                  userId,
                  debateId: id,
                  turnNumber: messageNumber,
                  agentName: eventAgentName,
                  content: persistedResponse.content,
                  structuredOutput: persistedResponse.structuredOutput,
                  now: createdAt
                })
              ]
            : [])
        ]);
      } catch (error) {
        await logRuntimeEvent("warn", "memory persistence failed", { debateId: id, error: describeRuntimeError(error) });
      }

      const turnRows = await query<Record<string, unknown>>(
        "select * from debate_turns where debate_id = $1 order by turn_number asc",
        [id]
      );
      const turns: DebateTurnRecord[] = turnRows.rows.map((row) => ({
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

      const workflow = await loadDebateWorkflow(userId, id);
      const consensus = aggregateConsensusByLastRound(turns, participantCount, workflow?.consensus ?? null);
      const nextTurn = debate.currentTurn + 1;
      const isBoundary = participantCount > 0 ? nextTurn % participantCount === 0 : false;
      const endedSpeechRoundIndex = participantCount > 0 ? Math.floor(nextTurn / participantCount) : 0;
      const endedRound = mapSpeechRoundIndexToActualRound(endedSpeechRoundIndex, closedVoteRoundsBeforeTurn);
      const openVoteBeforeUpdate = await loadOpenVote(userId, id);
      const latestVoteBeforeUpdate = await loadLatestVote(userId, id);
      const mustKeepRunningForVote =
        Boolean(openVoteBeforeUpdate) ||
        Boolean(workflow?.enabled) && isBoundary && shouldAutoOpenWorkflowElectionAtBoundary(workflow, endedRound);
      const finalizationPhase = resolveCurrentWorkflowPhase({
        workflow,
        roundNumber: endedRound + 1,
        openVote: openVoteBeforeUpdate,
        latestVote: latestVoteBeforeUpdate,
        persistedPhaseKind: debate.workflowPhaseKind
      });
      const requiresFinalizationPhase = workflow?.phaseMachine.transitionRules.finalization.requirePhaseForCompletion ?? true;
      const currentSpeechRoundIndexAfterTurn = Math.floor(Math.max(0, nextTurn - 1) / Math.max(1, participantCount)) + 1;
      const currentRoundNumberAfterTurn = mapSpeechRoundIndexToActualRound(
        currentSpeechRoundIndexAfterTurn,
        closedVoteRoundsBeforeTurn
      );
      const canCompleteByPhase =
        requiresFinalizationPhase
          ? finalizationPhase?.kind === "finalization" && currentRoundNumberAfterTurn >= getWorkflowEarliestCompletionRound(workflow)
          : true;
      const missingDeliverables = await listMissingRequiredDeliverables({
        userId,
        debateId: id,
        workflow
      });
      const canCompleteByDeliverables = missingDeliverables.length === 0;
      const consensusReachedForDb = mustKeepRunningForVote ? false : consensus.reached;
      const nextStatusForDb =
        !mustKeepRunningForVote && canCompleteByPhase && canCompleteByDeliverables ? "completed" : "running";
      const phaseSnapshotAfterTurn = getPhaseSnapshot(finalizationPhase, currentRoundNumberAfterTurn);
      lastKnownPhase = phaseSnapshotAfterTurn;
      await query(
        `update debates
            set current_turn = $2,
                token_used = $3,
                consensus_summary = $4,
                consensus_reached = $5,
                workflow_phase_kind = $6,
                workflow_phase_title = $7,
                workflow_phase_round = $8,
                status = case
                  when status in ('paused', 'stopped') then status
                  else $9
                end,
                finished_at = case
                  when $9 = 'completed' then $10
                  else finished_at
                end,
                updated_at = $10
          where id = $1`,
        [
          id,
          nextTurn,
          debate.tokenUsed + tokenUsed,
          consensus.leadingSolution
            ? JSON.stringify({
                leadingSolution: consensus.leadingSolution,
                score: consensus.score
              })
            : null,
          consensusReachedForDb,
          phaseSnapshotAfterTurn.workflowPhaseKind,
          phaseSnapshotAfterTurn.workflowPhaseTitle,
          phaseSnapshotAfterTurn.workflowPhaseRound,
          nextStatusForDb,
          createdAt
        ]
      );

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
              message: `正在生成第 ${endedRound} 轮总结...`,
              at: new Date().toISOString()
            });
            await generateRoundSummary({
              userId,
              debate: { id: debate.id, question: debate.question },
              participantCount,
              endedRound
            });
          } catch (error) {
            await logRuntimeEvent("warn", "round summary failed", { debateId: id, error: describeRuntimeError(error) });
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
                    workflowPhaseTitle: workflowPhase?.title ?? "Phase 3 · 共识收敛与最终交付",
                    workflowPhaseRound: endedRound + 1
                  };
                  await persistDebatePhaseSnapshot(id, phaseSnapshot);
                  lastKnownPhase = phaseSnapshot;
                  finalizationEnteredAtBoundary = true;
                  emitDebateLiveEvent(id, {
                    type: "status",
                    debateId: id,
                    message: `Phase 3 入场表决已通过，第 ${endedRound + 1} 轮起正式进入 Phase 3`,
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

