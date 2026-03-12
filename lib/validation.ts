import { z } from "zod";

export const createAgentSchema = z.object({
  name: z.string().min(1).max(50),
  provider: z.enum(["openai", "anthropic"]),
  model: z.string().min(1).max(100),
  baseUrl: z.string().url().min(1),
  systemPrompt: z.string().max(4000).optional().default(""),
  apiKey: z.string().min(1)
});

export const updateAgentSchema = createAgentSchema.partial();

export const createDebateSchema = z.object({
  question: z.string().min(10).max(5000),
  agentIds: z.array(z.string()).min(2).max(5),
  maxTurns: z.number().int().min(1).max(50),
  tokenBudget: z.number().int().positive().max(1000000).nullable().optional()
});
