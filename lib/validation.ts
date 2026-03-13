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

const filePathSchema = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => !value.startsWith("/"), "Path must be relative")
  .refine((value) => !value.includes("\\"), "Use / as separator")
  .refine((value) => !value.includes(".."), "Path cannot contain ..")
  .refine((value) => !value.endsWith("/"), "Path must be a file, not a directory");

export const agentFileUpsertSchema = z.object({
  path: filePathSchema,
  content: z.string().max(100_000)
});

export const agentFileDeleteSchema = z.object({
  path: filePathSchema
});

export const agentFileMoveSchema = z.object({
  fromPath: filePathSchema,
  toPath: filePathSchema
});

export const createDebateSchema = z.object({
  question: z.string().min(10).max(5000),
  agentIds: z.array(z.string()).min(2).max(5),
  maxTurns: z.number().int().min(1).max(50),
  tokenBudget: z.number().int().positive().max(1000000).nullable().optional()
});
