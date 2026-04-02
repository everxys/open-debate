import { decryptSecret, encryptSecret, maskSecret } from "@/lib/crypto";
import { getPool, query } from "@/lib/db";
import { AppError } from "@/lib/http";
import { requireSessionUser } from "@/lib/auth";
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

/** Convert AgentRecord to API view (omit sensitive fields) */
function toAgentView(agent: AgentRecord) {
  return {
    id: agent.id,
    name: agent.name,
    provider: agent.provider,
    model: agent.model,
    contextLength: agent.contextLength,
    maxInputTokens: agent.maxInputTokens,
    maxOutputTokens: agent.maxOutputTokens,
    baseUrl: agent.baseUrl,
    apiKeyMasked: agent.apiKeyMasked,
    isActive: agent.isActive,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt
  };
}

/** Parse nullable integer from DB row */
function parseNullableInt(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const num = Number(value);
  return num > 0 && Number.isFinite(num) ? Math.floor(num) : null;
}

/** Normalize DB row to AgentRecord */
function normalizeAgentRow(row: Record<string, unknown>): AgentRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    name: String(row.name),
    provider: row.provider as Provider,
    model: String(row.model),
    contextLength: parseNullableInt(row.context_length ?? row.contextLength),
    maxInputTokens: parseNullableInt(row.max_input_tokens ?? row.maxInputTokens),
    maxOutputTokens: parseNullableInt(row.max_output_tokens ?? row.maxOutputTokens),
    baseUrl: String(row.base_url),
    apiKeyEncrypted: String(row.api_key_encrypted),
    apiKeyMasked: String(row.api_key_masked),
    isActive: Boolean(row.is_active),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

/** Resolve API endpoint URL for provider health check */
function resolveTestUrl(provider: Provider, baseUrl: string) {
  const normalized = baseUrl.replace(/\/+$/, "");
  return provider === "openai" ? `${normalized}/chat/completions` : `${normalized}/messages`;
}

/** Resolve candidate URLs for health check (with /v1 fallback) */
function resolveTestUrlCandidates(provider: Provider, baseUrl: string) {
  const normalized = baseUrl.replace(/\/+$/, "");
  const candidates = [normalized];

  try {
    const url = new URL(normalized);
    const pathname = url.pathname.replace(/\/+$/, "");
    if (pathname !== "/v1" && !pathname.endsWith("/v1")) {
      candidates.push(`${normalized}/v1`);
    }
  } catch { /* ignore malformed URL */ }

  return Array.from(new Set(candidates)).map((c) => resolveTestUrl(provider, c));
}

function buildProviderRequestHeaders(provider: Provider, apiKey: string) {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (provider === "openai") {
    headers.set("Authorization", `Bearer ${apiKey}`);
  } else {
    headers.set("x-api-key", apiKey);
    headers.set("anthropic-version", "2023-06-01");
  }
  return headers;
}

function parseProviderResponseBody(contentType: string, text: string) {
  if (!contentType.includes("application/json")) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

async function callProviderEndpoint(input: {
  provider: Provider;
  baseUrl: string;
  apiKey: string;
  model: string;
  buildBody: (provider: Provider, model: string) => string;
}) {
  const urls = resolveTestUrlCandidates(input.provider, input.baseUrl);
  const headers = buildProviderRequestHeaders(input.provider, input.apiKey);

  for (let index = 0; index < urls.length; index += 1) {
    const url = urls[index];
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers,
        body: input.buildBody(input.provider, input.model)
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new AppError("AI_NETWORK_ERROR", 502, `Provider request failed for ${url}: ${message}`);
    }

    const contentType = response.headers.get("content-type") ?? "";
    const text = await response.text().catch(() => "");
    const parsed = parseProviderResponseBody(contentType, text);
    const hasNextCandidate = index < urls.length - 1;
    if (response.status === 404 && hasNextCandidate) continue;

    return {
      url,
      status: response.status,
      ok: response.ok,
      contentType,
      text,
      parsed,
      statusText: response.statusText
    };
  }

  throw new AppError("AI_API_ERROR", 502, "Provider request failed");
}

