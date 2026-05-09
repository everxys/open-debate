import { sql } from "kysely";

import { decryptSecret } from "@/lib/crypto";
import { ensureDb } from "@/lib/db";
import { AppError } from "@/lib/http";
import { ensureQuotaReservationOrDelay, type QuotaReservationInput } from "@/lib/quota-control";
import {
  ENABLE_DEBATE_MEMORY,
  ROUND_SUMMARY_DIR,
  SHARED_FACTS_PATH,
  SHARED_PROCESS_STATE_PATH,
  TURN_SUMMARY_DIR
} from "@/lib/runtime/constants";
import { readDebateFile, upsertDebateFile } from "@/lib/runtime/file-store";
import { openAiChatOnce, resolveChatUrl } from "@/lib/runtime/provider-openai";
import {
  buildBaseSystemPrompt,
  describeRuntimeError,
  logRuntimeEvent
} from "@/lib/runtime/provider-shared";
import { normalizeAgentRow } from "@/lib/runtime/runtime-parsing";
import {
  isNonRetryableSummaryJobError,
  isRecoverableRuntimeInterruption
} from "@/lib/runtime/runtime-state";
import { updateSummaryJob } from "@/lib/runtime/summary-orchestration";
import { sleep, trimToChars, truncateErrorMessage } from "@/lib/runtime/runtime-utils";
import {
  listClosedOfficialVoteRounds,
  mapActualRoundToSpeechRoundIndex,
  resolveRequestedMaxTokens
} from "@/lib/runtime/workflow-phase";
import type { NormalizedDebateWorkflow } from "@/lib/workflow";

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
  const system = [
    buildBaseSystemPrompt(summarizerRuntime.agent, null),
    input.systemTask,
    "Output only Markdown for humans; no tool calls."
  ]
    .join("\n\n")
    .trim();

  const quotaRequest: QuotaReservationInput = {
    userId: input.userId,
    usageControlMode: summarizerRuntime.agent.usageControlMode,
    quotaProfileId: summarizerRuntime.agent.quotaProfileId,
    requestKind: "summary_generation",
    agentId: summarizerRuntime.agent.id,
    agentName: summarizerRuntime.agent.name,
    debateId: input.debateId,
    debateAgentId: null
  };

  async function executeOnce() {
    if (summarizerRuntime.agent.provider === "openai") {
      const response = await openAiChatOnce({
        url,
        apiKey,
        quotaRequest,
        body: {
          model: summarizerRuntime.agent.model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: input.userPrompt }
          ],
          ...(input.maxTokens
            ? { max_tokens: resolveRequestedMaxTokens(input.maxTokens, summarizerRuntime.agent.provider) }
            : {})
        }
      });
      return String(response.content ?? "").trim() || null;
    }

    await ensureQuotaReservationOrDelay(quotaRequest);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: summarizerRuntime.agent.model,
        max_tokens: resolveRequestedMaxTokens(input.maxTokens ?? 1000, summarizerRuntime.agent.provider),
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
      if (isNonRetryableSummaryJobError(details)) {
        throw error;
      }
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
  reason: "summarizer:turn_summary" | "summarizer:round_summary" | "summarizer:facts_board" | "summarizer:process_state";
  now: string;
}) {
  const beforeContent = await readDebateFile(input.userId, input.debateId, input.path);
  await upsertDebateFile(input.debateId, input.path, input.content, input.now);
  const { recordDebateFileActivity } = await import("@/lib/runtime-main");
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
    "\nKeep only content useful for the next participant's thinking.",
    "Do not include process status such as write success, version numbers, ok:true, pending authorization, tool calls, or file operation receipts.",
    "Merge duplicates, remove stale points that were clearly superseded, and keep each bullet concise."
  ].join("").trim();
}

function isProcessStatusLine(line: string) {
  return /HARNESS_ACTION_RESULT|ok\s*:\s*true|写入确认|成功落库|已落库|文件已更新|工具调用|待Host授权|待授权|落库状态|版本号|\bv\d+\b|version/i.test(line);
}

export function removeProcessStatusLines(content: string) {
  const lines = content.split(/\r?\n/);
  const filtered = lines.filter((line) => !isProcessStatusLine(line));
  return filtered.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function extractProcessStatusLines(content: string) {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter(isProcessStatusLine);
  return Array.from(new Set(lines)).slice(0, 20);
}

function buildProcessStateContent(input: {
  now: string;
  sourceLabel: string;
  turnNumber?: number | null;
  roundNumber?: number | null;
  lines: string[];
}) {
  const lines: string[] = [
    "# Process State",
    "",
    `- Updated at: ${input.now}`,
    `- Source: ${input.sourceLabel}`
  ];
  if (input.roundNumber) lines.push(`- Round: ${input.roundNumber}`);
  if (input.turnNumber) lines.push(`- Turn: ${input.turnNumber}`);
  lines.push("", "## Recent Process Notes");
  if (input.lines.length <= 0) {
    lines.push("- No process-only notes were extracted from the latest summary.");
  } else {
    for (const line of input.lines) {
      lines.push(`- ${line.replace(/^[-*]\s*/, "")}`);
    }
  }
  return `${lines.join("\n")}\n`;
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

async function resolveActualRoundTurnRange(input: {
  userId: string;
  debateId: string;
  roundNumber: number;
  participantCount: number;
}) {
  const safeParticipantCount = Math.max(1, input.participantCount);
  const closedVoteRounds = await listClosedOfficialVoteRounds(input.userId, input.debateId);
  const speechRoundIndex = mapActualRoundToSpeechRoundIndex(input.roundNumber, closedVoteRounds);
  if (!speechRoundIndex) return null;
  return {
    speechRoundIndex,
    startTurn: (speechRoundIndex - 1) * safeParticipantCount + 1,
    endTurn: speechRoundIndex * safeParticipantCount
  };
}

async function listRoundTurnSummaries(input: {
  userId: string;
  debateId: string;
  workflow: NormalizedDebateWorkflow | null;
  roundNumber: number;
  participantCount: number;
}) {
  const roundTurnRange = await resolveActualRoundTurnRange({
    userId: input.userId,
    debateId: input.debateId,
    roundNumber: input.roundNumber,
    participantCount: input.participantCount
  });
  if (!roundTurnRange) return [];
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
    .where("t.turn_number", ">=", roundTurnRange.startTurn)
    .where("t.turn_number", "<=", roundTurnRange.endTurn)
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
    const rawNextContent = content?.trim() ?? "";
    const processLines = extractProcessStatusLines(`${rawNextContent}\n${input.sourceSummary}`);
    const nextContent = removeProcessStatusLines(rawNextContent);
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
    await writeSummarizerDebateFile({
      userId: input.userId,
      debateId: input.debateId,
      debateAgentId: input.debateAgentId,
      turnNumber: input.turnNumber ?? 0,
      roundNumber: input.roundNumber ?? 0,
      path: SHARED_PROCESS_STATE_PATH,
      content: buildProcessStateContent({
        now: input.now,
        sourceLabel: input.sourceLabel,
        turnNumber: input.turnNumber ?? null,
        roundNumber: input.roundNumber ?? null,
        lines: processLines
      }),
      reason: "summarizer:process_state",
      now: input.now
    });
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
    const lastTurnNumber = turnSummaries.reduce((max, item) => Math.max(max, item.turnNumber), 0);
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
      turnNumber: lastTurnNumber,
      roundNumber: input.endedRound,
      path: roundPath,
      content: `${nextContent}\n`,
      reason: "summarizer:round_summary",
      now: input.now
    });
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
