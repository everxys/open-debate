import { z } from "zod";

// === Agent schemas ===

export const createAgentSchema = z.object({
  name: z.string().min(1).max(50),
  provider: z.enum(["openai", "anthropic"]),
  model: z.string().min(1).max(100),
  contextLength: z.number().int().min(1).max(2_000_000).nullable().optional(),
  maxInputTokens: z.number().int().min(1).max(2_000_000).nullable().optional(),
  maxOutputTokens: z.number().int().min(1).max(2_000_000).nullable().optional(),
  baseUrl: z.string().url().min(1),
  apiKey: z.string().min(1)
});

export const testAgentConfigSchema = createAgentSchema.pick({ provider: true, model: true, baseUrl: true, apiKey: true });

export const updateAgentSchema = createAgentSchema.partial();

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

// === Agent export/import schemas ===

export const agentPortableSchema = z.object({
  name: z.string().min(1).max(50),
  provider: z.enum(["openai", "anthropic"]),
  model: z.string().min(1).max(100),
  contextLength: z.number().int().min(1).max(2_000_000).nullable().optional(),
  maxInputTokens: z.number().int().min(1).max(2_000_000).nullable().optional(),
  maxOutputTokens: z.number().int().min(1).max(2_000_000).nullable().optional(),
  baseUrl: z.string().url().min(1),
  isActive: z.boolean().optional().default(true),
  apiKey: z.string().min(1),
  files: z.array(agentFileUpsertSchema).optional().default([])
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
      bindings: z.array(z.object({ roleId: z.string().min(1), agentId: z.string().min(1) })).min(2)
    })
  })
]);

export const updateDebateQuestionSchema = z.object({ question: debateCommonSchema.shape.question });

export const updateDebateSharingSchema = z.object({ isShared: z.boolean() });

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
  openingPrompt: z.string().max(20_000).nullable().optional(),
  phases: z.array(z.object({ id: z.string().min(1).max(80), injectedPrompt: z.string().max(20_000).nullable().optional() })).min(1).max(16)
});

export const updateStrategyWorkflowConfigSchema = z.object({ workflowConfig: z.unknown() });
