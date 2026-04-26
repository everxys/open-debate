import { randomUUID } from "node:crypto";

import { requireSessionUser } from "@/lib/auth";
import { getAgentById } from "@/lib/agents";
import { ensureDb } from "@/lib/db";
import { AppError } from "@/lib/http";
import { createServerLogger } from "@/lib/logger/server";
import { publishPlaygroundChecklistEvent } from "@/lib/playground/live";
import { runPlaygroundSession } from "@/lib/playground/session";
import {
  PLAYGROUND_CHECKLIST_SUITE_LABELS,
  PLAYGROUND_CHECKLIST_SUITES,
  PLAYGROUND_DEFAULT_CHECKLIST_SUITE_IDS
} from "@/lib/playground/types";
import type {
  PlaygroundChecklistCase,
  PlaygroundChecklistItem,
  PlaygroundChecklistRunResult,
  PlaygroundChecklistStage,
  PlaygroundChecklistStageEntry,
  PlaygroundChecklistStatus,
  PlaygroundChecklistSuiteId,
  PlaygroundChecklistTraceSummary,
  PlaygroundRunRequest,
  PlaygroundToolExecutionTrace,
  PlaygroundToolName
} from "@/lib/playground/types";

const checklistLogger = createServerLogger("playground-checklist");
const PLAYGROUND_CHECKLIST_BATCH_CONCURRENCY = 3;

type ChecklistRow = {
  id: string;
  user_id: string;
  agent_id: string;
  tool_name: string;
  status: string;
  current_stage: string | null;
  stage_started_at: string | null;
  stage_index: number | null;
  stage_history: unknown;
  last_progress_message: string | null;
  last_run_at: string | null;
  last_passed_at: string | null;
  last_error_message: string | null;
  last_run_trace: unknown;
  created_at: string;
  updated_at: string;
};

const checklistSystemPrompt =
  "You are running a strict tool capability check. Follow the instruction exactly. Use the required tool instead of describing what you would do.";

const PLAYGROUND_CHECKLIST_STAGE_LABELS: Record<PlaygroundChecklistStage, string> = {
  queued: "已入队",
  requesting_model: "请求模型",
  receiving_model_output: "接收输出",
  executing_tools: "执行工具",
  sandbox_changed: "文件变动",
  validating_result: "校验结果",
  passed: "已通过",
  failed: "已失败"
};

const PLAYGROUND_CHECKLIST_STAGE_ORDER: PlaygroundChecklistStage[] = [
  "queued",
  "requesting_model",
  "receiving_model_output",
  "executing_tools",
  "sandbox_changed",
  "validating_result",
  "passed",
  "failed"
];