function extractProviderErrorMessage(parsed: unknown) {
  if (!parsed || typeof parsed !== "object") return null;
  const body = parsed as Record<string, unknown>;
  const openAiError = body.error as Record<string, unknown> | undefined;
  const anthropicError = (body as { error?: Record<string, unknown> }).error;
  return (
    (typeof openAiError?.message === "string" && openAiError.message) ||
    (typeof anthropicError?.message === "string" && anthropicError.message) ||
    (typeof body.message === "string" && body.message) ||
    null
  );
}

async function callProviderHealthCheck(input: {
  provider: Provider;
  baseUrl: string;
  apiKey: string;
  model: string;
}) {
  const response = await callProviderEndpoint({
    ...input,
    buildBody: (provider, model) =>
      provider === "openai"
        ? JSON.stringify({
            model,
            messages: [{ role: "user", content: "Reply with OK" }],
            max_tokens: 8,
            stream: false
          })
        : JSON.stringify({
            model,
            max_tokens: 16,
            messages: [{ role: "user", content: "Reply with OK" }]
          })
  });

  if (response.ok) {
    return {
      connected: true,
      message: `${input.provider} API is reachable`
    };
  }

  const rawDetails = response.contentType.includes("application/json")
    ? response.text.slice(0, 400)
    : response.text.slice(0, 200);
  const details = extractProviderErrorMessage(response.parsed) ?? rawDetails;
  throw new AppError(
    "AI_API_ERROR",
    502,
    `Provider test failed: ${input.provider} ${response.url} -> ${response.status} ${
      details || response.statusText
    }`
  );
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

  const inputTokens = typeof usage.input_tokens === "number" ? usage.input_tokens : null;
  const outputTokens = typeof usage.output_tokens === "number" ? usage.output_tokens : null;
  if (inputTokens === null && outputTokens === null) return null;
  return { inputTokens, outputTokens };
}

