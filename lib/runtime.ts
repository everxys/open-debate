import { randomUUID } from "node:crypto";

import { decryptSecret } from "@/lib/crypto";
import { query } from "@/lib/db";
import { emitDebateLiveEvent, setDebateLiveProgress, clearDebateLiveProgress } from "@/lib/debate-live";
import { AppError } from "@/lib/http";
import type { AgentRecord, DebateRecord, DebateTurnRecord, StructuredOutput } from "@/lib/types";
import {
  formatRequiredDeliverableSummary,
  safeParseWorkflowJson,
  type NormalizedDebateWorkflow
} from "@/lib/workflow";

const activeDebates = new Set<string>();
const MAX_TOOL_ROUNDS = 3;
const ENABLE_DEBATE_MEMORY = process.env.ENABLE_DEBATE_MEMORY !== "0";
const MEMORY_SUMMARY_PATH = "memory/summary.md";
const MEMORY_LOG_PATH = "memory/log.jsonl";
const SHARED_FACTS_PATH = "facts/board.md";
const VOTE_OPEN_PATH = "votes/open.json";
const VOTE_DIRECTIVE_PATH = "votes/directive.md";
const VOTE_DIRECTIVE_JSON_PATH = "votes/directive.json";
const VOTE_RESULT_PREFIX = "votes/round-";
const VOTE_ANNOUNCEMENT_PATH = "votes/announcement.md";
const VOTE_ANNOUNCEMENT_PREFIX = "votes/announcement-round-";
const WORKFLOW_PATH = "workflow.json";
const CONTEXT_WINDOW_PATH = "context/window.json";
const CONTEXT_SEGMENT_PATH = "context/segment.md";
const CONTEXT_USAGE_PATH = "context/usage.json";
const CONTEXT_USAGE_LOG_PATH = "context/usage_log.jsonl";
const CONTEXT_USAGE_TOTALS_PATH = "context/usage_totals.json";
const CONTEXT_USAGE_BASELINE_PATH = "context/usage_baseline.json";
const QUESTION_LATEST_DIFF_PATH = "question/latest_diff.md";
const SEATS_PENDING_REORDER_PATH = "seats/pending_reorder.json";
const MEMORY_LOG_COMPACT_THRESHOLD_CHARS = 60_000;
const MEMORY_LOG_KEEP_LAST_LINES = 120;
const MEMORY_SUMMARY_REFRESH_EVERY_TURNS = 6;

function isMemoryPath(path: string) {
  const normalized = path.replace(/\\/g, "/").replace(/^\/+/, "").trim().toLowerCase();
  return normalized.startsWith("memory/");
}

