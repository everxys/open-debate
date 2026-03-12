import { decryptSecret, encryptSecret, maskSecret } from "@/lib/crypto";
import { query } from "@/lib/db";
import { AppError } from "@/lib/http";
import { readSession } from "@/lib/session";
import type { AgentRecord, Provider } from "@/lib/types";
import { createAgentSchema, updateAgentSchema } from "@/lib/validation";

function toAgentView(agent: AgentRecord) {
  return {
    id: agent.id,
    name: agent.name,
    provider: agent.provider,
    model: agent.model,
    baseUrl: agent.baseUrl,
    systemPrompt: agent.systemPrompt,
    apiKeyMasked: agent.apiKeyMasked,
    isActive: agent.isActive,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt
  };
}

function normalizeAgentRow(row: Record<string, unknown>): AgentRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    name: String(row.name),
    provider: row.provider as Provider,
    model: String(row.model),
    baseUrl: String(row.base_url),
    apiKeyEncrypted: String(row.api_key_encrypted),
    apiKeyMasked: String(row.api_key_masked),
    systemPrompt: (row.system_prompt as string | null) ?? null,
    isActive: Boolean(row.is_active),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

async function requireSessionUser() {
  const session = await readSession();
  if (!session) {
    throw new AppError("AUTH_REQUIRED", 401, "Authentication required");
  }
  return session;
}

function resolveTestUrl(provider: Provider, baseUrl: string) {
  const normalized = baseUrl.replace(/\/+$/, "");
  return provider === "openai" ? `${normalized}/models` : `${normalized}/messages`;
}

async function callProviderHealthCheck(input: {
  provider: Provider;
  baseUrl: string;
  apiKey: string;
  model: string;
}) {
  const url = resolveTestUrl(input.provider, input.baseUrl);
  const headers = new Headers({ "Content-Type": "application/json" });

  if (input.provider === "openai") {
    headers.set("Authorization", `Bearer ${input.apiKey}`);
  } else {
    headers.set("x-api-key", input.apiKey);
    headers.set("anthropic-version", "2023-06-01");
  }

  const response = await fetch(url, {
    method: input.provider === "openai" ? "GET" : "POST",
    headers,
    body:
      input.provider === "openai"
        ? undefined
        : JSON.stringify({
            model: input.model,
            max_tokens: 16,
            messages: [{ role: "user", content: "Reply with OK" }]
          })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new AppError(
      "AI_API_ERROR",
      502,
      `Provider test failed: ${response.status} ${text.slice(0, 200)}`
    );
  }

  return {
    connected: true,
    message: `${input.provider} API is reachable`
  };
}

export async function listAgents() {
  const session = await requireSessionUser();
  const result = await query<Record<string, unknown>>(
    "select * from ai_agents where user_id = $1 order by created_at desc",
    [session.userId]
  );
  return result.rows.map((row: Record<string, unknown>) => toAgentView(normalizeAgentRow(row)));
}

export async function getAgentById(id: string) {
  const session = await requireSessionUser();
  const result = await query<Record<string, unknown>>(
    "select * from ai_agents where id = $1 and user_id = $2",
    [id, session.userId]
  );
  if ((result.rowCount ?? 0) !== 1) {
    throw new AppError("NOT_FOUND", 404, "Agent not found");
  }
  return normalizeAgentRow(result.rows[0]);
}

export async function createAgent(input: unknown) {
  const data = createAgentSchema.parse(input);
  const session = await requireSessionUser();
  const now = new Date().toISOString();
  const result = await query<Record<string, unknown>>(
    `insert into ai_agents (
      user_id, name, provider, model, base_url, api_key_encrypted, api_key_masked,
      system_prompt, is_active, created_at, updated_at
    ) values ($1,$2,$3,$4,$5,$6,$7,$8,true,$9,$9)
    returning *`,
    [
      session.userId,
      data.name,
      data.provider,
      data.model,
      data.baseUrl,
      encryptSecret(data.apiKey),
      maskSecret(data.apiKey),
      data.systemPrompt || null,
      now
    ]
  );
  return toAgentView(normalizeAgentRow(result.rows[0]));
}

export async function updateAgent(id: string, input: unknown) {
  const data = updateAgentSchema.parse(input);
  const session = await requireSessionUser();
  const current = await getAgentById(id);

  const result = await query<Record<string, unknown>>(
    `update ai_agents
      set name = $3,
          provider = $4,
          model = $5,
          base_url = $6,
          api_key_encrypted = $7,
          api_key_masked = $8,
          system_prompt = $9,
          updated_at = $10
     where id = $1 and user_id = $2
     returning *`,
    [
      id,
      session.userId,
      data.name ?? current.name,
      data.provider ?? current.provider,
      data.model ?? current.model,
      data.baseUrl ?? current.baseUrl,
      data.apiKey ? encryptSecret(data.apiKey) : current.apiKeyEncrypted,
      data.apiKey ? maskSecret(data.apiKey) : current.apiKeyMasked,
      data.systemPrompt !== undefined ? data.systemPrompt || null : current.systemPrompt,
      new Date().toISOString()
    ]
  );

  if ((result.rowCount ?? 0) !== 1) {
    throw new AppError("NOT_FOUND", 404, "Agent not found");
  }

  return toAgentView(normalizeAgentRow(result.rows[0]));
}

export async function deleteAgent(id: string) {
  const session = await requireSessionUser();
  const relation = await query("select id from debate_agents where ai_agent_id = $1 limit 1", [id]);
  if ((relation.rowCount ?? 0) > 0) {
    throw new AppError("CONFLICT", 409, "Agent is already used by a debate");
  }

  await query("delete from ai_agents where id = $1 and user_id = $2", [id, session.userId]);
}

export async function testAgentConnection(id: string) {
  const agent = await getAgentById(id);
  return callProviderHealthCheck({
    provider: agent.provider,
    baseUrl: agent.baseUrl,
    apiKey: decryptSecret(agent.apiKeyEncrypted),
    model: agent.model
  });
}

export async function testAgentConfig(input: unknown) {
  const data = createAgentSchema.parse(input);
  await requireSessionUser();
  return callProviderHealthCheck({
    provider: data.provider,
    baseUrl: data.baseUrl,
    apiKey: data.apiKey,
    model: data.model
  });
}