async function callProviderDebug(input: {
  provider: Provider;
  baseUrl: string;
  apiKey: string;
  model: string;
}) {
  const response = await callProviderEndpoint({
    ...input,
    buildBody: (provider, model) =>
      provider === "openai"
        ? JSON.stringify({
            model,
            messages: [{ role: "user", content: "OK" }],
            // Keep this fast: we only need the provider's raw JSON envelope + usage (if present).
            max_tokens: 1,
            stream: false,
            temperature: 0
          })
        : JSON.stringify({
            model,
            max_tokens: 1,
            messages: [{ role: "user", content: "OK" }]
          })
  });

  if (response.ok) {
    const usage = extractUsage(input.provider, response.parsed);
    return {
      ok: true,
      provider: input.provider,
      url: response.url,
      status: response.status,
      hasUsage: Boolean(usage),
      usage,
      json: response.parsed,
      rawText: response.text.length > 80_000 ? response.text.slice(0, 80_000) : response.text
    };
  }

  const details = response.contentType.includes("application/json")
    ? response.text.slice(0, 400)
    : response.text.slice(0, 200);
  throw new AppError(
    "AI_API_ERROR",
    502,
    `Provider debug failed: ${input.provider} ${response.url} -> ${response.status} ${
      details || response.statusText
    }`
  );
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
      maxInputTokens: agent.maxInputTokens,
      maxOutputTokens: agent.maxOutputTokens,
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
      const importedContextLength =
        typeof (item as { contextLength?: unknown }).contextLength === "number"
          ? (item as { contextLength: number }).contextLength
          : null;
      const importedMaxInputTokens =
        typeof (item as { maxInputTokens?: unknown }).maxInputTokens === "number"
          ? (item as { maxInputTokens: number }).maxInputTokens
          : null;
      const importedMaxOutputTokens =
        typeof (item as { maxOutputTokens?: unknown }).maxOutputTokens === "number"
          ? (item as { maxOutputTokens: number }).maxOutputTokens
          : null;
      const inserted = await client.query<Record<string, unknown>>(
        `insert into ai_agents (
          user_id, name, provider, model, context_length, max_input_tokens, max_output_tokens, base_url,
          api_key_encrypted, api_key_masked, is_active, created_at, updated_at
        ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)
        returning *`,
        [
          session.userId,
          item.name,
          item.provider,
          item.model,
          importedContextLength,
          importedMaxInputTokens,
          importedMaxOutputTokens,
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
      "select path, created_at, updated_at from ai_agent_files where ai_agent_id = $1 order by path asc",
      [agentId]
    );
    return result.rows.map((row) => ({
      path: String(row.path),
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

export async function getAgentFile(agentId: string, path: string) {
  await getAgentById(agentId);
  try {
    const result = await query<Record<string, unknown>>(
      "select path, content, created_at, updated_at from ai_agent_files where ai_agent_id = $1 and path = $2 limit 1",
      [agentId, path]
    );
    if ((result.rowCount ?? 0) !== 1) {
      throw new AppError("NOT_FOUND", 404, "File not found");
    }
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

export async function deleteAgentFilesByPrefix(agentId: string, prefix: string) {
  await getAgentById(agentId);
  const normalized = String(prefix ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
  const like = normalized ? `${normalized.replace(/\/+$/, "")}/%` : "%";
  try {
    const result = await query(
      "delete from ai_agent_files where ai_agent_id = $1 and path like $2",
      [agentId, like]
    );
    return { deleted: Number(result.rowCount ?? 0) };
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
          user_id, name, provider, model, context_length, max_input_tokens, max_output_tokens, base_url,
          api_key_encrypted, api_key_masked, is_active, created_at, updated_at
        ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)
        returning *
      `,
      [
        session.userId,
        `${source.name} (copy)`,
        source.provider,
        source.model,
        source.contextLength,
        source.maxInputTokens,
        source.maxOutputTokens,
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
      user_id, name, provider, model, context_length, max_input_tokens, max_output_tokens, base_url,
      api_key_encrypted, api_key_masked, is_active, created_at, updated_at
    ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true,$11,$11)
    returning *`,
    [
      session.userId,
      data.name,
      data.provider,
      data.model,
      data.contextLength ?? null,
      data.maxInputTokens ?? null,
      data.maxOutputTokens ?? null,
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
  const nextIsActive =
    typeof (data as { isActive?: unknown }).isActive === "boolean"
      ? Boolean((data as { isActive: boolean }).isActive)
      : current.isActive;
  const hasContextLength = Object.prototype.hasOwnProperty.call(data, "contextLength");
  const hasMaxInputTokens = Object.prototype.hasOwnProperty.call(data, "maxInputTokens");
  const hasMaxOutputTokens = Object.prototype.hasOwnProperty.call(data, "maxOutputTokens");
  const contextLengthRaw = (data as { contextLength?: unknown }).contextLength;
  const maxInputTokensRaw = (data as { maxInputTokens?: unknown }).maxInputTokens;
  const maxOutputTokensRaw = (data as { maxOutputTokens?: unknown }).maxOutputTokens;
  const nextMaxInputTokens =
    hasMaxInputTokens
      ? typeof maxInputTokensRaw === "number"
        ? maxInputTokensRaw
        : maxInputTokensRaw === null
          ? null
          : current.maxInputTokens
      : current.maxInputTokens;
  const nextContextLength =
    hasContextLength
      ? typeof contextLengthRaw === "number"
        ? contextLengthRaw
        : contextLengthRaw === null
          ? null
          : current.contextLength
      : current.contextLength;
  const nextMaxOutputTokens =
    hasMaxOutputTokens
      ? typeof maxOutputTokensRaw === "number"
        ? maxOutputTokensRaw
        : maxOutputTokensRaw === null
          ? null
          : current.maxOutputTokens
      : current.maxOutputTokens;

  const result = await query<Record<string, unknown>>(
    `update ai_agents
      set name = $3,
          provider = $4,
          model = $5,
          context_length = $6,
          max_input_tokens = $7,
          max_output_tokens = $8,
          base_url = $9,
          api_key_encrypted = $10,
          api_key_masked = $11,
          is_active = $12,
          updated_at = $13
     where id = $1 and user_id = $2
     returning *`,
    [
      id,
      session.userId,
      data.name ?? current.name,
      data.provider ?? current.provider,
      data.model ?? current.model,
      nextContextLength,
      nextMaxInputTokens,
      nextMaxOutputTokens,
      data.baseUrl ?? current.baseUrl,
      data.apiKey ? encryptSecret(data.apiKey) : current.apiKeyEncrypted,
      data.apiKey ? maskSecret(data.apiKey) : current.apiKeyMasked,
      nextIsActive,
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
