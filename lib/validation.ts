import { z } from "zod";
import { getProviderMaxOutputTokensLimit } from "@/lib/token-limits";

// === Agent schemas ===

const usageControlModeSchema = z.enum(["none", "coding_plan"]);
const quotaPacingModeSchema = z.enum(["percent", "absolute"]);
const quotaWindowTypeSchema = z.enum(["rolling_5h", "week", "month"]);

function isValidTimeZone(value: string) {
  try {
    Intl.DateTimeFormat("zh-CN", { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

const quotaProfileSnapshotBaseSchema = z.object({
  name: z.string().min(1).max(80),
  requestLimit5h: z.number().int().min(1).max(10_000_000),
  requestLimitWeek: z.number().int().min(1).max(10_000_000),
  requestLimitMonth: z.number().int().min(1).max(10_000_000),
  pacingMode: quotaPacingModeSchema,
  pacingValue: z.number().int().min(1).max(10_000_000),
  resetTimezone: z.string().min(1).max(100).refine(isValidTimeZone, "Invalid time zone")
});

const quotaBindingSchema = z.object({
  usageControlMode: usageControlModeSchema.optional().default("none"),
  quotaProfileId: z.string().uuid().nullable().optional()
});

function withQuotaBindingValidation<T extends z.ZodTypeAny>(schema: T) {
  return schema.superRefine((data, ctx) => {
    if (!data || typeof data !== "object") return;
    const usageControlMode = (data as { usageControlMode?: unknown }).usageControlMode;
    const quotaProfileId = (data as { quotaProfileId?: unknown }).quotaProfileId;
    if (usageControlMode === "coding_plan" && !quotaProfileId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["quotaProfileId"],
        message: "选择 Coding Plan 时必须绑定计划池"
      });
    }
    if (usageControlMode !== undefined && usageControlMode !== "coding_plan" && quotaProfileId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["quotaProfileId"],
        message: "未启用 Coding Plan 时不能绑定计划池"
      });
    }
  });
}

function withQuotaProfileValidation<T extends z.ZodTypeAny>(schema: T) {
  return schema.superRefine((data, ctx) => {
    if (!data || typeof data !== "object") return;
    const pacingMode = (data as { pacingMode?: unknown }).pacingMode;
    const pacingValue = (data as { pacingValue?: unknown }).pacingValue;
    const requestLimit5h = (data as { requestLimit5h?: unknown }).requestLimit5h;
    if (pacingMode === "percent" && typeof pacingValue === "number" && pacingValue > 100) {
      ctx.addIssue({
        code: z.ZodIssueCode.too_big,
        path: ["pacingValue"],
        maximum: 100,
        inclusive: true,
        type: "number",
        message: "百分比模式不能超过 100"
      });
    }
    if (
      pacingMode === "absolute" &&
      typeof pacingValue === "number" &&
      typeof requestLimit5h === "number" &&
      pacingValue > requestLimit5h
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.too_big,
        path: ["pacingValue"],
        maximum: requestLimit5h,
        inclusive: true,
        type: "number",
        message: "固定次数模式不能超过 5 小时限额"
      });
    }
  });
}

const quotaProfileSnapshotSchema = withQuotaProfileValidation(quotaProfileSnapshotBaseSchema);

const agentSchemaBase = z.object({
  name: z.string().min(1).max(50),
  provider: z.enum(["openai", "anthropic"]),
  model: z.string().min(1).max(100),
  contextLength: z.number().int().min(1).max(2_000_000).nullable().optional(),
  maxInputTokens: z.number().int().min(1).max(2_000_000).nullable().optional(),
  maxOutputTokens: z.number().int().min(1).max(2_000_000).nullable().optional(),
  baseUrl: z.string().url().min(1),
  apiKey: z.string().min(1),
  usageControlMode: quotaBindingSchema.shape.usageControlMode,
  quotaProfileId: quotaBindingSchema.shape.quotaProfileId
});

function withProviderMaxOutputValidation<T extends z.ZodTypeAny>(schema: T) {
  return schema.superRefine((data, ctx) => {
    if (!data || typeof data !== "object") return;
    const provider = (data as { provider?: unknown }).provider;
    const maxOutputTokens = (data as { maxOutputTokens?: unknown }).maxOutputTokens;
    const limit = getProviderMaxOutputTokensLimit(typeof provider === "string" ? provider : null);
    if (limit === null || typeof maxOutputTokens !== "number" || maxOutputTokens <= limit) return;
    ctx.addIssue({
      code: z.ZodIssueCode.too_big,
      path: ["maxOutputTokens"],
      maximum: limit,
      inclusive: true,
      type: "number",
      message: `OpenAI 兼容接口的最大输出 Token 不能超过 ${limit.toLocaleString()}`
    });
  });
}

