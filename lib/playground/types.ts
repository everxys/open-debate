import { z } from "zod";

const playgroundToolNameSchema = z.enum([
  "agent_files_list",
  "agent_files_read",
  "agent_files_search",
  "debate_files_read",
  "debate_files_stat",
  "debate_files_write",
  "debate_vote_open",
  "debate_vote_cast",
  "debate_vote_close",
  "harness_read",
  "harness_write",
  "harness_vote_cast"
]);

const playgroundChecklistSuiteIdSchema = z.enum(["base", "voting"]);

const sandboxFileScopeSchema = z.enum(["agent", "debate"]);

const relativeSandboxPathSchema = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => !value.startsWith("/"), "Path must be relative")
  .refine((value) => !value.includes("\\"), "Use / as separator")
  .refine((value) => !value.includes(".."), "Path cannot contain ..")
  .refine((value) => !value.endsWith("/"), "Path must point to a file");

const playgroundHarnessActionNameSchema = z.enum([
  "list",
  "search",
  "read",
  "write_replace",
  "write_append",
  "write_section",
  "vote_cast"
]);

export const playgroundSandboxFileSchema = z.object({
  scope: sandboxFileScopeSchema.default("debate"),
  path: relativeSandboxPathSchema,
  content: z.string().max(200_000)
});

export const playgroundRunRequestSchema = z.object({
  agentId: z.string().uuid(),
  systemPrompt: z.string().max(50_000).default(""),
  userPrompt: z.string().min(1).max(50_000),
  enabledTools: z.array(playgroundToolNameSchema).max(9).default([]),
  enabledHarnessActions: z.array(playgroundHarnessActionNameSchema).max(7).default([]),
  useHarnessActions: z.boolean().default(false),
  maxToolRounds: z.number().int().min(0).max(8).default(4),
  sandboxFiles: z.array(playgroundSandboxFileSchema).max(100).default([])
});

export type PlaygroundToolName = z.infer<typeof playgroundToolNameSchema>;
export type PlaygroundChecklistSuiteId = z.infer<typeof playgroundChecklistSuiteIdSchema>;
export type PlaygroundSandboxFileScope = z.infer<typeof sandboxFileScopeSchema>;
export type PlaygroundSandboxFileInput = z.infer<typeof playgroundSandboxFileSchema>;
export type PlaygroundRunRequest = z.infer<typeof playgroundRunRequestSchema>;

export type PlaygroundToolCallTrace = {
  id: string;
  toolName: PlaygroundToolName | string;
  rawArguments: string;
  parsedArguments: unknown;
  at: string;
};

export type PlaygroundToolExecutionTrace = {
  id: string;
  toolName: PlaygroundToolName | string;
  parsedArguments: unknown;
  result: unknown;
  ok: boolean;
  at: string;
};

export type PlaygroundAssistantMessage = {
  role: "assistant";
  content: string;
  finishReason: string | null;
  toolCallCount: number;
  at: string;
};

