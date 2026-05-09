import {
  CONTEXT_GENERATION_DIAGNOSTICS_PATH,
  CONTEXT_USAGE_BASELINE_PATH,
  CONTEXT_USAGE_LOG_PATH,
  CONTEXT_USAGE_PATH,
  CONTEXT_USAGE_TOTALS_PATH,
  ENABLE_DEBATE_MEMORY,
  MEMORY_LOG_COMPACT_THRESHOLD_CHARS,
  MEMORY_LOG_KEEP_LAST_LINES,
  MEMORY_LOG_PATH,
  MEMORY_SUMMARY_PATH,
  MEMORY_SUMMARY_REFRESH_EVERY_TURNS
} from "@/lib/runtime/constants";
import {
  readDebateAgentFile,
  readDebateFile,
  upsertDebateAgentFile,
  upsertDebateFile
} from "@/lib/runtime/file-store";
import {
  describeRuntimeError,
  logRuntimeEvent
} from "@/lib/runtime/provider-shared";
import { safeJsonParse } from "@/lib/runtime/workflow-phase";
import {
  appendWithTrim,
  safeParseJsonLine,
  splitJsonLines,
  trimToChars
} from "@/lib/runtime/runtime-utils";
import type { AgentRecord, StructuredOutput } from "@/lib/types";

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
    totalsParsed &&
    typeof totalsParsed === "object" &&
    (totalsParsed as any).byDebateAgentId &&
    typeof (totalsParsed as any).byDebateAgentId === "object"
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
    existing &&
    typeof existing === "object" &&
    (existing as any).byDebateAgentId &&
    typeof (existing as any).byDebateAgentId === "object"
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

  const totalsRaw = await readDebateFile(input.userId, input.debateId, CONTEXT_USAGE_TOTALS_PATH);
  const totalsParsed = totalsRaw ? safeJsonParse<Record<string, unknown>>(totalsRaw) : null;
  const byRaw =
    totalsParsed &&
    typeof totalsParsed === "object" &&
    (totalsParsed as any).byDebateAgentId &&
    typeof (totalsParsed as any).byDebateAgentId === "object"
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
    const turnNumber = Number(parsed.turnNumber ?? Number.NaN);
    if (!Number.isFinite(turnNumber)) continue;
    const proposedSolution = typeof parsed.proposedSolution === "string" ? parsed.proposedSolution : null;
    const agreementScore = typeof parsed.agreementScore === "number" ? parsed.agreementScore : null;
    const argsRaw = Array.isArray(parsed.arguments) ? parsed.arguments : [];
    const argumentsList = argsRaw
      .map((arg) => ({
        type:
          typeof (arg as { type?: unknown }).type === "string"
            ? String((arg as { type?: unknown }).type)
            : "support",
        content:
          typeof (arg as { content?: unknown }).content === "string"
            ? String((arg as { content?: unknown }).content)
            : ""
      }))
      .filter((arg) => arg.content.trim());
    const excerpt = typeof parsed.contentExcerpt === "string" ? parsed.contentExcerpt : "";
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
    input.turnNumber <= 2 ||
    input.turnNumber % MEMORY_SUMMARY_REFRESH_EVERY_TURNS === 0 ||
    nextLog.length > MEMORY_LOG_COMPACT_THRESHOLD_CHARS;

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

}