function withAgentValidation<T extends z.ZodTypeAny>(schema: T) {
  return withQuotaBindingValidation(withProviderMaxOutputValidation(schema));
}

export const createAgentSchema = withAgentValidation(agentSchemaBase);

export const testAgentConfigSchema = withQuotaBindingValidation(agentSchemaBase.pick({
  provider: true,
  model: true,
  baseUrl: true,
  apiKey: true,
  usageControlMode: true,
  quotaProfileId: true
}));

export const updateAgentSchema = withAgentValidation(agentSchemaBase.partial().extend({
  isActive: z.boolean().optional()
}));

// === Retrieval config schemas ===

export const createRetrievalConfigSchema = z.object({
  name: z.string().min(1).max(50),
  provider: z.literal("openai"),
  model: z.string().min(1).max(100),
  dimensions: z.number().int().min(1).max(10_000).nullable().optional(),
  baseUrl: z.string().url().min(1),
  apiKey: z.string().min(1)
});

export const updateRetrievalConfigSchema = createRetrievalConfigSchema.partial();

export const testRetrievalConfigSchema = createRetrievalConfigSchema
  .pick({ provider: true, model: true, dimensions: true, baseUrl: true })
  .extend({ apiKey: z.string().min(1).optional() });

// === File path schemas ===

export const relativeFilePathSchema = z
  .string()
  .min(1)
  .max(200)
  .refine((v) => !v.startsWith("/"), "Path must be relative")
  .refine((v) => !v.includes("\\"), "Use / as separator")
  .refine((v) => !v.includes(".."), "Path cannot contain ..")
  .refine((v) => !v.endsWith("/"), "Path must be a file, not a directory");

export const agentFileUpsertSchema = z.object({ path: relativeFilePathSchema, content: z.string().max(100_000) });

export const agentFileDeleteSchema = z.object({ path: relativeFilePathSchema });

export const agentFileMoveSchema = z.object({ fromPath: relativeFilePathSchema, toPath: relativeFilePathSchema });

export const upsertFileSchema = agentFileUpsertSchema;
export const filePathSchema = agentFileDeleteSchema;
export const moveFileSchema = agentFileMoveSchema;

// === Agent export/import schemas ===

export const agentPortableSchema = withProviderMaxOutputValidation(z.object({
  name: z.string().min(1).max(50),
  provider: z.enum(["openai", "anthropic"]),
  model: z.string().min(1).max(100),
  contextLength: z.number().int().min(1).max(2_000_000).nullable().optional(),
  maxInputTokens: z.number().int().min(1).max(2_000_000).nullable().optional(),
  maxOutputTokens: z.number().int().min(1).max(2_000_000).nullable().optional(),
  baseUrl: z.string().url().min(1),
  isActive: z.boolean().optional().default(true),
  apiKey: z.string().min(1),
  files: z.array(agentFileUpsertSchema).optional().default([]),
  usageControlMode: usageControlModeSchema.optional().default("none"),
  quotaProfile: quotaProfileSnapshotSchema.nullable().optional()
}).superRefine((data, ctx) => {
  if (data.usageControlMode === "coding_plan" && !data.quotaProfile) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["quotaProfile"],
      message: "导出的 Coding Plan 配置缺少计划池快照"
    });
  }
  if (data.usageControlMode !== "coding_plan" && data.quotaProfile) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["quotaProfile"],
      message: "未启用 Coding Plan 时不能附带计划池快照"
    });
  }
}));

export const createQuotaProfileSchema = quotaProfileSnapshotSchema;

export const updateQuotaProfileSchema = withQuotaProfileValidation(quotaProfileSnapshotBaseSchema.partial());

export const adjustQuotaProfileSchema = z.object({
  windowType: quotaWindowTypeSchema,
  delta: z.number().int().min(-10_000_000).max(10_000_000).refine((value) => value !== 0, "delta cannot be 0"),
  note: z.string().max(400).nullable().optional()
});

export const exportAgentsRequestSchema = z.object({ agentIds: z.array(z.string()).min(1) });