export type PlaygroundSandboxFileSnapshot = {
  scope: PlaygroundSandboxFileScope;
  path: string;
  content: string;
  size: number;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type PlaygroundRunAssertions = {
  calledAnyTool: boolean;
  calledExpectedTool: boolean;
  createdOrUpdatedOutput: boolean;
  promisedWriteWithoutTool: boolean;
};

export type PlaygroundRunDiagnostics = {
  provider: "openai" | "anthropic";
  finishReason: string | null;
  toolCallCount: number;
  sandboxFileCountBefore: number;
  sandboxFileCountAfter: number;
  assertions: PlaygroundRunAssertions;
};

export type PlaygroundChecklistStatus = "idle" | "running" | "passed" | "failed";

export const PLAYGROUND_CHECKLIST_STAGES = [
  "queued",
  "requesting_model",
  "receiving_model_output",
  "executing_tools",
  "sandbox_changed",
  "validating_result",
  "passed",
  "failed"
] as const;

export type PlaygroundChecklistStage = (typeof PLAYGROUND_CHECKLIST_STAGES)[number];

export type PlaygroundChecklistStageEntry = {
  stage: PlaygroundChecklistStage;
  label: string;
  startedAt: string;
  completedAt: string | null;
  message: string | null;
};

export type PlaygroundChecklistProgress = {
  currentStage: PlaygroundChecklistStage | null;
  stageStartedAt: string | null;
  stageIndex: number | null;
  progressMessage: string | null;
  stageHistory: PlaygroundChecklistStageEntry[];
};

export type PlaygroundChecklistCase = {
  id: PlaygroundToolName;
  suiteId: PlaygroundChecklistSuiteId;
  suiteLabel: string;
  label: string;
  description: string;
  requiredTools: PlaygroundToolName[];
  systemPrompt: string;
  userPrompt: string;
  sandboxFiles: PlaygroundSandboxFileInput[];
  passRule: string;
};

export type PlaygroundChecklistSuiteDefinition = {
  id: PlaygroundChecklistSuiteId;
  label: string;
  description: string;
  defaultSelected: boolean;
  toolNames: PlaygroundToolName[];
};

export type PlaygroundChecklistTraceSummary = {
  toolName: PlaygroundToolName;
  caseLabel: string;
  systemPrompt: string;
  userPrompt: string;
  sandboxFiles: PlaygroundSandboxFileInput[];
  passRule: string;
  result: {
    assistantMessages: PlaygroundAssistantMessage[];
    toolCalls: PlaygroundToolCallTrace[];
    toolExecutions: PlaygroundToolExecutionTrace[];
    finalText: string;
    finishReason: string | null;
    sandboxFilesAfter: PlaygroundSandboxFileSnapshot[];
    diagnostics: PlaygroundRunDiagnostics;
    latencyMs: number;
  };
};

export type PlaygroundChecklistItem = {
  toolName: PlaygroundToolName;
  suiteId: PlaygroundChecklistSuiteId;
  suiteLabel: string;
  label: string;
  description: string;
  requiredTools: PlaygroundToolName[];
  systemPrompt: string;
  userPrompt: string;
  sandboxFiles: PlaygroundSandboxFileInput[];
  passRule: string;
  status: PlaygroundChecklistStatus;
  passed: boolean;
  lastRunAt: string | null;
  lastPassedAt: string | null;
  errorMessage: string | null;
  traceSummary: PlaygroundChecklistTraceSummary | null;
} & PlaygroundChecklistProgress;

export type PlaygroundChecklistRunResult = PlaygroundChecklistItem;

export const PLAYGROUND_TOOL_LABELS: Record<PlaygroundToolName, string> = {
  agent_files_list: "Agent Files List",
  agent_files_read: "Agent Files Read",
  agent_files_search: "Agent Files Search",
  debate_files_read: "Debate Files Read",
  debate_files_stat: "Debate Files Stat",
  debate_files_write: "Debate Files Write",
  debate_vote_open: "Debate Vote Open",
  debate_vote_cast: "Debate Vote Cast",
  debate_vote_close: "Debate Vote Close",
  harness_read: "Harness Read",
  harness_write: "Harness Write",
  harness_vote_cast: "Harness Vote Cast"
};

export const PLAYGROUND_TOOL_NAMES = playgroundToolNameSchema.options;
export const PLAYGROUND_CHECKLIST_SUITE_IDS = playgroundChecklistSuiteIdSchema.options;
export const PLAYGROUND_CHECKLIST_SUITES: PlaygroundChecklistSuiteDefinition[] = [
  {
    id: "base",
    label: "基础测试集",
    description: "默认启用，覆盖所有通用文件工具和基础能力链路。",
    defaultSelected: true,
    toolNames: [
      "agent_files_list",
      "agent_files_read",
      "agent_files_search",
      "debate_files_read",
      "debate_files_stat",
      "debate_files_write",
      "harness_read",
      "harness_write"
    ]
  },
  {
    id: "voting",
    label: "投票测试集",
    description: "可选启用，覆盖官方投票开启、投票和关闭链路。",
    defaultSelected: false,
    toolNames: ["debate_vote_open", "debate_vote_cast", "debate_vote_close", "harness_vote_cast"]
  }
];
export const PLAYGROUND_CHECKLIST_SUITE_LABELS = Object.fromEntries(
  PLAYGROUND_CHECKLIST_SUITES.map((suite) => [suite.id, suite.label])
) as Record<PlaygroundChecklistSuiteId, string>;
export const PLAYGROUND_DEFAULT_CHECKLIST_SUITE_IDS = PLAYGROUND_CHECKLIST_SUITES.filter((suite) => suite.defaultSelected).map(
  (suite) => suite.id
);