export const PLAYGROUND_CHECKLIST_CASES: PlaygroundChecklistCase[] = [
  {
    id: "agent_files_list",
    suiteId: "base",
    suiteLabel: PLAYGROUND_CHECKLIST_SUITE_LABELS.base,
    label: "Agent Files List",
    description: "验证模型会不会按前缀列出 agent 文件，并据此确认目标集合。",
    requiredTools: ["agent_files_list"],
    systemPrompt: checklistSystemPrompt,
    userPrompt:
      "Call agent_files_list with prefix sandbox/reports/ and reply with exactly two file paths: sandbox/reports/list-alpha.md and sandbox/reports/list-beta.md. Do not mention files outside that prefix.",
    sandboxFiles: [
      { scope: "agent", path: "sandbox/reports/list-alpha.md", content: "# Alpha\n\nList target A." },
      { scope: "agent", path: "sandbox/reports/list-beta.md", content: "# Beta\n\nList target B." },
      { scope: "agent", path: "sandbox/ignore.md", content: "# Ignore\n\nDo not report me." }
    ],
    passRule:
      "必须调用 agent_files_list，工具结果里要返回 sandbox/reports/list-alpha.md 和 sandbox/reports/list-beta.md，最终回答也要只列出这两个路径。"
  },
  {
    id: "agent_files_read",
    suiteId: "base",
    suiteLabel: PLAYGROUND_CHECKLIST_SUITE_LABELS.base,
    label: "Agent Files Read",
    description: "验证模型会不会先定位再读取 agent 文件，并基于内容回答。",
    requiredTools: ["agent_files_list", "agent_files_read"],
    systemPrompt: checklistSystemPrompt,
    userPrompt:
      "First confirm sandbox/briefs/ exists, then read sandbox/briefs/read-agent.md and reply with exactly: AGENT_READ_MARKER_731 | Agent brief confirmed.",
    sandboxFiles: [
      { scope: "agent", path: "sandbox/briefs/read-agent.md", content: "# Marker\n\nAGENT_READ_MARKER_731\n\nStatus: Agent brief confirmed." },
      { scope: "agent", path: "sandbox/briefs/other.md", content: "# Other\n\nIgnore this file." }
    ],
    passRule:
      "必须调用 agent_files_read，且最终回答要同时包含 AGENT_READ_MARKER_731 和 Agent brief confirmed。"
  },
  {
    id: "agent_files_search",
    suiteId: "base",
    suiteLabel: PLAYGROUND_CHECKLIST_SUITE_LABELS.base,
    label: "Agent Files Search",
    description: "验证模型会不会先搜索 agent 文件，再锁定命中文件回答。",
    requiredTools: ["agent_files_search", "agent_files_read"],
    systemPrompt: checklistSystemPrompt,
    userPrompt:
      "Search for SEARCH_MARKER_2049 in agent files, then read the matching file and reply with its path plus the exact marker.",
    sandboxFiles: [
      { scope: "agent", path: "sandbox/search-target.md", content: "# Target\n\nSEARCH_MARKER_2049 is here.\n\nPath token: sandbox/search-target.md" },
      { scope: "agent", path: "sandbox/search-other.md", content: "# Other\n\nNothing relevant." }
    ],
    passRule:
      "必须调用 agent_files_search，search 结果 snippet 要包含 SEARCH_MARKER_2049，最终回答还要包含 sandbox/search-target.md。"
  },
  {
    id: "debate_files_read",
    suiteId: "base",
    suiteLabel: PLAYGROUND_CHECKLIST_SUITE_LABELS.base,
    label: "Debate Files Read",
    description: "验证模型会不会先检查状态再读取 debate 文件。",
    requiredTools: ["debate_files_stat", "debate_files_read"],
    systemPrompt: checklistSystemPrompt,
    userPrompt:
      "Stat sandbox/read-debate.md first, then read it and reply with exactly: DEBATE_READ_MARKER_511 | Debate source verified.",
    sandboxFiles: [
      { scope: "debate", path: "sandbox/read-debate.md", content: "# Debate Marker\n\nDEBATE_READ_MARKER_511\n\nStatus: Debate source verified." }
    ],
    passRule:
      "必须调用 debate_files_read，且最终回答要同时包含 DEBATE_READ_MARKER_511 和 Debate source verified。"
  },
  {
    id: "debate_files_stat",
    suiteId: "base",
    suiteLabel: PLAYGROUND_CHECKLIST_SUITE_LABELS.base,
    label: "Debate Files Stat",
    description: "验证模型会不会读取 debate 文件状态并正确报告存在性与版本信息。",
    requiredTools: ["debate_files_stat"],
    systemPrompt: checklistSystemPrompt,
    userPrompt:
      "Call debate_files_stat on outputs/status-target.md and report whether it exists, plus its version number.",
    sandboxFiles: [
      { scope: "debate", path: "outputs/status-target.md", content: "# Existing\n\nStat me." }
    ],
    passRule:
      "必须调用 debate_files_stat，结果里要有 exists=true 和 version/size 字段，最终回答也要明确说明 exists=true。"
  },
  {
    id: "debate_files_write",
    suiteId: "base",
    suiteLabel: PLAYGROUND_CHECKLIST_SUITE_LABELS.base,
    label: "Debate Files Write",
    description: "验证模型会不会先读取来源，再真实写入 outputs/ 并留下可校验内容。",
    requiredTools: ["debate_files_read", "debate_files_write", "debate_files_stat"],
    systemPrompt: checklistSystemPrompt,
    userPrompt:
      "Read sandbox/source-outline.md, then write outputs/write-check.md with exactly two lines: TITLE: Sandbox Summary and BODY: WRITE_MARKER_391. Do not only say you will write it. After writing, verify the file exists.",
    sandboxFiles: [
      { scope: "debate", path: "sandbox/source-outline.md", content: "# Source\n\nUse title Sandbox Summary.\nUse marker WRITE_MARKER_391." }
    ],
    passRule:
      "必须调用 debate_files_write，且 sandbox after 里要真实出现 outputs/write-check.md，并同时包含 TITLE: Sandbox Summary 和 BODY: WRITE_MARKER_391。"
  },
  {
    id: "harness_read",
    suiteId: "base",
    suiteLabel: PLAYGROUND_CHECKLIST_SUITE_LABELS.base,
    label: "Harness Read",
    description: "验证模型能否输出 harness action block 并通过 read 动作闭环读取文件。",
    requiredTools: ["harness_read"],
    systemPrompt: checklistSystemPrompt,
    userPrompt:
      "Use the harness action protocol to read sandbox/read-harness.md, then reply with exactly: HARNESS_READ_MARKER_915 | Harness read verified.",
    sandboxFiles: [
      { scope: "debate", path: "sandbox/read-harness.md", content: "# Harness\n\nHARNESS_READ_MARKER_915\n\nHarness read verified." }
    ],
    passRule:
      "必须通过 harness action 发起读取，最终回答同时包含 HARNESS_READ_MARKER_915 和 Harness read verified。"
  },
  {
    id: "harness_write",
    suiteId: "base",
    suiteLabel: PLAYGROUND_CHECKLIST_SUITE_LABELS.base,
    label: "Harness Write",
    description: "验证模型能否通过 harness 写入动作真实落盘。",
    requiredTools: ["harness_write"],
    systemPrompt: checklistSystemPrompt,
    userPrompt:
      "Use the harness action protocol to write outputs/harness-write.md with exactly two lines: TITLE: Harness Summary and BODY: HARNESS_WRITE_MARKER_443. Then verify it exists and reply with exactly: HARNESS_WRITE_DONE.",
    sandboxFiles: [],
    passRule:
      "必须通过 harness write 动作真实写出 outputs/harness-write.md，且文件内容包含 TITLE: Harness Summary 和 BODY: HARNESS_WRITE_MARKER_443。"
  },
  {
    id: "debate_vote_open",
    suiteId: "voting",
    suiteLabel: PLAYGROUND_CHECKLIST_SUITE_LABELS.voting,
    label: "Debate Vote Open",
    description: "验证模型会不会开启一场自定义官方投票，并传入标题、提示词和候选项。",
    requiredTools: ["debate_vote_open"],
    systemPrompt: checklistSystemPrompt,
    userPrompt:
      "Open a custom vote with title Sandbox Vote Round, prompt Choose the strongest option, and options ['Option Alpha', 'Option Beta']. Then reply with exactly: VOTE_OPENED | Sandbox Vote Round.",
    sandboxFiles: [],
    passRule:
      "必须调用 debate_vote_open，工具结果里 vote.status 要为 open，title 要是 Sandbox Vote Round，options 里要包含 Option Alpha 和 Option Beta。"
  },
  {
    id: "debate_vote_cast",
    suiteId: "voting",
    suiteLabel: PLAYGROUND_CHECKLIST_SUITE_LABELS.voting,
    label: "Debate Vote Cast",
    description: "验证模型会不会先开票，再真实投票并带上可校验 reason。",
    requiredTools: ["debate_vote_open", "debate_vote_cast"],
    systemPrompt: checklistSystemPrompt,
    userPrompt:
      "First open a custom vote titled Sandbox Vote Round with prompt Choose the strongest option and options ['Option Alpha', 'Option Beta']. Then cast your ballot for Option Beta with reason VOTE_REASON_712. Reply with exactly: VOTE_CAST | Option Beta | VOTE_REASON_712.",
    sandboxFiles: [],
    passRule:
      "必须先调用 debate_vote_open 再调用 debate_vote_cast；cast 的 ballot.choice 必须是 Option Beta，ballot.reason 必须包含 VOTE_REASON_712。"
  },
  {
    id: "debate_vote_close",
    suiteId: "voting",
    suiteLabel: PLAYGROUND_CHECKLIST_SUITE_LABELS.voting,
    label: "Debate Vote Close",
    description: "验证模型会不会完整走完开票、投票、关票链路，并落出可核验的投票结果文件。",
    requiredTools: ["debate_vote_open", "debate_vote_cast", "debate_vote_close"],
    systemPrompt: checklistSystemPrompt,
    userPrompt:
      "Open a custom vote titled Sandbox Vote Round with prompt Choose the strongest option and options ['Option Alpha', 'Option Beta']. Cast your ballot for Option Beta with reason CLOSE_REASON_915. Then close the vote and reply with exactly: VOTE_CLOSED | Option Beta.",
    sandboxFiles: [],
    passRule:
      "必须依次调用 debate_vote_open / debate_vote_cast / debate_vote_close，close 结果必须给出 winner=Option Beta，且 sandbox after 里要出现 outputs/vote-result.md 和 outputs/vote-result.json。"
  },
  {
    id: "harness_vote_cast",
    suiteId: "voting",
    suiteLabel: PLAYGROUND_CHECKLIST_SUITE_LABELS.voting,
    label: "Harness Vote Cast",
    description: "验证模型能否在 harness 协议下完成 vote_cast。",
    requiredTools: ["harness_vote_cast"],
    systemPrompt: checklistSystemPrompt,
    userPrompt:
      "Use the harness action protocol to cast your ballot for Option Beta with reason HARNESS_VOTE_REASON_319, then reply with exactly: HARNESS_VOTE_CAST | Option Beta | HARNESS_VOTE_REASON_319.",
    sandboxFiles: [],
    passRule:
      "必须通过 harness action 发起 vote_cast，投票结果里的 ballot.choice=Option Beta，reason 包含 HARNESS_VOTE_REASON_319。"
  }
];