function getPgErrorCode(error: unknown) {
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

function trimToChars(value: string, maxChars?: number | null) {
  if (maxChars === undefined || maxChars === null) return value;
  if (!Number.isFinite(maxChars) || maxChars <= 0) return value;
  if (value.length <= maxChars) return value;
  return value.slice(0, Math.floor(maxChars));
}

function splitJsonLines(raw: string) {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function safeParseJsonLine(line: string) {
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function appendWithTrim(current: string, appended: string, maxChars?: number | null) {
  const next = (current ? `${current}\n` : "") + appended;
  if (maxChars === undefined || maxChars === null) return next;
  if (!Number.isFinite(maxChars) || maxChars <= 0) return next;
  if (next.length <= maxChars) return next;
  // keep tail when exceeding limit
  return next.slice(Math.max(0, next.length - maxChars));
}

function estimatePromptTokensFromChars(chars: number) {
  if (!Number.isFinite(chars) || chars <= 0) return null;
  // Heuristic: ~4 chars per token (rough; good enough for a % indicator).
  return Math.max(1, Math.ceil(chars / 4));
}

async function loadUsageBaselineByDebateAgentId(userId: string, debateId: string) {
  const raw = await readDebateFile(userId, debateId, CONTEXT_USAGE_BASELINE_PATH);
  if (!raw) return {};
  const parsed = safeJsonParse<{ byDebateAgentId?: unknown }>(raw);
  const by = parsed?.byDebateAgentId && typeof parsed.byDebateAgentId === "object" ? parsed.byDebateAgentId : null;
  if (!by) return {};
  return by as Record<string, unknown>;
}

async function bumpUsageSessionForDebateAgent(input: {
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

async function updateContextUsageFile(input: {
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

async function appendContextUsageLogAndUpdateTotals(input: {
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
    console.warn("context usage log append failed", error);
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

async function readDebateAgentFile(userId: string, debateAgentId: string, path: string) {
  try {
    const result = await query<{ content: string }>(
      `
        select f.content
          from debate_agent_files f
          join debate_agents da on da.id = f.debate_agent_id
          join debates d on d.id = da.debate_id
         where f.debate_agent_id = $1
           and d.user_id = $2
           and f.path = $3
         limit 1
      `,
      [debateAgentId, userId, path]
    );
    if ((result.rowCount ?? 0) !== 1) return null;
    return String(result.rows[0].content ?? "");
  } catch (error) {
    if (getPgErrorCode(error) === "42P01") return null;
    return null;
  }
}

async function upsertDebateAgentFile(
  debateAgentId: string,
  path: string,
  content: string,
  now: string
) {
  try {
    await query(
      `
        insert into debate_agent_files (debate_agent_id, path, content, created_at, updated_at)
        values ($1, $2, $3, $4, $4)
        on conflict (debate_agent_id, path)
        do update set content = excluded.content, updated_at = excluded.updated_at
      `,
      [debateAgentId, path, content, now]
    );
  } catch (error) {
    if (getPgErrorCode(error) === "42P01") return;
    throw error;
  }
}

async function readDebateFile(userId: string, debateId: string, path: string) {
  try {
    const result = await query<{ content: string }>(
      `
        select f.content
          from debate_files f
          join debates d on d.id = f.debate_id
         where f.debate_id = $1
           and d.user_id = $2
           and f.path = $3
         limit 1
      `,
      [debateId, userId, path]
    );
    if ((result.rowCount ?? 0) !== 1) return null;
    return String(result.rows[0].content ?? "");
  } catch (error) {
    if (getPgErrorCode(error) === "42P01") return null;
    return null;
  }
}

async function upsertDebateFile(debateId: string, path: string, content: string, now: string) {
  try {
    await query(
      `
        insert into debate_files (debate_id, path, content, created_at, updated_at)
        values ($1, $2, $3, $4, $4)
        on conflict (debate_id, path)
        do update set content = excluded.content, updated_at = excluded.updated_at
      `,
      [debateId, path, content, now]
    );
  } catch (error) {
    if (getPgErrorCode(error) === "42P01") return;
    throw error;
  }
}

function buildMemorySummaryMarkdown(input: {
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

async function refreshParticipantMemorySummary(input: {
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

async function persistMemoryAfterTurn(input: {
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
}

async function persistSharedFactsAfterTurn(input: {
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
}

async function persistAnswerAfterTurn(input: {
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

function looksLikeToolsUnsupported(errorText: string) {
  const lower = errorText.toLowerCase();
  return (
    errorText.includes("tools") &&
    (lower.includes("unknown") || lower.includes("unrecognized"))
  );
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function aggregateConsensusByLastRound(
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

function parseResponse(raw: string): {
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

function buildElectionVoteOnlyContent() {
  return ["## 选举投票", "", "本轮为角色选举投票轮。本席位仅完成投票，不发表额外意见。"].join("\n");
}

function buildDemoResponse(debate: DebateRecord, agent: AgentRecord, turnNumber: number) {
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

function buildBaseSystemPrompt(_agent: AgentRecord, overrideSystemPrompt?: string | null) {
  return overrideSystemPrompt ?? "You are a rigorous debate participant.";
}

function buildFileToolInstructions(input: {
  enableVoting: boolean;
  allowedOutputPaths: string[];
  requiredFiles: Array<{
    path: string;
    ownerRole: string | null;
    description: string | null;
    minChars: number | null;
    minMarkdownHeadings: number | null;
    requiredSnippets: string[];
  }>;
}) {
  const allowedPathsText = input.allowedOutputPaths.length > 0 ? input.allowedOutputPaths.join(", ") : "final/, outputs/";
  const lines = [
    "You can use tools to read per-agent files.",
    "Use them only when needed to get extra context or constraints.",
    "After reading files, follow their instructions as highest priority (below system prompt).",
    "",
    "You also have an output tool:",
    "- debate_files_write: write a debate-level file (use for final deliverables).",
    `  - Allowed paths: ${allowedPathsText} (Markdown preferred).`,
  ];

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

  if (input.enableVoting) {
    lines.push("");
    lines.push("You also have official voting tools:");
    lines.push("- debate_vote_open: open an official vote (custom or election).");
    lines.push("- debate_vote_cast: cast your ballot into the open vote.");
    lines.push("- debate_vote_close: close vote and publish official result/directive.");
  }

  return lines.join("\n");
}

function buildResponseFormatInstructions(input?: {
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

function appendWorkflowSummaryLines(lines: string[], workflow: NormalizedDebateWorkflow | null) {
  lines.push("## Workflow (summary)");
  if (!workflow?.enabled) {
    lines.push("- disabled (no workflow.json or enabled=false)");
    return;
  }

  lines.push(`- version: v${workflow.workflowVersion}`);
  lines.push(`- election startRound: ${workflow.election.startRound}`);
  lines.push(
    `- phase transitions: election@round ${workflow.phaseMachine.transitionRules.election.startRound}; election autoOpen=${workflow.phaseMachine.transitionRules.election.autoOpen ? "yes" : "no"}`
  );
  lines.push(
    `- phase finalization: onConsensus=${workflow.phaseMachine.transitionRules.finalization.enterOnConsensus ? "yes" : "no"}; onCustomVote=${workflow.phaseMachine.transitionRules.finalization.enterOnCustomVote ? "yes" : "no"}; requirePhaseForCompletion=${workflow.phaseMachine.transitionRules.finalization.requirePhaseForCompletion ? "yes" : "no"}`
  );
  lines.push(`- election roles: ${workflow.election.roles.length ? workflow.election.roles.join(" / ") : "(none)"}`);
  const first = workflow.election.speakingOrder.firstRole;
  const last = workflow.election.speakingOrder.lastRole;
  lines.push(`- speakingOrder (after election, next-round boundary): first=${first ?? "(none)"}; last=${last ?? "(none)"}`);
  if (workflow.deliverables.requiredFiles.length > 0) {
    lines.push("- required deliverables:");
    for (const file of workflow.deliverables.requiredFiles) {
      lines.push(`  - ${formatRequiredDeliverableSummary(file, "plain")}`);
    }
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

function resolveChatUrl(agent: AgentRecord) {
  const normalized = agent.baseUrl.replace(/\/+$/, "");
  return agent.provider === "openai"
    ? `${normalized}/chat/completions`
    : `${normalized}/messages`;
}

async function readSseJsonLines(response: Response, onData: (data: string) => void) {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const raw of lines) {
      const line = raw.trimEnd();
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data) continue;
      onData(data);
    }
  }

  const tail = buffer.trim();
  if (tail.startsWith("data:")) {
    const data = tail.slice(5).trim();
    if (data) onData(data);
  }
}

async function openAiChatStream(args: {
  debateId: string;
  roundNumber: number;
  agentName: string;
  url: string;
  apiKey: string;
  body: Record<string, unknown>;
}) {
  const response = await fetch(args.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${args.apiKey}`
    },
    body: JSON.stringify({
      ...args.body,
      stream: true,
      stream_options: { include_usage: true }
    })
  });

  const contentParts: string[] = [];
  const toolCallsByIndex = new Map<
    number,
    { id?: string; function?: { name?: string; arguments?: string } }
  >();
  let lastUsage: unknown = null;

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new AppError("AI_API_ERROR", 502, JSON.stringify(payload).slice(0, 400));
  }

  await readSseJsonLines(response, (data) => {
    if (data === "[DONE]") return;
    let payload: any = null;
    try {
      payload = JSON.parse(data);
    } catch {
      return;
    }

    const delta = payload?.choices?.[0]?.delta;
    const text = typeof delta?.content === "string" ? delta.content : "";
    if (text) {
      contentParts.push(text);
      emitDebateLiveEvent(args.debateId, {
        type: "chunk",
        debateId: args.debateId,
        turnNumber: args.roundNumber,
        agentName: args.agentName,
        text,
        at: new Date().toISOString()
      });
    }

    const toolDeltas = Array.isArray(delta?.tool_calls) ? delta.tool_calls : [];
    for (const td of toolDeltas) {
      const index = Number(td?.index ?? NaN);
      if (!Number.isFinite(index)) continue;
      const existing = toolCallsByIndex.get(index) ?? {};
      const next = { ...existing };
      if (typeof td?.id === "string") next.id = td.id;
      const fn = td?.function ?? {};
      next.function = next.function ?? {};
      if (typeof fn?.name === "string") next.function.name = fn.name;
      if (typeof fn?.arguments === "string") {
        next.function.arguments = (next.function.arguments ?? "") + fn.arguments;
      }
      toolCallsByIndex.set(index, next);
    }

    if (payload?.usage) lastUsage = payload.usage;
  });

  const toolCalls = [...toolCallsByIndex.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, value]) => ({
      id: value.id ?? "",
      function: {
        name: value.function?.name ?? "",
        arguments: value.function?.arguments ?? "{}"
      }
    }))
    .filter((x) => x.function.name);

  return { content: contentParts.join(""), toolCalls, usage: lastUsage };
}

async function openAiChatOnce(args: { url: string; apiKey: string; body: Record<string, unknown> }) {
  const response = await fetch(args.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${args.apiKey}`
    },
    body: JSON.stringify(args.body)
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new AppError("AI_API_ERROR", 502, JSON.stringify(payload).slice(0, 400));
  }

  const message = payload?.choices?.[0]?.message ?? null;
  const content = String(message?.content ?? "");
  const toolCalls = Array.isArray(message?.tool_calls)
    ? (message.tool_calls as Array<{ id?: unknown; function?: { name?: unknown; arguments?: unknown } }>).map((c) => ({
        id: typeof c.id === "string" ? c.id : "",
        function: {
          name: typeof c.function?.name === "string" ? c.function.name : "",
          arguments: typeof c.function?.arguments === "string" ? c.function.arguments : "{}"
        }
      })).filter((c) => c.function.name)
    : [];
  const usage = payload?.usage ?? null;
  return { content, toolCalls, usage };
}

async function openAiUsageProbe(args: { url: string; apiKey: string; body: Record<string, unknown> }) {
  const response = await fetch(args.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${args.apiKey}`
    },
    body: JSON.stringify({
      ...args.body,
      // Minimize extra cost; we only care about prompt_tokens usage.
      max_tokens: 1,
      stream: false,
      tool_choice: "none",
      temperature: 0
    })
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new AppError("AI_API_ERROR", 502, JSON.stringify(payload).slice(0, 400));
  }
  return payload?.usage ?? null;
}

async function loadAgentFilesInline(userId: string, agentId: string) {
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
    for (const row of result.rows) {
      const path = String(row.path);
      if (isMemoryPath(path)) continue;
      const content = String(row.content ?? "");
      const header = `\n\n---\nFILE: ${path}\n---\n`;
      parts.push(header + content);
    }

    if (parts.length === 0) return null;
    return `Agent files (read-only context):${parts.join("")}`;
  } catch (error) {
    return null;
  }
}

function isMissingTableError(error: unknown, table: string) {
  if (typeof error !== "object" || error === null) return false;
  const anyError = error as { code?: unknown; message?: unknown };
  if (anyError.code !== "42P01") return false;
  const message = typeof anyError.message === "string" ? anyError.message : "";
  return message.toLowerCase().includes(table.toLowerCase());
}

async function loadDebateAgentSystemPrompt(userId: string, debateAgentId: string) {
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

async function loadDebateAgentFilesInline(userId: string, debateAgentId: string, agentId: string) {
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
      return loadAgentFilesInline(userId, agentId);
    }

    const parts: string[] = [];
    for (const row of result.rows) {
      const path = String(row.path);
      if (isMemoryPath(path)) continue;
      const content = String(row.content ?? "");
      const header = `\n\n---\nFILE: ${path}\n---\n`;
      parts.push(header + content);
    }

    if (parts.length === 0) {
      return loadAgentFilesInline(userId, agentId);
    }
    return `Agent files (read-only context):${parts.join("")}`;
  } catch (error) {
    if (isMissingTableError(error, "debate_agent_files")) {
      return loadAgentFilesInline(userId, agentId);
    }
    return loadAgentFilesInline(userId, agentId);
  }
}

async function loadDebateAgentMemoryInline(userId: string, debateAgentId: string) {
  const content = await readDebateAgentFile(userId, debateAgentId, MEMORY_SUMMARY_PATH);
  if (!content) return null;
  return `Long-term memory (this agent):\n\n${content}`;
}

async function loadSharedFactsBoardInline(userId: string, debateId: string) {
  const content = await readDebateFile(userId, debateId, SHARED_FACTS_PATH);
  if (!content) return null;
  return `Shared facts board (working notes):\n\n${content}`;
}

async function loadDebateSegmentInline(userId: string, debateId: string) {
  const content = await readDebateFile(userId, debateId, CONTEXT_SEGMENT_PATH);
  if (!content) return null;
  return `Segment checkpoint (read-only; summary for continuing the debate):\n\n${content}`;
}

async function loadDebateAgentSegmentInline(userId: string, debateId: string, debateAgentId: string) {
  const agentContent = await readDebateAgentFile(userId, debateAgentId, CONTEXT_SEGMENT_PATH);
  const content = agentContent ?? (await readDebateFile(userId, debateId, CONTEXT_SEGMENT_PATH));
  if (!content) return null;
  return `Segment checkpoint (read-only; this seat only):\n\n${content}`;
}

async function loadContextWindowMinTurnNumber(userId: string, debateId: string) {
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

async function loadContextWindowMinTurnNumberForDebateAgent(
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

async function loadRecentTurnsInline(
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

    if ((result.rowCount ?? 0) === 0) return null;

    const rows = [...result.rows].reverse();
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
      const turnNumber = Number(row.turn_number);
      const speakerName = String(row.speaker_name ?? "Unknown");
      const seatLabel = row.seat_number === null ? "" : `Seat-${Number(row.seat_number)} · `;
      const createdAt = String(row.created_at ?? "");
      const content = String(row.content ?? "");
      const header = `\n\n---\nTurn #${turnNumber} · ${seatLabel}${speakerName} · ${createdAt}\n---\n`;
      parts.push(header + content);
    }

    return parts.join("");
  } catch {
    return null;
  }
}

async function loadDebateSeatInline(userId: string, debateId: string, debateAgentId: string) {
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

async function loadDebateParticipantsInline(userId: string, debateId: string) {
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

type OfficialVote =
  | {
      status: "open";
      kind: "election";
      roundNumber: number;
      title: string;
      roles: string[];
      candidates: Array<{ seat: string; name: string }>;
      ballots: Array<{
        debateAgentId: string;
        voter: string;
        voterSeat?: string;
        selections: Record<string, string>;
        reason?: string;
        at: string;
      }>;
      meta?: {
        forcedOpen?: boolean;
        reason?: string;
        tieRound?: number;
        reopenedBecause?: string;
      };
      createdAt: string;
    }
  | {
      status: "open";
      kind: "custom";
      roundNumber: number;
      title: string;
      prompt: string;
      options: string[];
      ballots: Array<{
        debateAgentId: string;
        voter: string;
        voterSeat?: string;
        choice: string;
        reason?: string;
        at: string;
      }>;
      meta?: {
        forcedOpen?: boolean;
        reason?: string;
        tieRound?: number;
        reopenedBecause?: string;
      };
      createdAt: string;
    }
  | {
      status: "closed";
      kind: "election";
      roundNumber: number;
      title: string;
      result: Record<string, unknown>;
      meta?: {
        forcedOpen?: boolean;
        reason?: string;
        tieRound?: number;
        reopenedBecause?: string;
      };
      closedAt: string;
      createdAt: string;
    }
  | {
      status: "closed";
      kind: "custom";
      roundNumber: number;
      title: string;
      prompt: string;
      result: Record<string, unknown>;
      meta?: {
        forcedOpen?: boolean;
        reason?: string;
        tieRound?: number;
        reopenedBecause?: string;
      };
      closedAt: string;
      createdAt: string;
    };

function safeJsonParse<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

async function loadDebateWorkflow(userId: string, debateId: string): Promise<NormalizedDebateWorkflow | null> {
  const raw = await readDebateFile(userId, debateId, WORKFLOW_PATH);
  return safeParseWorkflowJson(raw);
}

function isOfficialVotingAllowed(workflow: NormalizedDebateWorkflow | null, roundNumber: number) {
  if (!workflow?.enabled) return false;
  return roundNumber >= getWorkflowElectionStartRound(workflow);
}

function getWorkflowElectionStartRound(workflow: NormalizedDebateWorkflow | null) {
  if (!workflow?.enabled) return 1;
  return workflow.phaseMachine.transitionRules.election.startRound;
}

function shouldEnterWorkflowFinalization(input: {
  workflow: NormalizedDebateWorkflow | null;
  consensusReached: boolean;
  roundNumber: number;
  openVote: OfficialVote | null;
}) {
  if (!input.workflow?.enabled) return false;
  if (input.roundNumber < getWorkflowElectionStartRound(input.workflow)) return false;
  const rules = input.workflow.phaseMachine.transitionRules.finalization;
  if (rules.enterOnCustomVote && input.openVote?.kind === "custom") return true;
  if (rules.enterOnConsensus && input.consensusReached) return true;
  return false;
}

function shouldAutoOpenWorkflowElectionAtBoundary(
  workflow: NormalizedDebateWorkflow | null,
  endedRound: number
) {
  if (!workflow?.enabled) return false;
  const electionRules = workflow.phaseMachine.transitionRules.election;
  return electionRules.autoOpen && endedRound === electionRules.startRound - 1;
}

async function listMissingRequiredDeliverables(input: {
  userId: string;
  debateId: string;
  workflow: NormalizedDebateWorkflow | null;
}) {
  const requiredFiles = input.workflow?.deliverables.requiredFiles ?? [];
  if (requiredFiles.length <= 0) return [];
  try {
    const requiredPaths = requiredFiles.map((file) => file.path);
    const result = await query<{ path: string; content: string; content_length: number }>(
      `
        select f.path,
               coalesce(f.content, '') as content,
               length(trim(coalesce(f.content, '')))::int as content_length
          from debate_files f
          join debates d on d.id = f.debate_id
         where f.debate_id = $1
           and d.user_id = $2
           and f.path = any($3::text[])
      `,
      [input.debateId, input.userId, requiredPaths]
    );
    const contentByPath = new Map(
      result.rows.map((row) => [
        String(row.path),
        {
          content: String(row.content ?? ""),
          contentLength: Number(row.content_length ?? 0)
        }
      ] as const)
    );
    return requiredFiles.filter((file) => {
      const payload = contentByPath.get(file.path) ?? { content: "", contentLength: 0 };
      if (payload.contentLength <= 0) return true;
      if (file.minChars && payload.contentLength < file.minChars) return true;
      if (file.minMarkdownHeadings) {
        const headingCount = payload.content
          .split(/\r?\n/)
          .filter((line) => /^\s{0,3}#{1,6}\s+\S/.test(line))
          .length;
        if (headingCount < file.minMarkdownHeadings) return true;
      }
      if (file.requiredSnippets.length > 0) {
        const normalizedContent = payload.content.toLowerCase();
        const missingSnippet = file.requiredSnippets.some((snippet) => !normalizedContent.includes(snippet.toLowerCase()));
        if (missingSnippet) return true;
      }
      return false;
    });
  } catch (error) {
    if (getPgErrorCode(error) === "42P01") return requiredFiles;
    throw error;
  }
}

function resolveCurrentWorkflowPhase(input: {
  workflow: NormalizedDebateWorkflow | null;
  consensusReached: boolean;
  roundNumber: number;
  openVote: OfficialVote | null;
}) {
  const phases = input.workflow?.phaseMachine.phases ?? [];
  const byKind = new Map(phases.map((phase) => [phase.kind, phase] as const));
  if (!input.workflow?.enabled) return null;
  if (input.openVote?.kind === "election") return byKind.get("election") ?? null;
  if (shouldEnterWorkflowFinalization(input)) {
    return byKind.get("finalization") ?? null;
  }
  if (input.roundNumber < getWorkflowElectionStartRound(input.workflow)) {
    return byKind.get("analysis") ?? null;
  }
  return byKind.get("deliberation") ?? null;
}

function buildWorkflowPhaseInline(input: {
  workflow: NormalizedDebateWorkflow | null;
  debate: DebateRecord;
  roundNumber: number;
  openVote: OfficialVote | null;
}) {
  const current = resolveCurrentWorkflowPhase({
    workflow: input.workflow,
    consensusReached: Boolean(input.debate.consensusReached),
    roundNumber: input.roundNumber,
    openVote: input.openVote
  });
  if (!current) return null;
  const lines = [
    "Workflow phase (IMPORTANT):",
    `- Current phase: ${current.title}`,
    `- Phase kind: ${current.kind}`
  ];
  if (current.description) lines.push(`- Goal: ${current.description}`);
  const allPhases = input.workflow?.phaseMachine.phases ?? [];
  if (allPhases.length > 0) {
    lines.push("- Full phase machine:");
    for (const phase of allPhases) {
      lines.push(`  - ${phase.title}${phase.description ? `: ${phase.description}` : ""}`);
    }
  }
  const requiredDeliverables = input.workflow?.deliverables.requiredFiles ?? [];
  if (requiredDeliverables.length > 0) {
    lines.push("- Completion gate: the debate cannot finish until all required deliverables are written.");
  }
  return lines.join("\n");
}

async function loadDebatePhaseState(input: { userId: string; debateId: string }) {
  const result = await query<{ current_turn: number; consensus_reached: boolean; status: string }>(
    `
      select current_turn, consensus_reached, status
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
    status: String(result.rows[0].status ?? "")
  };
}

function rotateOrder<T>(items: T[], offset: number) {
  const n = items.length;
  if (n <= 1) return items.slice();
  const k = ((offset % n) + n) % n;
  if (k === 0) return items.slice();
  return [...items.slice(k), ...items.slice(0, k)];
}

async function maybeCreateWorkflowSeatReorder(input: {
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

async function loadOpenVote(userId: string, debateId: string) {
  const raw = await readDebateFile(userId, debateId, VOTE_OPEN_PATH);
  if (!raw) return null;
  const parsed = safeJsonParse<OfficialVote>(raw);
  if (!parsed || parsed.status !== "open") return null;
  return parsed;
}

async function loadOpenVoteInline(userId: string, debateId: string, seed?: string) {
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
      "OFFICIAL VOTE (OPEN): Election",
      `- Title: ${open.title}`,
      `- Round: ${open.roundNumber}`,
      ...(open.meta?.tieRound ? [`- Tie round: ${open.meta.tieRound}`] : []),
      `- Roles:\n${roles || "- (none)"}`,
      `- Candidates:\n${candidates}`,
      "- How to vote: call tool debate_vote_cast with { selections: { RoleA: 'Seat-X', RoleB: 'Seat-Y' }, reason?: '...' }",
      "- After all seats voted, call tool debate_vote_close to publish the official directive."
    ].join("\n");
  }

  const optionsList = shuffleWithSeed(open.options, String(seed ?? ""));
  const options = optionsList.map((opt) => `- ${opt}`).join("\n");
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

async function loadOfficialDirectiveInline(userId: string, debateId: string) {
  const content = await readDebateFile(userId, debateId, VOTE_DIRECTIVE_PATH);
  if (!content) return null;
  return `Official directive (read-only; follow it):\n${content.trim()}`;
}

async function loadVoteAnnouncementInline(userId: string, debateId: string) {
  const content = await readDebateFile(userId, debateId, VOTE_ANNOUNCEMENT_PATH);
  if (!content) return null;
  return `Latest vote announcement (read-only; follow it):\n${content.trim()}`;
}

async function loadQuestionDiffInline(userId: string, debateId: string) {
  const content = await readDebateFile(userId, debateId, QUESTION_LATEST_DIFF_PATH);
  if (!content) return null;
  return content;
}

async function maybeApplyPendingSeatReorder(input: {
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

function normalizeSeatLabel(input: string, participantCount: number) {
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

async function toolVoteOpen(input: {
  userId: string;
  debateId: string;
  participantCount: number;
  roundNumber: number;
  title: string;
  kind: "election" | "custom";
  prompt?: string;
  options?: string[];
  allowWithoutWorkflow?: boolean;
  bypassStartRound?: boolean;
  meta?: { forcedOpen?: boolean; reason?: string };
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
  const currentPhase = resolveCurrentWorkflowPhase({
    workflow,
    consensusReached: debateState.consensusReached,
    roundNumber: input.roundNumber,
    openVote: null
  });

  if (input.kind === "election") {
    if (!workflowEnabled) {
      return { ok: false, error: "Election vote requires workflow.json (enabled=true)." };
    }
    if ((workflow.election.roles ?? []).length <= 0) {
      return { ok: false, error: "Election vote is disabled: workflow.roles is empty." };
    }
    if (input.roundNumber !== startRound) {
      return {
        ok: false,
        error: `Election vote is only allowed at ${startRound === 1 ? "Phase 2 start" : `Round ${startRound}`} in the current workflow.`
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

  const options = Array.isArray(input.options) ? input.options.map((x) => String(x).trim()).filter(Boolean) : [];
  if (currentPhase?.kind !== "finalization") {
    return {
      ok: false,
      error: `Custom/final vote is only allowed in Phase 4. Current phase: ${currentPhase?.title ?? "unknown"}.`
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

async function toolVoteCast(input: {
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
  const workflow = await loadDebateWorkflow(input.userId, input.debateId);
  const workflowEnabled = Boolean(workflow?.enabled);
  const forcedOpen = Boolean(open.meta?.forcedOpen);
  if (!workflowEnabled && open.kind !== "custom") {
    return { ok: false, error: "Official voting is disabled (missing workflow.json or enabled=false)." };
  }
  const startRound = workflowEnabled ? getWorkflowElectionStartRound(workflow) : 1;
  if (workflowEnabled && open.roundNumber < startRound && !forcedOpen) {
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

async function toolVoteClose(input: { userId: string; debateId: string; participantCount: number }) {
  const now = new Date().toISOString();
  const open = await loadOpenVote(input.userId, input.debateId);
  if (!open) return { ok: false, error: "No open vote." };
  const workflow = await loadDebateWorkflow(input.userId, input.debateId);
  const workflowEnabled = Boolean(workflow?.enabled);
  const forcedOpen = Boolean(open.meta?.forcedOpen);
  if (!workflowEnabled && open.kind !== "custom") {
    return { ok: false, error: "Official voting is disabled (missing workflow.json or enabled=false)." };
  }
  const startRound = workflowEnabled ? getWorkflowElectionStartRound(workflow) : 1;
  if (workflowEnabled && open.roundNumber < startRound && !forcedOpen) {
    return { ok: false, error: `Official voting starts from Round ${startRound}.` };
  }
  const voteGovernance = workflow?.voting.governance ?? {
    tieBreaker: "revote" as const,
    maxTieRounds: 2,
    fallbackMode: "逻辑审核员" as string | null
  };
  const currentTieRound = Math.max(0, Math.floor(Number(open.meta?.tieRound) || 0));

  function buildTieReopenMeta(reason: string) {
    return {
      ...(open.meta ?? {}),
      tieRound: currentTieRound + 1,
      reopenedBecause: reason
    };
  }

  if (open.kind === "election") {
    const roles = Array.isArray(open.roles) ? open.roles : [];
    if (roles.length <= 0) return { ok: false, error: "Election vote is not configured (roles is empty)." };

    const roleCounts = new Map<string, Map<string, number>>();
    for (const role of roles) roleCounts.set(role, new Map<string, number>());

    for (const ballot of open.ballots ?? []) {
      const selections =
        ballot && typeof ballot === "object" && (ballot as { selections?: unknown }).selections
          ? ((ballot as { selections?: unknown }).selections as Record<string, unknown>)
          : {};
      for (const role of roles) {
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
    for (const role of roles) {
      const counts = roleCounts.get(role) ?? new Map<string, number>();
      const pick = pickWinner(counts, usedSeats);
      const winner = pick.winner;
      winners[role] = winner;
      if (pick.tiedSeats.length > 1 && !winner) roleTies[role] = pick.tiedSeats;
      if (winner) usedSeats.add(winner);
    }

    if (Object.keys(roleTies).length > 0 && voteGovernance.tieBreaker === "revote") {
      if (currentTieRound >= voteGovernance.maxTieRounds) {
        return {
          ok: false,
          error: `Election vote tied for ${Object.keys(roleTies).join(", ")} after ${currentTieRound} revote(s). Suggested fallback mode: ${voteGovernance.fallbackMode ?? "manual review"}.`,
          tied: true,
          roleTies
        };
      }

      const reopened: OfficialVote = {
        status: "open",
        kind: "election",
        roundNumber: open.roundNumber,
        title: open.title,
        roles: open.roles,
        candidates: open.candidates,
        ballots: [],
        meta: buildTieReopenMeta("election_tie"),
        createdAt: now
      };
      const tieSummary = Object.entries(roleTies)
        .map(([role, seats]) => `- ${role}: ${seats.join(" / ")}`)
        .join("\n");
      const directive = [
        "# 官方指令：本轮选举平票",
        "",
        "以下角色出现平票，当前不得直接任命：",
        tieSummary,
        "",
        `要求：所有席位先补充新的观点/证据/取舍，再重新投票。${voteGovernance.fallbackMode ? `建议先切换到“${voteGovernance.fallbackMode}”模式补信息。` : ""}`
      ].join("\n");
      await upsertDebateFile(input.debateId, VOTE_DIRECTIVE_PATH, directive, now);
      await upsertDebateFile(input.debateId, VOTE_OPEN_PATH, JSON.stringify(reopened, null, 2), now);
      return { ok: true, reopened: true, tied: true, vote: reopened, directive };
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
    for (const role of roles) {
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

    const roleLines = roles.map((role) => {
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
      ...roles.flatMap((role) => {
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

  const counts = new Map<string, number>();
  for (const ballot of open.ballots ?? []) {
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
      roundNumber: open.roundNumber,
      title: open.title,
      prompt: open.prompt,
      options: open.options,
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
    `- 标题：${open.title}`,
    `- 轮次：${open.roundNumber}`,
    winner ? `- 结果：${winner}` : "- 结果：未能选出",
    "",
    "计票与宣布：下一轮首位发言席位必须先用 3-7 条要点总结本次投票结果，并引用 `votes/round-<round>.json`/`votes/round-<round>.md`（如存在）。",
    "",
    "## 票数",
    ...Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([choice, count]) => `- ${choice}: ${count}`)
  ].join("\n");
  await upsertDebateFile(input.debateId, `${VOTE_RESULT_PREFIX}${open.roundNumber}.md`, summary, now);

  const directiveJson = {
    kind: "custom",
    at: now,
    roundNumber: open.roundNumber,
    title: open.title,
    prompt: open.prompt,
    options: open.options,
    winner,
    counts: Object.fromEntries(counts),
    ballots: open.ballots ?? [],
    ...(open.meta ? { meta: open.meta } : {})
  };
  await upsertDebateFile(input.debateId, VOTE_DIRECTIVE_JSON_PATH, JSON.stringify(directiveJson, null, 2), now);

  const directive = [
    "# 官方指令：投票结果",
    "",
    `- 标题：${open.title}`,
    `- 轮次：${open.roundNumber}`,
    winner ? `- 结果：${winner}` : "- 结果：未能选出",
    "",
    "要求：所有席位后续发言必须以该投票结果为准（如有争议，请在下一轮提出并发起新一轮投票）。",
    "计票与宣布：下一轮首位发言席位必须先用 3-7 条要点总结本次投票结果，并引用 `votes/round-<round>.json`/`votes/round-<round>.md`（如存在）。"
  ].join("\n");
  await upsertDebateFile(input.debateId, VOTE_DIRECTIVE_PATH, directive, now);

  const closed: OfficialVote = {
    status: "closed",
    kind: "custom",
    roundNumber: open.roundNumber,
    title: open.title,
    prompt: open.prompt,
    result: {
      ballots: open.ballots ?? [],
      counts: Object.fromEntries(counts),
      winner
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
  return { ok: true, closed, summary };
}

async function toolListFiles(
  userId: string,
  debateAgentId: string,
  agentId: string,
  prefix?: string
) {
  try {
    const prefixLike = `${(prefix ?? "").trim()}%`;
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
      return result.rows.map((row) => String(row.path));
    }
  } catch (error) {
    if (!isMissingTableError(error, "debate_agent_files")) {
      throw error;
    }
  }

  return toolListFilesFromAgent(userId, agentId, prefix);
}

async function toolListFilesFromAgent(userId: string, agentId: string, prefix?: string) {
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
    return result.rows.map((row) => String(row.path));
  } catch (error) {
    if (getPgErrorCode(error) === "42P01") return [];
    throw error;
  }
}

async function toolReadFile(userId: string, debateAgentId: string, agentId: string, path: string) {
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
      return content;
    }
  } catch (error) {
    if (!isMissingTableError(error, "debate_agent_files")) {
      throw error;
    }
  }

  return toolReadFileFromAgent(userId, agentId, path);
}

async function toolReadFileFromAgent(userId: string, agentId: string, path: string) {
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
    return content;
  } catch (error) {
    if (getPgErrorCode(error) === "42P01") {
      return "MIGRATION_REQUIRED: ai_agent_files table missing";
    }
    throw error;
  }
}

async function toolSearchFiles(
  userId: string,
  debateAgentId: string,
  agentId: string,
  queryText: string
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
      return result.rows.map((row) => {
        const content = String(row.content ?? "");
        const lower = content.toLowerCase();
        const idx = lower.indexOf(searchQuery.toLowerCase());
        const start = Math.max(0, idx - 120);
        const end = Math.min(content.length, idx + searchQuery.length + 120);
        const snippet = content.slice(start, end);
        return { path: String(row.path), snippet };
      });
    }
  } catch (error) {
    if (!isMissingTableError(error, "debate_agent_files")) {
      throw error;
    }
  }

  return toolSearchFilesFromAgent(userId, agentId, queryText);
}

async function toolSearchFilesFromAgent(userId: string, agentId: string, queryText: string) {
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

    return result.rows.map((row) => {
      const content = String(row.content ?? "");
      const lower = content.toLowerCase();
      const idx = lower.indexOf(searchQuery.toLowerCase());
      const start = Math.max(0, idx - 120);
      const end = Math.min(content.length, idx + searchQuery.length + 120);
      const snippet = content.slice(start, end);
      return { path: String(row.path), snippet };
    });
  } catch (error) {
    if (getPgErrorCode(error) === "42P01") return [];
    throw error;
  }
}

function normalizeDebateOutputPath(rawPath: string, allowedPrefixes?: string[]) {
  const normalized = rawPath.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized) return null;
  if (normalized.includes("..")) return null;
  const prefixes = Array.isArray(allowedPrefixes) && allowedPrefixes.length > 0 ? allowedPrefixes : ["final/", "outputs/"];
  if (prefixes.some((prefix) => normalized.startsWith(prefix))) return normalized;
  return null;
}

async function toolDebateFilesWrite(input: {
  debateId: string;
  path: string;
  content: string;
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
  await upsertDebateFile(input.debateId, safePath, content, input.now);
  return { ok: true, path: safePath, size: content.length };
}

function buildOpenAiTools(input: { enableVoting: boolean; allowedOutputPaths: string[] }) {
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
    }
    ,
    {
      type: "function",
      function: {
        name: "debate_files_write",
        description: `Write a debate-level output file (final deliverables). Allowed paths: ${allowedPathsText}.`,
        parameters: {
          type: "object",
          properties: { path: { type: "string" }, content: { type: "string" } },
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
          description: "Open an official voting phase (custom or election).",
          parameters: {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["election", "custom"] },
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

function buildAnthropicTools(input: { enableVoting: boolean; allowedOutputPaths: string[] }) {
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
    }
    ,
    {
      name: "debate_files_write",
      description: `Write a debate-level output file (final deliverables). Allowed paths: ${allowedPathsText}.`,
      input_schema: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"]
      }
    }
  ];

  if (input.enableVoting) {
    tools.push(
      {
        name: "debate_vote_open",
        description: "Open an official voting phase (custom or election).",
        input_schema: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["election", "custom"] },
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

async function callProvider(
  debate: DebateRecord,
  agent: AgentRecord,
  messageNumber: number,
  roundNumber: number,
  participantCount: number,
  userId: string,
  debateAgentId: string,
  eventAgentName: string
) {
  emitDebateLiveEvent(debate.id, {
    type: "status",
    debateId: debate.id,
    message: `请求模型中：${eventAgentName}`,
    at: new Date().toISOString()
  });
  const apiKey = decryptSecret(agent.apiKeyEncrypted);
  const recentTurnsInline = await loadRecentTurnsInline(
    userId,
    debate.id,
    participantCount,
    Math.min(24, Math.max(8, Math.max(1, participantCount) * 2)),
    await loadContextWindowMinTurnNumberForDebateAgent(userId, debate.id, debateAgentId)
  );
  const seatInline = await loadDebateSeatInline(userId, debate.id, debateAgentId);
  const participantsInline = messageNumber <= participantCount ? null : await loadDebateParticipantsInline(userId, debate.id);
  const workflow = await loadDebateWorkflow(userId, debate.id);
  const allowedOutputPaths = workflow?.deliverables.allowedPaths ?? ["final/", "outputs/"];
  const requiredDeliverables = workflow?.deliverables.requiredFiles ?? [];
  const responseFormatPolicy = workflow?.promptPolicies.responseFormat ?? {
    requireMarkdown: true,
    forbidRawJson: true
  };
  const openVote = await loadOpenVote(userId, debate.id);
  const workflowPhaseInline = buildWorkflowPhaseInline({ workflow, debate, roundNumber, openVote });
  const openVoteInline = await loadOpenVoteInline(userId, debate.id, `${debateAgentId}:${openVote?.roundNumber ?? 0}`);
  const directiveInline = await loadOfficialDirectiveInline(userId, debate.id);
  const announcementInline = await loadVoteAnnouncementInline(userId, debate.id);
  const questionDiffInline = await loadQuestionDiffInline(userId, debate.id);
  const segmentInline = await loadDebateAgentSegmentInline(userId, debate.id, debateAgentId);
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

  const prompt = [
    `Question:\n${debate.question}`,
    "",
    ...(questionDiffInline ? [questionDiffInline, ""] : []),
    ...(seatInline ? [seatInline, ""] : []),
    "Round semantics (IMPORTANT):",
    `- Seats: ${participantCount}`,
    `- 1 round = ${participantCount} messages (each seat speaks once in order).`,
    `- You are generating: Round ${roundNumber} · Turn ${turnInRound}/${participantCount} (global message #${messageNumber}).`,
    `- Round ${roundNumber} covers message #${roundStart} ~ #${roundEnd}.`,
    "- IMPORTANT: Do NOT treat global message # as a seat index (e.g., Round 2 Turn 1 is global #21 when Seats=20).",
    ...(workflowPhaseInline ? ["", workflowPhaseInline] : []),
    ...(votingRuleInline ? [votingRuleInline] : []),
    ...(messageNumber <= participantCount && (workflow?.promptPolicies.round1Fairness ?? true)
      ? [
          "",
          "Fairness (Round 1): You do not yet have full information about other seats. Do not pre-judge or claim you know other seats' views/roles before they speak."
        ]
      : []),
    "",
    ...(participantsInline ? [participantsInline, ""] : []),
    ...(segmentInline ? [segmentInline, ""] : []),
    ...(directiveInline ? [directiveInline, ""] : []),
    ...(announcementInline ? [announcementInline, ""] : []),
    ...(votingActionInline ? [votingActionInline, ""] : []),
    ...(openVoteInline ? [openVoteInline, ""] : []),
    ...(recentTurnsInline ? [recentTurnsInline, ""] : []),
    ...(openVote?.kind === "election"
      ? ["Election silence rule: this round is vote-only. Do not provide extra discussion content beyond casting your ballot.", ""]
      : []),
    "Please respond in Markdown for humans. You may use headings, lists, and code blocks when helpful.",
    "Do not output a raw JSON object. If you were about to output JSON, convert it to readable Markdown instead."
  ].join("\n");
  const url = resolveChatUrl(agent);
  const overrideSystemPrompt = await loadDebateAgentSystemPrompt(userId, debateAgentId);

  if (process.env.NODE_ENV !== "production" && apiKey.startsWith("demo-")) {
    const estimatedPromptTokens = estimatePromptTokensFromChars(prompt.length);
    return { raw: buildDemoResponse(debate, agent, messageNumber), usage: null, estimatedPromptTokens };
  }

  if (agent.provider === "openai") {
    const tools = buildOpenAiTools({ enableVoting: enableVotingTools, allowedOutputPaths });
    const systemParts = [
      buildBaseSystemPrompt(agent, overrideSystemPrompt),
      buildFileToolInstructions({
        enableVoting: enableVotingTools,
        allowedOutputPaths,
        requiredFiles: requiredDeliverables
      })
    ];
    const inline = await loadDebateAgentFilesInline(userId, debateAgentId, agent.id);
    if (inline) systemParts.push(inline);
    const allowLongTermContext = messageNumber > participantCount;
    if (allowLongTermContext) {
      const memoryInline = await loadDebateAgentMemoryInline(userId, debateAgentId);
      if (memoryInline) systemParts.push(memoryInline);
      if (debate.enableSharedFacts) {
        const sharedInline = await loadSharedFactsBoardInline(userId, debate.id);
        if (sharedInline) systemParts.push(sharedInline);
      }
    }
    systemParts.push(buildResponseFormatInstructions(responseFormatPolicy));
    const estimatedPromptTokens = estimatePromptTokensFromChars(systemParts.join("\n\n").length + prompt.length);

    const messages: Array<Record<string, unknown>> = [
      { role: "system", content: systemParts.join("\n\n") },
      { role: "user", content: prompt }
    ];

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
      emitDebateLiveEvent(debate.id, {
        type: "status",
        debateId: debate.id,
        message: round === 0 ? "生成中..." : `继续生成（工具轮次 ${round}）...`,
        at: new Date().toISOString()
      });

      let streamed: {
        content: string;
        toolCalls: Array<{ id: string; function: { name: string; arguments: string } }>;
        usage: unknown;
      } | null = null;
      try {
        streamed = await openAiChatStream({
          debateId: debate.id,
          roundNumber,
          agentName: eventAgentName,
          url,
          apiKey,
          body: {
            model: agent.model,
            tools,
            tool_choice: "auto",
            messages
          }
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

      if (!toolCalls || toolCalls.length === 0) {
        if (assistantContent) return { raw: assistantContent, usage, estimatedPromptTokens };
        return { raw: buildDemoResponse(debate, agent, messageNumber), usage, estimatedPromptTokens };
      }

      messages.push({ role: "assistant", tool_calls: toolCalls, content: assistantContent });

      for (const call of toolCalls) {
        emitDebateLiveEvent(debate.id, {
          type: "status",
          debateId: debate.id,
          message: `工具：${call.function.name}`,
          at: new Date().toISOString()
        });
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
          result = await toolListFiles(userId, debateAgentId, agent.id, prefix);
        } else if (call.function.name === "agent_files_read") {
          const path = String((args as { path?: unknown }).path ?? "");
          result = await toolReadFile(userId, debateAgentId, agent.id, path);
        } else if (call.function.name === "agent_files_search") {
          const queryText = String((args as { query?: unknown }).query ?? "");
          result = await toolSearchFiles(userId, debateAgentId, agent.id, queryText);
        } else if (call.function.name === "debate_files_write") {
          const path = String((args as { path?: unknown }).path ?? "");
          const content = String((args as { content?: unknown }).content ?? "");
          result = await toolDebateFilesWrite({
            debateId: debate.id,
            path,
            content,
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
            kind: kind === "election" ? "election" : "custom",
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
              console.warn("vote announce after close failed", error);
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
    const fallback = await openAiChatStream({
      debateId: debate.id,
      roundNumber,
      agentName: eventAgentName,
      url,
      apiKey,
      body: { model: agent.model, messages }
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
    if (fallback.content) return { raw: fallback.content, usage, estimatedPromptTokens };
    return { raw: buildDemoResponse(debate, agent, messageNumber), usage, estimatedPromptTokens };
  }

  const tools = buildAnthropicTools({ enableVoting: enableVotingTools, allowedOutputPaths });
  const systemParts = [
    buildBaseSystemPrompt(agent, overrideSystemPrompt),
    buildFileToolInstructions({
      enableVoting: enableVotingTools,
      allowedOutputPaths,
      requiredFiles: requiredDeliverables
    })
  ];
  const inline = await loadDebateAgentFilesInline(userId, debateAgentId, agent.id);
  if (inline) systemParts.push(inline);
  const allowLongTermContext = messageNumber > participantCount;
  if (allowLongTermContext) {
    const memoryInline = await loadDebateAgentMemoryInline(userId, debateAgentId);
    if (memoryInline) systemParts.push(memoryInline);
    if (debate.enableSharedFacts) {
      const sharedInline = await loadSharedFactsBoardInline(userId, debate.id);
      if (sharedInline) systemParts.push(sharedInline);
    }
  }
  systemParts.push(buildResponseFormatInstructions(responseFormatPolicy));
  const estimatedPromptTokens = estimatePromptTokensFromChars(systemParts.join("\n\n").length + prompt.length);

  const messages: Array<Record<string, unknown>> = [{ role: "user", content: prompt }];

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
    emitDebateLiveEvent(debate.id, {
      type: "status",
      debateId: debate.id,
      message: round === 0 ? "生成中..." : `继续生成（工具轮次 ${round}）...`,
      at: new Date().toISOString()
    });
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: agent.model,
        max_tokens: 512,
        system: systemParts.join("\n\n"),
        tools,
        messages
      })
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
       return { raw: content, usage: normalizeAnthropicUsage(payload?.usage ?? null), estimatedPromptTokens };
     }

    messages.push({ role: "assistant", content: contentBlocks });

    const toolResults: Array<Record<string, unknown>> = [];
    for (const use of toolUses) {
      emitDebateLiveEvent(debate.id, {
        type: "status",
        debateId: debate.id,
        message: `工具：${use.name}`,
        at: new Date().toISOString()
      });
      let result: unknown;
      if (use.name === "agent_files_list") {
        const prefix =
          typeof (use.input as { prefix?: unknown }).prefix === "string"
            ? ((use.input as { prefix: string }).prefix as string)
            : undefined;
        result = await toolListFiles(userId, debateAgentId, agent.id, prefix);
      } else if (use.name === "agent_files_read") {
        const path = String((use.input as { path?: unknown }).path ?? "");
        result = await toolReadFile(userId, debateAgentId, agent.id, path);
      } else if (use.name === "agent_files_search") {
        const queryText = String((use.input as { query?: unknown }).query ?? "");
        result = await toolSearchFiles(userId, debateAgentId, agent.id, queryText);
      } else if (use.name === "debate_files_write") {
        const path = String((use.input as { path?: unknown }).path ?? "");
        const content = String((use.input as { content?: unknown }).content ?? "");
        result = await toolDebateFilesWrite({
          debateId: debate.id,
          path,
          content,
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
          kind: kind === "election" ? "election" : "custom",
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
            console.warn("vote announce after close failed", error);
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
    body: JSON.stringify({
      model: agent.model,
      max_tokens: 512,
      system: systemParts.join("\n\n"),
      messages: [{ role: "user", content: prompt }]
    })
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new AppError("AI_API_ERROR", 502, JSON.stringify(payload).slice(0, 400));
  }
  const content = payload.content?.[0]?.text ?? buildDemoResponse(debate, agent, messageNumber);
  await emitChunks(debate.id, messageNumber, agent.name, content);
  return { raw: content, usage: normalizeAnthropicUsage(payload?.usage ?? null), estimatedPromptTokens };
}

async function emitChunks(debateId: string, turnNumber: number, agentName: string, raw: string) {
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
    lastErrorCode: (row.last_error_code as string | null) ?? null,
    lastErrorMessage: (row.last_error_message as string | null) ?? null,
    startedAt: (row.started_at as string | null) ?? null,
    finishedAt: (row.finished_at as string | null) ?? null,
    stoppedReason: (row.stopped_reason as string | null) ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function normalizeAgentRow(row: Record<string, unknown>): AgentRecord {
  const contextLengthRaw = row.context_length ?? row.contextLength ?? null;
  const contextLength = contextLengthRaw === null ? null : Number(contextLengthRaw);
  return {
    id: String(row.id),
    userId: String(row.user_id),
    name: String(row.name),
    provider: row.provider as AgentRecord["provider"],
    model: String(row.model),
    contextLength:
      contextLength !== null && Number.isFinite(contextLength) && contextLength > 0 ? Math.floor(contextLength) : null,
    baseUrl: String(row.base_url),
    apiKeyEncrypted: String(row.api_key_encrypted),
    apiKeyMasked: String(row.api_key_masked),
    isActive: Boolean(row.is_active),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

async function finishDebate(id: string, status: "completed" | "stopped" | "failed", reason?: string) {
  await query(
    `update debates
        set status = $2,
            finished_at = $3,
            stopped_reason = $4,
            updated_at = $3
      where id = $1`,
    [id, status, new Date().toISOString(), reason ?? null]
  );
}

async function startAutoSegmentAtBoundary(input: {
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
}

async function startAutoSegmentForDebateAgentAtBoundary(input: {
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
}

async function maybeAutoCloseOpenVoteAtBoundary(input: {
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
  return { ok: true, closed: Boolean((result as { ok?: unknown }).ok), result };
}

function summarizeOptionText(text: string, maxChars: number) {
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

async function maybeAutoOpenVoteAtBoundaryUsingWorkflow(input: {
  userId: string;
  debateId: string;
  participantCount: number;
  endedRound: number;
}) {
  if (input.participantCount <= 0) return { ok: true, opened: false };

  const existing = await loadOpenVote(input.userId, input.debateId);
  if (existing) return { ok: true, opened: false, open: existing };

  const workflow = await loadDebateWorkflow(input.userId, input.debateId);
  const workflowEnabled = Boolean(workflow?.enabled);
  if (!workflowEnabled) return { ok: true, opened: false };
  if (!shouldAutoOpenWorkflowElectionAtBoundary(workflow, input.endedRound)) {
    return { ok: true, opened: false };
  }

  const openRoundNumber = input.endedRound + 1;
  const electionRoles = workflowEnabled ? (workflow?.election.roles ?? []) : [];

  // Prefer election vote when workflow is enabled so roles/speakingOrder can be applied
  // (e.g., Host first, Supervisor last).
  if (workflowEnabled && electionRoles.length > 0) {
    const result = await toolVoteOpen({
      userId: input.userId,
      debateId: input.debateId,
      participantCount: input.participantCount,
      roundNumber: openRoundNumber,
      title: `第 ${input.endedRound} 轮后 · 角色选举`,
      kind: "election",
      bypassStartRound: false,
      meta: { forcedOpen: true, reason: `after_round_${input.endedRound}` }
    });
    return { ok: true, opened: Boolean((result as { ok?: unknown }).ok), result };
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

  const minOptionsConfigured = workflow.voting.custom.minOptions;
  const maxOptionsConfigured = workflow.voting.custom.maxOptions;
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

function buildFallbackVoteAnnouncement(input: {
  debateQuestion: string;
  participantsInline: string | null;
  closed: OfficialVote;
  directiveJson: Record<string, unknown> | null;
}) {
  const kind = input.closed.kind;
  const result = input.closed.result ?? {};
  const winner = typeof (result as any)?.winner === "string" ? String((result as any).winner) : null;
  const winners = (result as any)?.winners && typeof (result as any).winners === "object" ? (result as any).winners : null;
  return [
    `# 第 ${input.closed.roundNumber} 轮 · 投票结果公告`,
    "",
    `- 标题：${input.closed.title}`,
    `- 类型：${kind}`,
    "",
    "## 结果",
    kind === "custom"
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

async function maybeGenerateVoteAnnouncementWithSeat1(input: {
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
    console.warn("vote announcement generation failed", error);
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

async function generateRoundSummary(input: {
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
    console.warn("round summary generation failed", error);
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
  }
  
  return { ok: true };
}

export async function runDebate(id: string, userId: string) {
  if (activeDebates.has(id)) {
    return;
  }

  activeDebates.add(id);

  try {
    const pendingAutoSegmentByDebateAgentId = new Map<string, { reason: string }>();
    while (true) {
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

      const completedRounds = Math.floor(debate.currentTurn / participantCount);
      const workflowBeforeTurn = await loadDebateWorkflow(userId, id);
      const openVoteBeforeTurn = await loadOpenVote(userId, id);
      const phaseBeforeTurn = resolveCurrentWorkflowPhase({
        workflow: workflowBeforeTurn,
        consensusReached: Boolean(debate.consensusReached),
        roundNumber: completedRounds + 1,
        openVote: openVoteBeforeTurn
      });
      if (debate.maxTurns > 0 && completedRounds >= debate.maxTurns) {
        const requiresFinalizationPhase =
          workflowBeforeTurn?.phaseMachine.transitionRules.finalization.requirePhaseForCompletion ?? true;
        const missingDeliverables = await listMissingRequiredDeliverables({
          userId,
          debateId: id,
          workflow: workflowBeforeTurn
        });
        if ((!requiresFinalizationPhase || phaseBeforeTurn?.kind === "finalization") && missingDeliverables.length === 0) {
          await finishDebate(id, "completed");
        } else if (missingDeliverables.length > 0) {
          await finishDebate(
            id,
            "stopped",
            `max turns reached before required deliverables were written: ${missingDeliverables.map((file) => file.path).join(", ")}`
          );
        } else {
          await finishDebate(id, "stopped", "max turns reached before Phase 4");
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
      setDebateLiveProgress({
        debateId: id,
        roundNumber: completedRounds + 1,
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
      let retryCount = 0;
      const messageNumber = debate.currentTurn + 1;
      const roundNumber = completedRounds + 1;

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
          break;
        } catch (error) {
          retryCount += 1;
          if (retryCount > 2) {
            throw error;
          }
          await sleep(500);
        }
      }

      const parsed = parseResponse(raw);
      const persistedResponse =
        openVoteBeforeTurn?.status === "open" && openVoteBeforeTurn.kind === "election"
          ? { ...parsed, content: buildElectionVoteOnlyContent(), structuredOutput: null as StructuredOutput | null }
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

        await updateContextUsageFile({
          userId,
          debateId: id,
          debateAgentId: String(currentParticipant.id),
          agent,
          usage: {
            promptTokens: usedPromptTokens,
            completionTokens: usage?.completionTokens ?? null,
            totalTokens:
              usage?.totalTokens ??
              (usedPromptTokens !== null && usage?.completionTokens !== null ? usedPromptTokens + usage.completionTokens : null)
          },
          source: apiPromptTokens !== null ? "api" : "estimate",
          turnNumber: messageNumber,
          now: createdAt
        });
      } catch (error) {
        console.warn("context usage persistence failed", error);
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
        console.warn("memory persistence failed", error);
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
      const endedRound = participantCount > 0 ? Math.floor(nextTurn / participantCount) : 0;
      const openVoteBeforeUpdate = await loadOpenVote(userId, id);
      const mustKeepRunningForVote =
        Boolean(openVoteBeforeUpdate) ||
        Boolean(workflow?.enabled) && isBoundary && shouldAutoOpenWorkflowElectionAtBoundary(workflow, endedRound);
      const finalizationPhase = resolveCurrentWorkflowPhase({
        workflow,
        consensusReached: Boolean(consensus.reached),
        roundNumber: endedRound + 1,
        openVote: openVoteBeforeUpdate
      });
      const requiresFinalizationPhase = workflow?.phaseMachine.transitionRules.finalization.requirePhaseForCompletion ?? true;
      const canCompleteByPhase = requiresFinalizationPhase ? finalizationPhase?.kind === "finalization" : true;
      const missingDeliverables = await listMissingRequiredDeliverables({
        userId,
        debateId: id,
        workflow
      });
      const canCompleteByDeliverables = missingDeliverables.length === 0;
      const consensusReachedForDb = mustKeepRunningForVote ? false : consensus.reached;
      const nextStatusForDb =
        consensusReachedForDb && canCompleteByPhase && canCompleteByDeliverables ? "completed" : "running";
      await query(
        `update debates
            set current_turn = $2,
                token_used = $3,
                consensus_summary = $4,
                consensus_reached = $5,
                status = case
                  when status in ('paused', 'stopped') then status
                  else $6
                end,
                finished_at = case
                  when $6 = 'completed' then $7
                  else finished_at
                end,
                updated_at = $7
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
          console.warn("auto segment failed", error);
        }
      }

      if (isBoundary) {
        if (endedRound > 0) {
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
            console.warn("round summary failed", error);
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
                  ? ((closed.result as any).closed as OfficialVote)
                  : null;
              if (closedVote) {
                try {
                  await maybeGenerateVoteAnnouncementWithSeat1({
                    userId,
                    debate,
                    participantCount,
                    closed: closedVote
                  });
                } catch (error) {
                  console.warn("auto vote announce failed", error);
                }
              }
            }
          } catch (error) {
            console.warn("auto vote close failed", error);
          }

          try {
            const opened = await maybeAutoOpenVoteAtBoundaryUsingWorkflow({
              userId,
              debateId: id,
              participantCount,
              endedRound
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
            console.warn("auto vote open failed", error);
          }
        }
      }

      await sleep(1000);
    }
  } catch (error) {
    console.error(error);
    await finishDebate(id, "failed", "runtime error");
  } finally {
    activeDebates.delete(id);
    clearDebateLiveProgress(id);
  }
}
