import { decryptSecret, encryptSecret, maskSecret } from "@/lib/crypto";
import { getPool, query } from "@/lib/db";
import { AppError } from "@/lib/http";
import { readSession } from "@/lib/session";
import type { AgentRecord, Provider } from "@/lib/types";
import {
  agentFileDeleteSchema,
  agentFileMoveSchema,
  agentFileUpsertSchema,
  exportAgentsRequestSchema,
  createAgentSchema,
  importAgentsPackSchema,
  testAgentConfigSchema,
  updateAgentSchema
} from "@/lib/validation";

function toAgentView(agent: AgentRecord) {
  return {
    id: agent.id,
    name: agent.name,
    provider: agent.provider,
    model: agent.model,
    contextLength: agent.contextLength,
    baseUrl: agent.baseUrl,
    apiKeyMasked: agent.apiKeyMasked,
    isActive: agent.isActive,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt
  };
}

function normalizeAgentRow(row: Record<string, unknown>): AgentRecord {
  const contextLengthRaw = row.context_length ?? row.contextLength ?? null;
  const contextLength = contextLengthRaw === null ? null : Number(contextLengthRaw);
  return {
    id: String(row.id),
    userId: String(row.user_id),
    name: String(row.name),
    provider: row.provider as Provider,
    model: String(row.model),
    contextLength:
      contextLength !== null && Number.isFinite(contextLength) && contextLength > 0 ? Math.floor(contextLength) : null,
    baseUrl: String(row.base_url),
    apiKeyEncrypted: String(row.api_key_encrypted),
    apiKeyMasked: String(row.api_key_masked),
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

function extractUsage(provider: Provider, parsed: unknown) {
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const usage = obj.usage && typeof obj.usage === "object" ? (obj.usage as Record<string, unknown>) : null;
  if (!usage) return null;

  if (provider === "openai") {
    const prompt = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : null;
    const completion = typeof usage.completion_tokens === "number" ? usage.completion_tokens : null;
    const total = typeof usage.total_tokens === "number" ? usage.total_tokens : null;
    if (prompt === null && completion === null && total === null) return null;
    return { promptTokens: prompt, completionTokens: completion, totalTokens: total };
  }

  const input = typeof usage.input_tokens === "number" ? usage.input_tokens : null;
  const output = typeof usage.output_tokens === "number" ? usage.output_tokens : null;
  if (input === null && output === null) return null;
  return { inputTokens: input, outputTokens: output };
}

async function callProviderDebug(input: {
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
                messages: [{ role: "user", content: "OK" }],
                // Keep this fast: we only need the provider's raw JSON envelope + usage (if present).
                max_tokens: 1,
                stream: false,
                temperature: 0
              })
            : JSON.stringify({
                model: input.model,
                max_tokens: 1,
                messages: [{ role: "user", content: "OK" }]
              })
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new AppError("AI_NETWORK_ERROR", 502, `Provider request failed for ${url}: ${message}`);
    }

    const contentType = response.headers.get("content-type") ?? "";
    const text = await response.text().catch(() => "");

    const parsed =
      contentType.includes("application/json") ? ((() => {
        try {
          return JSON.parse(text) as unknown;
        } catch {
          return null;
        }
      })()) : null;

    if (response.ok) {
      const usage = extractUsage(input.provider, parsed);
      return {
        ok: true,
        provider: input.provider,
        url,
        status: response.status,
        hasUsage: Boolean(usage),
        usage,
        json: parsed,
        rawText: text.length > 80_000 ? text.slice(0, 80_000) : text
      };
    }

    const details = contentType.includes("application/json") ? text.slice(0, 400) : text.slice(0, 200);
    lastError = new AppError(
      "AI_API_ERROR",
      502,
      `Provider debug failed: ${input.provider} ${url} -> ${response.status} ${details || response.statusText}`
    );

    const hasNextCandidate = index < urls.length - 1;
    if (response.status === 404 && hasNextCandidate) {
      continue;
    }

    throw lastError;
  }

  throw lastError ?? new AppError("AI_API_ERROR", 502, "Provider debug failed");
}

export async function listAgents() {
  const session = await requireSessionUser();
  const result = await query<Record<string, unknown>>(
    "select * from ai_agents where user_id = $1 and deleted_at is null order by created_at desc",
    [session.userId]
  );
  return result.rows.map((row: Record<string, unknown>) => toAgentView(normalizeAgentRow(row)));
}