export const agentsExportPackSchema = z.object({
  formatVersion: z.literal(1),
  exportedAt: z.string().min(1),
  agents: z.array(agentPortableSchema).min(1)
});

export const importAgentsPackSchema = agentsExportPackSchema;

// === Debate schemas ===

const debateCommonSchema = z.object({
  question: z.string().min(10).max(50_000),
  maxTurns: z.number().int().min(0).max(200),
  enableSharedFacts: z.boolean().optional().default(true)
});

export const createDebateSchema = z.union([
  debateCommonSchema.extend({ agentIds: z.array(z.string()).min(2) }),
  debateCommonSchema.extend({
    strategy: z.object({
      strategyId: z.string().min(1),
      bindings: z
        .array(
          z.object({
            roleId: z.string().min(1),
            agentId: z.string().min(1),
            displayName: z.string().max(80).optional()
          })
        )
        .min(2),
      summaryAgentId: z.string().min(1).nullable().optional()
    })
  })
]);

export const updateDebateQuestionSchema = z.object({ question: debateCommonSchema.shape.question });

export const updateDebateSharingSchema = z.object({ isShared: z.boolean() });
export const ignoreDebateRuntimeErrorSchema = z.object({ ignoreRuntimeError: z.literal(true) });
export const updateDebateAutoRecoverSchema = z.object({ autoRecoverOnceOnFailed: z.boolean() });

// === Workspace schemas ===

export const workspaceFileSchema = z.object({
  path: relativeFilePathSchema,
  content: z.string().max(200_000)
});

export const workspaceBindingSchema = z.object({
  id: z.string().min(1).optional(),
  sourceStrategyRoleId: z.string().min(1).nullable().optional(),
  roleName: z.string().min(1).max(80),
  roleOrder: z.number().int().min(1).max(200),
  agentId: z.string().min(1).nullable().optional(),
  displayName: z.string().max(80).nullable().optional()
});

export const createWorkspaceSchema = z.object({
  strategyId: z.string().min(1),
  name: z.string().min(1).max(120),
  description: z.string().max(4000).nullable().optional()
});

export const updateWorkspaceSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(4000).nullable().optional(),
  question: z.string().max(50_000),
  summaryAgentId: z.string().min(1).nullable().optional(),
  defaultMaxTurns: z.number().int().min(0).max(200),
  defaultEnableSharedFacts: z.boolean().optional().default(true),
  bindings: z.array(workspaceBindingSchema).min(2).max(200),
  files: z.array(workspaceFileSchema).max(200).optional()
});

export const createWorkspaceDebateSchema = z.object({
  maxTurns: z.number().int().min(0).max(200).optional(),
  enableSharedFacts: z.boolean().optional()
});

// === Strategy schemas ===

const strategyRoleFileSchema = z.object({ path: relativeFilePathSchema, content: z.string().max(100_000) });

export const strategyRoleSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().min(1).max(80),
  systemPrompt: z.string().max(4000).nullable().optional(),
  files: z.array(strategyRoleFileSchema).max(50).optional().default([])
});

export const createStrategySchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(2000).nullable().optional(),
  isShared: z.boolean().optional().default(false),
  roles: z.array(strategyRoleSchema).min(2)
});

export const updateStrategySchema = createStrategySchema;

export const updateStrategyWorkflowPhasePromptsSchema = z.object({
  phases: z.array(z.object({ id: z.string().min(1).max(80), injectedPrompt: z.string().max(20_000).nullable().optional() })).min(1).max(16)
});

export const updateStrategyWorkflowConfigSchema = z.object({ workflowConfig: z.unknown() });

export const strategyFileAccessRuleSchema = z.object({
  scope: z.enum(["shared", "seat"]),
  targetType: z.enum(["file", "dir"]),
  targetPath: relativeFilePathSchema,
  accessMode: z.enum(["always_read", "read_when_needed", "unlock_after_phase"]),
  phaseKind: z.enum(["analysis", "deliberation", "finalization_vote", "finalization"]).nullable().optional(),
  strategyRoleId: z.string().min(1).nullable().optional()
});

export const updateStrategyFileAccessRuleSchema = strategyFileAccessRuleSchema.partial().extend({
  targetPath: relativeFilePathSchema.optional()
});

export const deleteStrategyFileAccessRuleSchema = z.object({
  ruleId: z.string().min(1)
});