const checklistCaseMap = new Map(PLAYGROUND_CHECKLIST_CASES.map((item) => [item.id, item] as const));
const checklistSuiteMap = new Map(PLAYGROUND_CHECKLIST_SUITES.map((suite) => [suite.id, suite] as const));

function normalizeChecklistSuiteIds(input?: PlaygroundChecklistSuiteId[] | string[] | null) {
  const allowed = new Set(PLAYGROUND_CHECKLIST_SUITES.map((suite) => suite.id));
  const picked = Array.isArray(input)
    ? input.filter((value): value is PlaygroundChecklistSuiteId => typeof value === "string" && allowed.has(value as PlaygroundChecklistSuiteId))
    : [];
  return picked.length > 0 ? Array.from(new Set(picked)) : [...PLAYGROUND_DEFAULT_CHECKLIST_SUITE_IDS];
}

function getChecklistCasesBySuiteIds(input?: PlaygroundChecklistSuiteId[] | string[] | null) {
  const suiteIds = normalizeChecklistSuiteIds(input);
  const suiteSet = new Set(suiteIds);
  return PLAYGROUND_CHECKLIST_CASES.filter((item) => suiteSet.has(item.suiteId));
}

function getChecklistItemByToolName(toolName: PlaygroundToolName) {
  return getChecklistCase(toolName);
}

function getChecklistCase(toolName: string) {
  const item = checklistCaseMap.get(toolName as PlaygroundToolName);
  if (!item) throw new AppError("VALIDATION_ERROR", 400, `Unknown checklist tool: ${toolName}`);
  return item;
}

function buildRunRequest(agentId: string, item: PlaygroundChecklistCase): PlaygroundRunRequest {
  const harnessMap: Partial<Record<PlaygroundToolName, PlaygroundRunRequest["enabledHarnessActions"]>> = {
    harness_read: ["read"],
    harness_write: ["write_replace"],
    harness_vote_cast: ["vote_cast"]
  };
  return {
    agentId,
    systemPrompt: item.systemPrompt,
    userPrompt: item.userPrompt,
    enabledTools: item.requiredTools,
    enabledHarnessActions: harnessMap[item.id] ?? [],
    useHarnessActions: item.id.startsWith("harness_"),
    maxToolRounds: 4,
    sandboxFiles: item.sandboxFiles
  };
}