export async function exportAgentsPack(input: unknown) {
  const data = exportAgentsRequestSchema.parse(input);
  const session = await requireSessionUser();

  const agentsResult = await query<Record<string, unknown>>(
    "select * from ai_agents where user_id = $1 and id = any($2::uuid[]) order by created_at asc",
    [session.userId, data.agentIds]
  );
  if ((agentsResult.rowCount ?? 0) !== data.agentIds.length) {
    throw new AppError("VALIDATION_ERROR", 400, "Selected agents are invalid");
  }

  const agents = agentsResult.rows.map((row) => normalizeAgentRow(row));

  let fileRows: Array<{ ai_agent_id: string; path: string; content: string }> = [];
  try {
    const filesResult = await query<Record<string, unknown>>(
      "select ai_agent_id, path, content from ai_agent_files where ai_agent_id = any($1::uuid[]) order by ai_agent_id asc, path asc",
      [data.agentIds]
    );
    fileRows = filesResult.rows.map((row) => ({
      ai_agent_id: String(row.ai_agent_id),
      path: String(row.path),
      content: String(row.content ?? "")
    }));
  } catch (error) {
    if (isMissingTableError(error, "ai_agent_files")) {
      throw new AppError("MIGRATION_REQUIRED", 500, "Missing ai_agent_files table");
    }
    throw error;
  }

  const filesByAgentId = new Map<string, Array<{ path: string; content: string }>>();
  for (const row of fileRows) {
    const list = filesByAgentId.get(row.ai_agent_id) ?? [];
    list.push({ path: row.path, content: row.content });
    filesByAgentId.set(row.ai_agent_id, list);
  }

  const exportedAt = new Date().toISOString();
  return {
    formatVersion: 1 as const,
    exportedAt,
    agents: agents.map((agent) => ({
      name: agent.name,
      provider: agent.provider,
      model: agent.model,
      contextLength: agent.contextLength,
      baseUrl: agent.baseUrl,
      isActive: agent.isActive,
      apiKey: decryptSecret(agent.apiKeyEncrypted),
      files: filesByAgentId.get(agent.id) ?? []
    }))
  };
}

export async function importAgentsPack(input: unknown) {
  const data = importAgentsPackSchema.parse(input);
  const session = await requireSessionUser();
  const now = new Date().toISOString();
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("begin");

    const createdAgents: AgentRecord[] = [];
    for (const item of data.agents) {
      const inserted = await client.query<Record<string, unknown>>(
        `insert into ai_agents (
          user_id, name, provider, model, context_length, base_url, api_key_encrypted, api_key_masked,
          is_active, created_at, updated_at
        ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)
        returning *`,
        [
          session.userId,
          item.name,
          item.provider,
          item.model,
          typeof (item as { contextLength?: unknown }).contextLength === "number"
            ? (item as { contextLength: number }).contextLength
            : null,
          item.baseUrl,
          encryptSecret(item.apiKey),
          maskSecret(item.apiKey),
          item.isActive ?? true,
          now
        ]
      );

      const created = normalizeAgentRow(inserted.rows[0]);
      createdAgents.push(created);

      try {
        for (const file of item.files ?? []) {
          await client.query(
            `
              insert into ai_agent_files (ai_agent_id, path, content, created_at, updated_at)
              values ($1, $2, $3, $4, $4)
              on conflict (ai_agent_id, path)
              do update set content = excluded.content, updated_at = excluded.updated_at
            `,
            [created.id, file.path, file.content, now]
          );
        }
      } catch (error) {
        if (isMissingTableError(error, "ai_agent_files")) {
          throw new AppError("MIGRATION_REQUIRED", 500, "Missing ai_agent_files table");
        }
        throw error;
      }
    }

    await client.query("commit");
    return createdAgents.map((agent) => toAgentView(agent));
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      // ignore
    }
    throw error;
  } finally {
    client.release();
  }
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

