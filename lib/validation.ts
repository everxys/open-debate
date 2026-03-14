import { z } from "zod";

export const createAgentSchema = z.object({
  name: z.string().min(1).max(50),
  provider: z.enum(["openai", "anthropic"]),
  model: z.string().min(1).max(100),
  baseUrl: z.string().url().min(1),
  systemPrompt: z.string().max(4000).optional().default(""),
  apiKey: z.string().min(1)
});

export const testAgentConfigSchema = createAgentSchema.pick({
  provider: true,
  model: true,
  baseUrl: true,
  systemPrompt: true,
  apiKey: true
});

export const updateAgentSchema = createAgentSchema.partial();

export const relativeFilePathSchema = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => !value.startsWith("/"), "Path must be relative")
  .refine((value) => !value.includes("\\"), "Use / as separator")
  .refine((value) => !value.includes(".."), "Path cannot contain ..")
  .refine((value) => !value.endsWith("/"), "Path must be a file, not a directory");

export const agentFileUpsertSchema = z.object({
  path: relativeFilePathSchema,
  content: z.string().max(100_000)
});

export const agentFileDeleteSchema = z.object({
  path: relativeFilePathSchema
});

export const agentFileMoveSchema = z.object({
  fromPath: relativeFilePathSchema,
  toPath: relativeFilePathSchema
});

const debateCommonSchema = z.object({
  question: z.string().min(10).max(5000),
  maxTurns: z.number().int().min(1).max(50),
  tokenBudget: z.number().int().positive().max(1000000).nullable().optional(),
  enableSharedFacts: z.boolean().optional().default(true)
});

export const createDebateSchema = z.union([
  debateCommonSchema.extend({
    agentIds: z.array(z.string()).min(2).max(5)
  }),
  debateCommonSchema.extend({
    strategy: z.object({
      strategyId: z.string().min(1),
      bindings: z
        .array(
          z.object({
            roleId: z.string().min(1),
            agentId: z.string().min(1)
          })
        )
        .min(2)
        .max(5)
    })
  })
]);

const strategyRoleFileSchema = z.object({
  path: relativeFilePathSchema,
  content: z.string().max(100_000)
});

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
  roles: z.array(strategyRoleSchema).min(2).max(5)
});

export const updateStrategySchema = createStrategySchema;