function findToolExecutions(toolExecutions: PlaygroundToolExecutionTrace[], toolName: PlaygroundToolName) {
  return toolExecutions.filter((item) => item.toolName === toolName);
}

function parseStageHistory(raw: unknown): PlaygroundChecklistStageEntry[] {
  const normalizedRaw =
    typeof raw === "string"
      ? (() => {
          try {
            return JSON.parse(raw) as unknown;
          } catch {
            return [];
          }
        })()
      : raw;
  if (!Array.isArray(normalizedRaw)) return [];
  return normalizedRaw.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const value = entry as Record<string, unknown>;
    const stage = typeof value.stage === "string" ? value.stage : "";
    if (!PLAYGROUND_CHECKLIST_STAGE_ORDER.includes(stage as PlaygroundChecklistStage)) return [];
    const startedAt = typeof value.startedAt === "string" ? value.startedAt : "";
    if (!startedAt) return [];
    return [
      {
        stage: stage as PlaygroundChecklistStage,
        label:
          typeof value.label === "string" && value.label.trim()
            ? value.label
            : PLAYGROUND_CHECKLIST_STAGE_LABELS[stage as PlaygroundChecklistStage],
        startedAt,
        completedAt: typeof value.completedAt === "string" ? value.completedAt : null,
        message: typeof value.message === "string" ? value.message : null
      }
    ];
  });
}

function parseTraceSummary(raw: unknown): PlaygroundChecklistTraceSummary | null {
  if (!raw) return null;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as PlaygroundChecklistTraceSummary;
    } catch {
      return null;
    }
  }
  return raw as PlaygroundChecklistTraceSummary;
}

function serializeJsonColumn(value: unknown) {
  return JSON.stringify(value ?? null);
}

function getStageIndex(stage: PlaygroundChecklistStage | null) {
  if (!stage) return null;
  const index = PLAYGROUND_CHECKLIST_STAGE_ORDER.indexOf(stage);
  return index >= 0 ? index : null;
}

function buildStageHistory(
  history: PlaygroundChecklistStageEntry[],
  stage: PlaygroundChecklistStage,
  at: string,
  message: string | null
) {
  if (stage === "queued") {
    return [
      {
        stage,
        label: PLAYGROUND_CHECKLIST_STAGE_LABELS[stage],
        startedAt: at,
        completedAt: null,
        message
      }
    ];
  }

  if (history.length === 0) {
    return [
      {
        stage,
        label: PLAYGROUND_CHECKLIST_STAGE_LABELS[stage],
        startedAt: at,
        completedAt: null,
        message
      }
    ];
  }

  const next = [...history];
  const last = next[next.length - 1];
  if (last.stage === stage) {
    next[next.length - 1] = {
      ...last,
      message: message ?? last.message
    };
    return next;
  }

  if (!last.completedAt) {
    next[next.length - 1] = {
      ...last,
      completedAt: at
    };
  }

  next.push({
    stage,
    label: PLAYGROUND_CHECKLIST_STAGE_LABELS[stage],
    startedAt: at,
    completedAt: null,
    message
  });
  return next;
}