export async function getAgentViewById(id: string) {
  const agent = await getAgentById(id);
  return toAgentView(agent);
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

export async function moveAgentFile(agentId: string, input: unknown) {
  const data = agentFileMoveSchema.parse(input);
  await getAgentById(agentId);
  if (data.fromPath === data.toPath) {
    throw new AppError("VALIDATION_ERROR", 400, "fromPath and toPath must be different");
  }
  const now = new Date().toISOString();

  try {
    const exists = await query<{ path: string }>(
      "select path from ai_agent_files where ai_agent_id = $1 and path = $2",
      [agentId, data.toPath]
    );
    if ((exists.rowCount ?? 0) > 0) {
      throw new AppError("CONFLICT", 409, "Target path already exists");
    }

    const updated = await query<Record<string, unknown>>(
      `
        update ai_agent_files
        set path = $3,
            updated_at = $4
        where ai_agent_id = $1 and path = $2
        returning path, content, created_at, updated_at
      `,
      [agentId, data.fromPath, data.toPath, now]
    );
    if ((updated.rowCount ?? 0) !== 1) {
      throw new AppError("NOT_FOUND", 404, "File not found");
    }
    return {
      path: String(updated.rows[0].path),
      content: String(updated.rows[0].content ?? ""),
      createdAt: String(updated.rows[0].created_at),
      updatedAt: String(updated.rows[0].updated_at)
    };
  } catch (error) {
    if (isMissingTableError(error, "ai_agent_files")) {
      throw new AppError("MIGRATION_REQUIRED", 500, "Missing ai_agent_files table");
    }
    throw error;
  }
}

export async function duplicateAgent(id: string) {
  const session = await requireSessionUser();
  const source = await getAgentById(id);
  const now = new Date().toISOString();

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("begin");

    const inserted = await client.query<Record<string, unknown>>(
      `
        insert into ai_agents (
          user_id, name, provider, model, base_url, api_key_encrypted, api_key_masked,
          is_active, created_at, updated_at
        ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)
        returning *
      `,
      [
        session.userId,
        `${source.name} (copy)`,
        source.provider,
        source.model,
        source.baseUrl,
        source.apiKeyEncrypted,
        source.apiKeyMasked,
        source.isActive,
        now
      ]
    );

    const created = normalizeAgentRow(inserted.rows[0]);

    try {
      await client.query(
        `
          insert into ai_agent_files (ai_agent_id, path, content, created_at, updated_at)
          select $2, path, content, $3, $3
          from ai_agent_files
          where ai_agent_id = $1
        `,
        [source.id, created.id, now]
      );
    } catch (error) {
      if (!isMissingTableError(error, "ai_agent_files")) {
        throw error;
      }
    }

    await client.query("commit");
    return toAgentView(created);
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      // ignore
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function createAgent(input: unknown) {
  const data = createAgentSchema.parse(input);
  const session = await requireSessionUser();
  const now = new Date().toISOString();
  const result = await query<Record<string, unknown>>(
    `insert into ai_agents (
      user_id, name, provider, model, context_length, base_url, api_key_encrypted, api_key_masked,
      is_active, created_at, updated_at
    ) values ($1,$2,$3,$4,$5,$6,$7,$8,true,$9,$9)
    returning *`,
    [
      session.userId,
      data.name,
      data.provider,
      data.model,
      data.contextLength ?? null,
      data.baseUrl,
      encryptSecret(data.apiKey),
      maskSecret(data.apiKey),
      now
    ]
  );
  return toAgentView(normalizeAgentRow(result.rows[0]));
}

export async function updateAgent(id: string, input: unknown) {
  const data = updateAgentSchema.parse(input);
  const session = await requireSessionUser();
  const current = await getAgentById(id);
  const hasContextLength = Object.prototype.hasOwnProperty.call(data, "contextLength");
  const contextLengthRaw = (data as { contextLength?: unknown }).contextLength;
  const nextContextLength =
    hasContextLength
      ? typeof contextLengthRaw === "number"
        ? contextLengthRaw
        : contextLengthRaw === null
          ? null
          : current.contextLength
      : current.contextLength;

  const result = await query<Record<string, unknown>>(
    `update ai_agents
      set name = $3,
          provider = $4,
          model = $5,
          context_length = $6,
          base_url = $7,
          api_key_encrypted = $8,
          api_key_masked = $9,
          updated_at = $10
     where id = $1 and user_id = $2
     returning *`,
    [
      id,
      session.userId,
      data.name ?? current.name,
      data.provider ?? current.provider,
      data.model ?? current.model,
      nextContextLength,
      data.baseUrl ?? current.baseUrl,
      data.apiKey ? encryptSecret(data.apiKey) : current.apiKeyEncrypted,
      data.apiKey ? maskSecret(data.apiKey) : current.apiKeyMasked,
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
  const relation = await query(
    `
      select da.id
        from debate_agents da
        join debates d on d.id = da.debate_id
       where da.ai_agent_id = $1
         and d.user_id = $2
         and d.status in ('pending','running','paused')
       limit 1
    `,
    [id, session.userId]
  );
  if ((relation.rowCount ?? 0) > 0) {
    throw new AppError("CONFLICT", 409, "Agent is already used by an active debate");
  }

  const now = new Date().toISOString();
  const result = await query(
    `update ai_agents
        set deleted_at = $3,
            is_active = false,
            updated_at = $3
      where id = $1 and user_id = $2 and deleted_at is null
      returning id`,
    [id, session.userId, now]
  );
  if ((result.rowCount ?? 0) !== 1) {
    throw new AppError("NOT_FOUND", 404, "Agent not found");
  }
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

export async function testAgentConnectionDebug(id: string) {
  const agent = await getAgentById(id);
  const result = await callProviderDebug({
    provider: agent.provider,
    baseUrl: agent.baseUrl,
    apiKey: decryptSecret(agent.apiKeyEncrypted),
    model: agent.model
  });
  return { ...result, agentId: agent.id, agentName: agent.name, model: agent.model };
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
