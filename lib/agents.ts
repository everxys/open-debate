import { decryptSecret, encryptSecret, maskSecret } from "@/lib/crypto";
import { query } from "@/lib/db";
import { AppError } from "@/lib/http";
import { readSession } from "@/lib/session";
import type { AgentRecord, Provider } from "@/lib/types";
import {
  agentFileDeleteSchema,
  agentFileUpsertSchema,
  createAgentSchema,
  testAgentConfigSchema,
  updateAgentSchema
} from "@/lib/validation";

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
  return provider === "openai"
    ? `${normalized}/chat/completions`
    : `${normalized}/messages`;
}

function resolveTestUrlCandidates(provider: Provider, baseUrl: string) {
  const normalized = baseUrl.replace(/\/+$/, "");
  const candidates = [normalized];

  try {
    const url = new URL(normalized);
    const pathname = url.pathname.replace(/\/+$/, "");
    const endsWithV1 = pathname === "/v1" || pathname.endsWith("/v1");
    if (!endsWithV1) {
      candidates.push(`${normalized}/v1`);
    }
  } catch {
    // ignore malformed URL; schema validation should prevent this
  }

  return Array.from(new Set(candidates)).map((candidate) => resolveTestUrl(provider, candidate));
}

async function callProviderHealthCheck(input: {
  provider: Provider;
  baseUrl: string;
  apiKey: string;
  model: string;
}) {
  const urls = resolveTestUrlCandidates(input.provider, input.baseUrl);
  const headers = new Headers({ "Content-Type": "application/json" });

  if (input.provider === "openai") {
    headers.set("Authorization", `Bearer ${input.apiKey}`);
  } else {
    headers.set("x-api-key", input.apiKey);
    headers.set("anthropic-version", "2023-06-01");
  }

  let lastError: AppError | null = null;

  for (let index = 0; index < urls.length; index += 1) {
    const url = urls[index];
    let response: Response;

    try {
      response = await fetch(url, {
        method: "POST",
        headers,
        body:
          input.provider === "openai"
            ? JSON.stringify({
                model: input.model,
                messages: [{ role: "user", content: "Reply with OK" }],
                max_tokens: 8,
                stream: false
              })
            : JSON.stringify({
                model: input.model,
                max_tokens: 16,
                messages: [{ role: "user", content: "Reply with OK" }]
              })
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new AppError(
        "AI_NETWORK_ERROR",
        502,
        `Provider request failed for ${url}: ${message}`
      );
    }

    if (response.ok) {
      return {
        connected: true,
        message: `${input.provider} API is reachable`
      };
    }

    const contentType = response.headers.get("content-type") ?? "";
    const text = await response.text();
    let extractedMessage: string | null = null;

    if (contentType.includes("application/json")) {
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        const openAiError = parsed.error as Record<string, unknown> | undefined;
        const anthropicError = (parsed as { error?: Record<string, unknown> }).error;

        extractedMessage =
          (typeof openAiError?.message === "string" && openAiError.message) ||
          (typeof anthropicError?.message === "string" && anthropicError.message) ||
          (typeof parsed.message === "string" && parsed.message) ||
          null;
      } catch {
        // ignore
      }
    }

    const rawDetails = contentType.includes("application/json")
      ? text.slice(0, 400)
      : text.slice(0, 200);
    const details = extractedMessage ?? rawDetails;

    lastError = new AppError(
      "AI_API_ERROR",
      502,
      `Provider test failed: ${input.provider} ${url} -> ${response.status} ${
        details || response.statusText
      }`
    );

    const hasNextCandidate = index < urls.length - 1;
    if (response.status === 404 && hasNextCandidate) {
      continue;
    }

    throw lastError;
  }

  throw lastError ?? new AppError("AI_API_ERROR", 502, "Provider test failed");
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

function isMissingTableError(error: unknown, table: string) {
  if (typeof error !== "object" || error === null) return false;
  const anyError = error as { code?: unknown; message?: unknown };
  if (anyError.code !== "42P01") return false;
  const message = typeof anyError.message === "string" ? anyError.message : "";
  return message.toLowerCase().includes(table.toLowerCase());
}

export async function listAgentFiles(agentId: string) {
  await getAgentById(agentId);
  try {
    const result = await query<Record<string, unknown>>(
      "select path, content, created_at, updated_at from ai_agent_files where ai_agent_id = $1 order by path asc",
      [agentId]
    );
    return result.rows.map((row) => ({
      path: String(row.path),
      content: String(row.content ?? ""),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    }));
  } catch (error) {
    if (isMissingTableError(error, "ai_agent_files")) {
      throw new AppError("MIGRATION_REQUIRED", 500, "Missing ai_agent_files table");
    }
    throw error;
  }
}

export async function upsertAgentFile(agentId: string, input: unknown) {
  const data = agentFileUpsertSchema.parse(input);
  await getAgentById(agentId);
  const now = new Date().toISOString();

  try {
    const result = await query<Record<string, unknown>>(
      `
        insert into ai_agent_files (ai_agent_id, path, content, created_at, updated_at)
        values ($1, $2, $3, $4, $4)
        on conflict (ai_agent_id, path)
        do update set content = excluded.content, updated_at = excluded.updated_at
        returning path, content, created_at, updated_at
      `,
      [agentId, data.path, data.content, now]
    );
    return {
      path: String(result.rows[0].path),
      content: String(result.rows[0].content ?? ""),
      createdAt: String(result.rows[0].created_at),
      updatedAt: String(result.rows[0].updated_at)
    };
  } catch (error) {
    if (isMissingTableError(error, "ai_agent_files")) {
      throw new AppError("MIGRATION_REQUIRED", 500, "Missing ai_agent_files table");
    }
    throw error;
  }
}

export async function deleteAgentFile(agentId: string, input: unknown) {
  const data = agentFileDeleteSchema.parse(input);
  await getAgentById(agentId);
  try {
    const result = await query(
      "delete from ai_agent_files where ai_agent_id = $1 and path = $2",
      [agentId, data.path]
    );
    if ((result.rowCount ?? 0) !== 1) {
      throw new AppError("NOT_FOUND", 404, "File not found");
    }
  } catch (error) {
    if (isMissingTableError(error, "ai_agent_files")) {
      throw new AppError("MIGRATION_REQUIRED", 500, "Missing ai_agent_files table");
    }
    throw error;
  }
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
  const result = await callProviderHealthCheck({
    provider: agent.provider,
    baseUrl: agent.baseUrl,
    apiKey: decryptSecret(agent.apiKeyEncrypted),
    model: agent.model
  });
  return { ...result, message: `${agent.name} is reachable` };
}

export async function testAgentConfig(input: unknown) {
  const data = testAgentConfigSchema.parse(input);
  await requireSessionUser();
  return callProviderHealthCheck({
    provider: data.provider,
    baseUrl: data.baseUrl,
    apiKey: data.apiKey,
    model: data.model
  });
}