function buildErrorMessage(error: unknown) {
  if (error instanceof AppError) {
    if (error.code === "QUOTA_THROTTLED") {
      const details =
        error.details && typeof error.details === "object" ? (error.details as Record<string, unknown>) : null;
      const nextAvailableAt =
        details && typeof details.nextAvailableAt === "string" ? details.nextAvailableAt : null;
      return nextAvailableAt ? `${error.message}。下次可用时间：${nextAvailableAt}` : error.message;
    }
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

function buildTraceSummary(
  item: PlaygroundChecklistCase,
  result: Awaited<ReturnType<typeof runPlaygroundSession>>
): PlaygroundChecklistTraceSummary {
  return {
    toolName: item.id,
    caseLabel: item.label,
    systemPrompt: item.systemPrompt,
    userPrompt: item.userPrompt,
    sandboxFiles: item.sandboxFiles,
    passRule: item.passRule,
    result: {
      assistantMessages: result.assistantMessages,
      toolCalls: result.toolCalls,
      toolExecutions: result.toolExecutions,
      finalText: result.finalText,
      finishReason: result.finishReason,
      sandboxFilesAfter: result.sandboxFilesAfter,
      diagnostics: result.diagnostics,
      latencyMs: result.latencyMs
    }
  };
}

function defaultChecklistItem(item: PlaygroundChecklistCase): PlaygroundChecklistItem {
  return {
    toolName: item.id,
    suiteId: item.suiteId,
    suiteLabel: item.suiteLabel,
    label: item.label,
    description: item.description,
    requiredTools: item.requiredTools,
    systemPrompt: item.systemPrompt,
    userPrompt: item.userPrompt,
    sandboxFiles: item.sandboxFiles,
    passRule: item.passRule,
    status: "idle",
    passed: false,
    currentStage: null,
    stageStartedAt: null,
    stageIndex: null,
    progressMessage: null,
    stageHistory: [],
    lastRunAt: null,
    lastPassedAt: null,
    errorMessage: null,
    traceSummary: null
  };
}

function rowToChecklistItem(row: ChecklistRow, item: PlaygroundChecklistCase): PlaygroundChecklistItem {
  const currentStage =
    row.current_stage && PLAYGROUND_CHECKLIST_STAGE_ORDER.includes(row.current_stage as PlaygroundChecklistStage)
      ? (row.current_stage as PlaygroundChecklistStage)
      : null;
  return {
    toolName: item.id,
    suiteId: item.suiteId,
    suiteLabel: item.suiteLabel,
    label: item.label,
    description: item.description,
    requiredTools: item.requiredTools,
    systemPrompt: item.systemPrompt,
    userPrompt: item.userPrompt,
    sandboxFiles: item.sandboxFiles,
    passRule: item.passRule,
    status: row.status as PlaygroundChecklistStatus,
    passed: row.status === "passed",
    currentStage,
    stageStartedAt: row.stage_started_at,
    stageIndex: typeof row.stage_index === "number" ? row.stage_index : getStageIndex(currentStage),
    progressMessage: row.last_progress_message,
    stageHistory: parseStageHistory(row.stage_history),
    lastRunAt: row.last_run_at,
    lastPassedAt: row.last_passed_at,
    errorMessage: row.last_error_message,
    traceSummary: parseTraceSummary(row.last_run_trace)
  };
}

async function loadChecklistRows(userId: string, agentId: string) {
  const db = await ensureDb();
  return db
    .selectFrom("playground_tool_checklists")
    .selectAll()
    .where("user_id", "=", userId)
    .where("agent_id", "=", agentId)
    .execute() as Promise<ChecklistRow[]>;
}

async function ensurePlaygroundAgentAccess(userId: string, agentId: string) {
  const db = await ensureDb();
  const row = await db
    .selectFrom("ai_agents")
    .select(["id"])
    .where("id", "=", agentId)
    .where("user_id", "=", userId)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  if (!row) {
    throw new AppError("NOT_FOUND", 404, "AI agent not found");
  }
  return row.id;
}

async function upsertChecklistRow(input: {
  userId: string;
  agentId: string;
  toolName: PlaygroundToolName;
  status: PlaygroundChecklistStatus;
  currentStage?: PlaygroundChecklistStage | null;
  stageStartedAt?: string | null;
  stageIndex?: number | null;
  stageHistory?: PlaygroundChecklistStageEntry[];
  progressMessage?: string | null;
  lastRunAt?: string | null;
  lastPassedAt?: string | null;
  errorMessage?: string | null;
  traceSummary?: PlaygroundChecklistTraceSummary | null;
}) {
  const db = await ensureDb();
  const now = new Date().toISOString();
  const row = await db
    .insertInto("playground_tool_checklists")
    .values({
      id: randomUUID(),
      user_id: input.userId,
      agent_id: input.agentId,
      tool_name: input.toolName,
      status: input.status,
      current_stage: input.currentStage ?? null,
      stage_started_at: input.stageStartedAt ?? null,
      stage_index: input.stageIndex ?? null,
      stage_history: serializeJsonColumn(input.stageHistory ?? []),
      last_progress_message: input.progressMessage ?? null,
      last_run_at: input.lastRunAt ?? null,
      last_passed_at: input.lastPassedAt ?? null,
      last_error_message: input.errorMessage ?? null,
      last_run_trace: serializeJsonColumn(input.traceSummary),
      created_at: now,
      updated_at: now
    })
    .onConflict((oc) =>
      oc.columns(["user_id", "agent_id", "tool_name"]).doUpdateSet({
        status: input.status,
        current_stage: input.currentStage ?? null,
        stage_started_at: input.stageStartedAt ?? null,
        stage_index: input.stageIndex ?? null,
        stage_history: serializeJsonColumn(input.stageHistory ?? []),
        last_progress_message: input.progressMessage ?? null,
        last_run_at: input.lastRunAt ?? null,
        last_passed_at: input.lastPassedAt ?? null,
        last_error_message: input.errorMessage ?? null,
        last_run_trace: serializeJsonColumn(input.traceSummary),
        updated_at: now
      })
    )
    .returningAll()
    .executeTakeFirstOrThrow();
  return row as ChecklistRow;
}

async function hydrateChecklistItem(userId: string, agentId: string, toolName: PlaygroundToolName) {
  const rows = await loadChecklistRows(userId, agentId);
  const row = rows.find((item) => item.tool_name === toolName) ?? null;
  const item = getChecklistCase(toolName);
  return row ? rowToChecklistItem(row, item) : defaultChecklistItem(item);
}

async function publishChecklistItem(userId: string, agentId: string, toolName: PlaygroundToolName, type: "checklist_progress" | "checklist_finished") {
  const item = await hydrateChecklistItem(userId, agentId, toolName);
  publishPlaygroundChecklistEvent(userId, agentId, { type, item });
  return item;
}

async function publishChecklistSnapshot(userId: string, agentId: string) {
  const items = await listPlaygroundChecklistForUser(userId, agentId);
  publishPlaygroundChecklistEvent(userId, agentId, { type: "snapshot", items });
}

async function updatePlaygroundChecklistStage(input: {
  userId: string;
  agentId: string;
  toolName: PlaygroundToolName;
  stage: PlaygroundChecklistStage;
  progressMessage: string | null;
  lastRunAt: string;
  lastPassedAt: string | null;
  traceSummary: PlaygroundChecklistTraceSummary | null;
  errorMessage: string | null;
}) {
  const current = await hydrateChecklistItem(input.userId, input.agentId, input.toolName);
  const at = new Date().toISOString();
  const stageHistory = buildStageHistory(current.stageHistory, input.stage, at, input.progressMessage);
  await upsertChecklistRow({
    userId: input.userId,
    agentId: input.agentId,
    toolName: input.toolName,
    status:
      input.stage === "passed"
        ? "passed"
        : input.stage === "failed"
          ? "failed"
          : "running",
    currentStage: input.stage,
    stageStartedAt: at,
    stageIndex: getStageIndex(input.stage),
    stageHistory,
    progressMessage: input.progressMessage,
    lastRunAt: input.lastRunAt,
    lastPassedAt: input.lastPassedAt,
    errorMessage: input.errorMessage,
    traceSummary: input.traceSummary
  });
  return publishChecklistItem(
    input.userId,
    input.agentId,
    input.toolName,
    input.stage === "passed" || input.stage === "failed" ? "checklist_finished" : "checklist_progress"
  );
}

async function finishPlaygroundChecklistFailure(input: {
  userId: string;
  agentId: string;
  toolName: PlaygroundToolName;
  message: string;
  lastRunAt: string;
  lastPassedAt: string | null;
  traceSummary: PlaygroundChecklistTraceSummary | null;
}) {
  const current = await hydrateChecklistItem(input.userId, input.agentId, input.toolName);
  const at = new Date().toISOString();
  const stageHistory = buildStageHistory(current.stageHistory, "failed", at, input.message);
  const currentStage = current.currentStage ?? "failed";
  await upsertChecklistRow({
    userId: input.userId,
    agentId: input.agentId,
    toolName: input.toolName,
    status: "failed",
    currentStage,
    stageStartedAt: current.stageStartedAt ?? at,
    stageIndex: current.stageIndex ?? getStageIndex(currentStage),
    stageHistory,
    progressMessage: input.message,
    lastRunAt: input.lastRunAt,
    lastPassedAt: input.lastPassedAt,
    errorMessage: input.message,
    traceSummary: input.traceSummary
  });
  return publishChecklistItem(input.userId, input.agentId, input.toolName, "checklist_finished");
}

function evaluateChecklistCase(input: {
  item: PlaygroundChecklistCase;
  finalText: string;
  toolExecutions: PlaygroundToolExecutionTrace[];
  sandboxFilesAfter: Array<{ scope: "agent" | "debate"; path: string; content: string; size?: number; version?: number; createdAt?: string; updatedAt?: string }>;
}) {
  const executions = findToolExecutions(input.toolExecutions, input.item.id);
  if (executions.length === 0) {
    return { passed: false, errorMessage: `未检测到 ${input.item.id} 调用` };
  }
  const finalTextLower = input.finalText.toLowerCase();

  if (input.item.id === "agent_files_list") {
    const passed = executions.some((execution) => {
      if (!Array.isArray(execution.result)) return false;
      return (
        execution.result.some((value) => value === "sandbox/reports/list-alpha.md") &&
        execution.result.some((value) => value === "sandbox/reports/list-beta.md")
      );
    });
    if (!passed) {
      return { passed: false, errorMessage: "列表结果没有返回预期 prefix 下的两个目标文件" };
    }
    return input.finalText.includes("sandbox/reports/list-alpha.md") && input.finalText.includes("sandbox/reports/list-beta.md")
      ? { passed: true, errorMessage: null }
      : { passed: false, errorMessage: "最终回答没有准确列出两个目标路径" };
  }

  if (input.item.id === "agent_files_read") {
    const passed =
      input.finalText.includes("AGENT_READ_MARKER_731") &&
      input.finalText.includes("Agent brief confirmed");
    return passed
      ? { passed: true, errorMessage: null }
      : { passed: false, errorMessage: "最终回答没有同时包含 agent 读取标记和确认语" };
  }

  if (input.item.id === "agent_files_search") {
    const passed = executions.some((execution) => {
      if (!Array.isArray(execution.result)) return false;
      return execution.result.some((value) => {
        if (!value || typeof value !== "object") return false;
        return String((value as { snippet?: unknown }).snippet ?? "").includes("SEARCH_MARKER_2049");
      });
    });
    if (!passed) {
      return { passed: false, errorMessage: "search 结果没有命中预期 snippet" };
    }
    return input.finalText.includes("sandbox/search-target.md")
      ? { passed: true, errorMessage: null }
      : { passed: false, errorMessage: "最终回答没有包含命中的目标路径" };
  }

  if (input.item.id === "debate_files_read") {
    const passed =
      input.finalText.includes("DEBATE_READ_MARKER_511") &&
      input.finalText.includes("Debate source verified");
    return passed
      ? { passed: true, errorMessage: null }
      : { passed: false, errorMessage: "最终回答没有同时包含 debate 读取标记和确认语" };
  }

  if (input.item.id === "debate_files_stat") {
    const passed = executions.some((execution) => {
      const result = execution.result as {
        ok?: unknown;
        exists?: unknown;
        version?: unknown;
        size?: unknown;
      } | null;
      return Boolean(
        result &&
        result.ok === true &&
        result.exists === true &&
        typeof result.version === "number" &&
        typeof result.size === "number"
      );
    });
    if (!passed) {
      return { passed: false, errorMessage: "stat 结果缺少 exists/version/size" };
    }
    return finalTextLower.includes("exists")
      ? { passed: true, errorMessage: null }
      : { passed: false, errorMessage: "最终回答没有明确说明 exists 状态" };
  }

  if (input.item.id === "debate_files_write") {
    const file = input.sandboxFilesAfter.find((entry) => entry.scope === "debate" && entry.path === "outputs/write-check.md");
    const passed = Boolean(
      file &&
      file.content.includes("TITLE: Sandbox Summary") &&
      file.content.includes("BODY: WRITE_MARKER_391")
    );
    return passed
      ? { passed: true, errorMessage: null }
      : { passed: false, errorMessage: "目标输出文件没有真实写入 sandbox，或内容不符合要求" };
  }

  if (input.item.id === "harness_read") {
    const passed =
      input.finalText.includes("HARNESS_READ_MARKER_915") &&
      input.finalText.includes("Harness read verified");
    return passed
      ? { passed: true, errorMessage: null }
      : { passed: false, errorMessage: "最终回答没有包含 harness 读取后的确认内容" };
  }

  if (input.item.id === "harness_write") {
    const file = input.sandboxFilesAfter.find((entry) => entry.scope === "debate" && entry.path === "outputs/harness-write.md");
    const passed = Boolean(
      file &&
      file.content.includes("TITLE: Harness Summary") &&
      file.content.includes("BODY: HARNESS_WRITE_MARKER_443")
    );
    return passed
      ? { passed: true, errorMessage: null }
      : { passed: false, errorMessage: "harness 写入没有真实落到 sandbox 文件里" };
  }

  if (input.item.id === "debate_vote_open") {
    const passed = executions.some((execution) => {
      const result = execution.result as { ok?: unknown; vote?: { status?: unknown; title?: unknown; options?: unknown } } | null;
      return Boolean(
        result &&
        result.ok === true &&
        result.vote?.status === "open" &&
        result.vote?.title === "Sandbox Vote Round" &&
        Array.isArray(result.vote?.options) &&
        result.vote.options.includes("Option Alpha") &&
        result.vote.options.includes("Option Beta")
      );
    });
    if (!passed) {
      return { passed: false, errorMessage: "open vote 结果没有返回预期 title/status/options" };
    }
    return input.finalText.includes("VOTE_OPENED | Sandbox Vote Round")
      ? { passed: true, errorMessage: null }
      : { passed: false, errorMessage: "最终回答没有回报已开启的投票标题" };
  }

  if (input.item.id === "debate_vote_cast") {
    const openIndex = input.toolExecutions.findIndex((execution) => execution.toolName === "debate_vote_open");
    const castExecution = executions.find((execution) => {
      const result = execution.result as { ok?: unknown; ballot?: { choice?: unknown; reason?: unknown } } | null;
      return Boolean(
        result &&
        result.ok === true &&
        result.ballot?.choice === "Option Beta" &&
        String(result.ballot?.reason ?? "").includes("VOTE_REASON_712")
      );
    });
    if (openIndex < 0 || !castExecution) {
      return { passed: false, errorMessage: "投票链路没有正确完成开票或投票，或 ballot 内容不符合要求" };
    }
    const castIndex = input.toolExecutions.findIndex((execution) => execution.id === castExecution.id);
    if (castIndex <= openIndex) {
      return { passed: false, errorMessage: "debate_vote_cast 没有发生在 debate_vote_open 之后" };
    }
    return input.finalText.includes("VOTE_CAST | Option Beta | VOTE_REASON_712")
      ? { passed: true, errorMessage: null }
      : { passed: false, errorMessage: "最终回答没有回报预期的投票 choice/reason" };
  }

  if (input.item.id === "debate_vote_close") {
    const closeExecution = executions.find((execution) => {
      const result = execution.result as { ok?: unknown; closed?: { result?: { winner?: unknown } } } | null;
      return Boolean(result && result.ok === true && result.closed?.result?.winner === "Option Beta");
    });
    if (!closeExecution) {
      return { passed: false, errorMessage: "关票结果没有返回预期 winner=Option Beta" };
    }
    const requiredPaths = new Set(["outputs/vote-result.md", "outputs/vote-result.json"]);
    const existingPaths = new Set(
      input.sandboxFilesAfter.filter((entry) => entry.scope === "debate").map((entry) => entry.path)
    );
    const persisted = [...requiredPaths].every((path) => existingPaths.has(path));
    if (!persisted) {
      return { passed: false, errorMessage: "关票后没有落出预期的投票结果文件" };
    }
    return input.finalText.includes("VOTE_CLOSED | Option Beta")
      ? { passed: true, errorMessage: null }
      : { passed: false, errorMessage: "最终回答没有回报关闭后的获胜选项" };
  }

  if (input.item.id === "harness_vote_cast") {
    const execution = executions.find((entry) => {
      const result = entry.result as { ok?: unknown; ballot?: { choice?: unknown; reason?: unknown } } | null;
      return Boolean(
        result &&
        result.ok === true &&
        result.ballot?.choice === "Option Beta" &&
        String(result.ballot?.reason ?? "").includes("HARNESS_VOTE_REASON_319")
      );
    });
    if (!execution) {
      return { passed: false, errorMessage: "harness vote_cast 没有落出预期 ballot" };
    }
    return input.finalText.includes("HARNESS_VOTE_CAST | Option Beta | HARNESS_VOTE_REASON_319")
      ? { passed: true, errorMessage: null }
      : { passed: false, errorMessage: "最终回答没有回报预期的 harness 投票结果" };
  }

  return { passed: false, errorMessage: "Unknown checklist rule" };
}

export async function listPlaygroundChecklistForUser(userId: string, agentId: string) {
  await ensurePlaygroundAgentAccess(userId, agentId);
  const rows = await loadChecklistRows(userId, agentId);
  return PLAYGROUND_CHECKLIST_CASES.map((item) => {
    const row = rows.find((entry) => entry.tool_name === item.id);
    return row ? rowToChecklistItem(row, item) : defaultChecklistItem(item);
  });
}

export async function listPlaygroundChecklist(agentId: string) {
  const session = await requireSessionUser();
  return listPlaygroundChecklistForUser(session.userId, agentId);
}

export async function clearPlaygroundChecklist(agentId: string) {
  const session = await requireSessionUser();
  const ownedAgentId = await ensurePlaygroundAgentAccess(session.userId, agentId);
  const db = await ensureDb();
  await db
    .deleteFrom("playground_tool_checklists")
    .where("user_id", "=", session.userId)
    .where("agent_id", "=", ownedAgentId)
    .execute();
  await publishChecklistSnapshot(session.userId, ownedAgentId);
}

export async function runPlaygroundChecklistCase(agentId: string, toolName: PlaygroundToolName): Promise<PlaygroundChecklistRunResult> {
  const session = await requireSessionUser();
  const ownedAgentId = await ensurePlaygroundAgentAccess(session.userId, agentId);
  const agent = await getAgentById(ownedAgentId);
  const item = getChecklistCase(toolName);
  const startedAt = new Date().toISOString();
  const existing = await hydrateChecklistItem(session.userId, agent.id, toolName);

  await updatePlaygroundChecklistStage({
    userId: session.userId,
    agentId: agent.id,
    toolName,
    stage: "queued",
    progressMessage: "测试已开始，准备发起模型请求",
    lastRunAt: startedAt,
    lastPassedAt: existing.lastPassedAt,
    traceSummary: existing.traceSummary,
    errorMessage: null
  });

  try {
    const result = await runPlaygroundSession(buildRunRequest(agent.id, item), {
      requestKind: "playground_checklist",
      onStageChange: async (stage, progressMessage) => {
        await updatePlaygroundChecklistStage({
          userId: session.userId,
          agentId: agent.id,
          toolName,
          stage,
          progressMessage,
          lastRunAt: startedAt,
          lastPassedAt: existing.lastPassedAt,
          traceSummary: existing.traceSummary,
          errorMessage: null
        });
      }
    });

    await updatePlaygroundChecklistStage({
      userId: session.userId,
      agentId: agent.id,
      toolName,
      stage: "validating_result",
      progressMessage: "模型与工具执行已完成，开始校验结果",
      lastRunAt: startedAt,
      lastPassedAt: existing.lastPassedAt,
      traceSummary: existing.traceSummary,
      errorMessage: null
    });

    const evaluation = evaluateChecklistCase({
      item,
      finalText: result.finalText,
      toolExecutions: result.toolExecutions,
      sandboxFilesAfter: result.sandboxFilesAfter
    });
    const traceSummary = buildTraceSummary(item, result);

    if (evaluation.passed) {
      await updatePlaygroundChecklistStage({
        userId: session.userId,
        agentId: agent.id,
        toolName,
        stage: "passed",
        progressMessage: "校验通过，工具能力可用",
        lastRunAt: startedAt,
        lastPassedAt: startedAt,
        traceSummary,
        errorMessage: null
      });
    } else {
      await finishPlaygroundChecklistFailure({
        userId: session.userId,
        agentId: agent.id,
        toolName,
        message: evaluation.errorMessage ?? "校验失败",
        lastRunAt: startedAt,
        lastPassedAt: existing.lastPassedAt,
        traceSummary
      });
    }

    checklistLogger.info("playground.checklist.run", {
      agentId: agent.id,
      agentName: agent.name,
      toolName,
      status: evaluation.passed ? "passed" : "failed"
    });
  } catch (error) {
    const message = buildErrorMessage(error);
    await finishPlaygroundChecklistFailure({
      userId: session.userId,
      agentId: agent.id,
      toolName,
      message,
      lastRunAt: startedAt,
      lastPassedAt: existing.lastPassedAt,
      traceSummary: existing.traceSummary
    });
    checklistLogger.warn("playground.checklist.run_failed", {
      agentId: agent.id,
      agentName: agent.name,
      toolName,
      error
    });
  }

  return hydrateChecklistItem(session.userId, agent.id, toolName);
}

export async function runAllPlaygroundChecklistCases(agentId: string, suiteIds?: PlaygroundChecklistSuiteId[] | string[]) {
  const cases = getChecklistCasesBySuiteIds(suiteIds);
  const results = new Map<PlaygroundToolName, PlaygroundChecklistRunResult>();
  for (let index = 0; index < cases.length; index += PLAYGROUND_CHECKLIST_BATCH_CONCURRENCY) {
    const batch = cases.slice(index, index + PLAYGROUND_CHECKLIST_BATCH_CONCURRENCY);
    const batchResults = await Promise.all(batch.map((item) => runPlaygroundChecklistCase(agentId, item.id)));
    for (const result of batchResults) {
      results.set(result.toolName, result);
    }
  }
  return cases.map((item) => results.get(item.id)).filter((item): item is PlaygroundChecklistRunResult => Boolean(item));
}

export {
  evaluateChecklistCase,
  getStageIndex,
  getChecklistCasesBySuiteIds,
  normalizeChecklistSuiteIds,
  PLAYGROUND_CHECKLIST_STAGE_LABELS,
  PLAYGROUND_DEFAULT_CHECKLIST_SUITE_IDS,
  checklistSuiteMap as PLAYGROUND_CHECKLIST_SUITE_MAP,
  getChecklistItemByToolName
};
