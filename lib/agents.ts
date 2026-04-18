import { sql } from "kysely";

import { decryptSecret, encryptSecret, maskSecret } from "@/lib/crypto";
import { ensureDb } from "@/lib/db";
import { AppError } from "@/lib/http";
import { requireSessionUser } from "@/lib/auth";
import type { AgentConnectivityCheckStatus, AgentRecord, Provider } from "@/lib/types";
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
    lastConnectivityCheckStatus: agent.lastConnectivityCheckStatus,
    lastConnectivityCheckAt: agent.lastConnectivityCheckAt,
    lastConnectivityCheckMessage: agent.lastConnectivityCheckMessage,
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

function parseNullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function parseConnectivityCheckStatus(value: unknown): AgentConnectivityCheckStatus | null {
  return value === "reachable" || value === "failed" ? value : null;
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
    lastConnectivityCheckStatus: parseConnectivityCheckStatus(
      row.last_connectivity_check_status ?? row.lastConnectivityCheckStatus
    ),
    lastConnectivityCheckAt: parseNullableString(row.last_connectivity_check_at ?? row.lastConnectivityCheckAt),
    lastConnectivityCheckMessage: parseNullableString(
      row.last_connectivity_check_message ?? row.lastConnectivityCheckMessage
    ),
    isActive: Boolean(row.is_active),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

async function recordAgentConnectivityCheck(
  id: string,
  input: {
    status: AgentConnectivityCheckStatus;
    checkedAt?: string;
    message?: string | null;
  }
) {
  const now = new Date().toISOString();
  const db = await ensureDb();
  await db
    .updateTable("ai_agents")
    .set({
      last_connectivity_check_status: input.status,
      last_connectivity_check_at: input.checkedAt ?? now,
      last_connectivity_check_message: input.message ?? null,
      updated_at: now
    })
    .where("id", "=", id)
    .executeTakeFirst();
}

function resetConnectivityCheckFields() {
  return {
    last_connectivity_check_status: null,
    last_connectivity_check_at: null,
    last_connectivity_check_message: null
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
  const db = await ensureDb();
  const rows = await db
    .selectFrom("ai_agents")
    .selectAll()
    .where("user_id", "=", session.userId)
    .where("deleted_at", "is", null)
    .orderBy("created_at", "desc")
    .execute();
  return rows.map((row) => toAgentView(normalizeAgentRow(row as Record<string, unknown>)));
}

export async function exportAgentsPack(input: unknown) {
  const data = exportAgentsRequestSchema.parse(input);
  const session = await requireSessionUser();

  const db = await ensureDb();
  const agentRows = await db
    .selectFrom("ai_agents")
    .selectAll()
    .where("user_id", "=", session.userId)
    .where("id", "in", data.agentIds)
    .orderBy("created_at", "asc")
    .execute();
  if (agentRows.length !== data.agentIds.length) {
    throw new AppError("VALIDATION_ERROR", 400, "Selected agents are invalid");
  }

  const agents = agentRows.map((row) => normalizeAgentRow(row as Record<string, unknown>));

  let fileRows: Array<{ ai_agent_id: string; path: string; content: string }> = [];
  try {
    const filesResult = await db
      .selectFrom("ai_agent_files")
      .select(["ai_agent_id", "path", "content"])
      .where("ai_agent_id", "in", data.agentIds)
      .orderBy("ai_agent_id", "asc")
      .orderBy("path", "asc")
      .execute();
    fileRows = filesResult.map((row) => ({
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
  const db = await ensureDb();

  const createdAgents = await db.transaction().execute(async (trx) => {
    const items: AgentRecord[] = [];
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

      const inserted = await trx
        .insertInto("ai_agents")
        .values({
          user_id: session.userId,
          name: item.name,
          provider: item.provider,
          model: item.model,
          context_length: importedContextLength,
          max_input_tokens: importedMaxInputTokens,
          max_output_tokens: importedMaxOutputTokens,
          base_url: item.baseUrl,
          api_key_encrypted: encryptSecret(item.apiKey),
          api_key_masked: maskSecret(item.apiKey),
          ...resetConnectivityCheckFields(),
          is_active: item.isActive ?? true,
          created_at: now,
          updated_at: now,
          deleted_at: null
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      const created = normalizeAgentRow(inserted as Record<string, unknown>);
      items.push(created);

      try {
        for (const file of item.files ?? []) {
          await trx
            .insertInto("ai_agent_files")
            .values({
              ai_agent_id: created.id,
              path: file.path,
              content: file.content,
              created_at: now,
              updated_at: now
            })
            .onConflict((oc) =>
              oc.columns(["ai_agent_id", "path"]).doUpdateSet({
                content: file.content,
                updated_at: now
              })
            )
            .execute();
        }
      } catch (error) {
        if (isMissingTableError(error, "ai_agent_files")) {
          throw new AppError("MIGRATION_REQUIRED", 500, "Missing ai_agent_files table");
        }
        throw error;
      }
    }
    return items;
  });

  return createdAgents.map((agent) => toAgentView(agent));
}

export async function getAgentById(id: string) {
  const session = await requireSessionUser();
  const db = await ensureDb();
  const result = await db
    .selectFrom("ai_agents")
    .selectAll()
    .where("id", "=", id)
    .where("user_id", "=", session.userId)
    .executeTakeFirst();
  if (!result) {
    throw new AppError("NOT_FOUND", 404, "Agent not found");
  }
  return normalizeAgentRow(result as Record<string, unknown>);
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
    const db = await ensureDb();
    const result = await db
      .selectFrom("ai_agent_files")
      .select(["path", "created_at", "updated_at"])
      .where("ai_agent_id", "=", agentId)
      .orderBy("path", "asc")
      .execute();
    return result.map((row) => ({
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
    const db = await ensureDb();
    const result = await db
      .selectFrom("ai_agent_files")
      .select(["path", "content", "created_at", "updated_at"])
      .where("ai_agent_id", "=", agentId)
      .where("path", "=", path)
      .limit(1)
      .executeTakeFirst();
    if (!result) {
      throw new AppError("NOT_FOUND", 404, "File not found");
    }
    return {
      path: String(result.path),
      content: String(result.content ?? ""),
      createdAt: String(result.created_at),
      updatedAt: String(result.updated_at)
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
    const db = await ensureDb();
    const result = await db
      .insertInto("ai_agent_files")
      .values({
        ai_agent_id: agentId,
        path: data.path,
        content: data.content,
        created_at: now,
        updated_at: now
      })
      .onConflict((oc) =>
        oc.columns(["ai_agent_id", "path"]).doUpdateSet({
          content: data.content,
          updated_at: now
        })
      )
      .returning(["path", "content", "created_at", "updated_at"])
      .executeTakeFirstOrThrow();
    return {
      path: String(result.path),
      content: String(result.content ?? ""),
      createdAt: String(result.created_at),
      updatedAt: String(result.updated_at)
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
    const db = await ensureDb();
    const result = await db
      .deleteFrom("ai_agent_files")
      .where("ai_agent_id", "=", agentId)
      .where("path", "=", data.path)
      .executeTakeFirst();
    if (Number(result.numDeletedRows ?? 0) !== 1) {
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
    const db = await ensureDb();
    const result = await db
      .deleteFrom("ai_agent_files")
      .where("ai_agent_id", "=", agentId)
      .where("path", "like", like)
      .executeTakeFirst();
    return { deleted: Number(result.numDeletedRows ?? 0) };
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
    const db = await ensureDb();
    const exists = await db
      .selectFrom("ai_agent_files")
      .select("path")
      .where("ai_agent_id", "=", agentId)
      .where("path", "=", data.toPath)
      .limit(1)
      .executeTakeFirst();
    if (exists) {
      throw new AppError("CONFLICT", 409, "Target path already exists");
    }

    const updated = await db
      .updateTable("ai_agent_files")
      .set({
        path: data.toPath,
        updated_at: now
      })
      .where("ai_agent_id", "=", agentId)
      .where("path", "=", data.fromPath)
      .returning(["path", "content", "created_at", "updated_at"])
      .executeTakeFirst();
    if (!updated) {
      throw new AppError("NOT_FOUND", 404, "File not found");
    }
    return {
      path: String(updated.path),
      content: String(updated.content ?? ""),
      createdAt: String(updated.created_at),
      updatedAt: String(updated.updated_at)
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

  const db = await ensureDb();
  return await db.transaction().execute(async (trx) => {
    const inserted = await trx
      .insertInto("ai_agents")
      .values({
        user_id: session.userId,
        name: `${source.name} (copy)`,
        provider: source.provider,
        model: source.model,
        context_length: source.contextLength,
        max_input_tokens: source.maxInputTokens,
        max_output_tokens: source.maxOutputTokens,
        base_url: source.baseUrl,
        api_key_encrypted: source.apiKeyEncrypted,
        api_key_masked: source.apiKeyMasked,
        ...resetConnectivityCheckFields(),
        is_active: source.isActive,
        created_at: now,
        updated_at: now,
        deleted_at: null
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const created = normalizeAgentRow(inserted as Record<string, unknown>);

    try {
      await trx.executeQuery(sql`
        insert into ai_agent_files (ai_agent_id, path, content, created_at, updated_at)
        select ${created.id}, path, content, ${now}, ${now}
        from ai_agent_files
        where ai_agent_id = ${source.id}
      `.compile(trx));
    } catch (error) {
      if (!isMissingTableError(error, "ai_agent_files")) {
        throw error;
      }
    }

    return toAgentView(created);
  });
}

export async function createAgent(input: unknown) {
  const data = createAgentSchema.parse(input);
  const session = await requireSessionUser();
  const now = new Date().toISOString();
  const db = await ensureDb();
  const result = await db
    .insertInto("ai_agents")
    .values({
      user_id: session.userId,
      name: data.name,
      provider: data.provider,
      model: data.model,
      context_length: data.contextLength ?? null,
      max_input_tokens: data.maxInputTokens ?? null,
      max_output_tokens: data.maxOutputTokens ?? null,
      base_url: data.baseUrl,
      api_key_encrypted: encryptSecret(data.apiKey),
      api_key_masked: maskSecret(data.apiKey),
      ...resetConnectivityCheckFields(),
      is_active: true,
      created_at: now,
      updated_at: now,
      deleted_at: null
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return toAgentView(normalizeAgentRow(result as Record<string, unknown>));
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
  const hasProvider = Object.prototype.hasOwnProperty.call(data, "provider");
  const hasModel = Object.prototype.hasOwnProperty.call(data, "model");
  const hasBaseUrl = Object.prototype.hasOwnProperty.call(data, "baseUrl");
  const hasApiKey = Object.prototype.hasOwnProperty.call(data, "apiKey");
  const contextLengthRaw = (data as { contextLength?: unknown }).contextLength;
  const maxInputTokensRaw = (data as { maxInputTokens?: unknown }).maxInputTokens;
  const maxOutputTokensRaw = (data as { maxOutputTokens?: unknown }).maxOutputTokens;
  const shouldResetConnectivityCheck =
    (hasProvider && data.provider !== current.provider) ||
    (hasModel && data.model !== current.model) ||
    (hasBaseUrl && data.baseUrl !== current.baseUrl) ||
    (hasApiKey && typeof data.apiKey === "string" && data.apiKey.trim().length > 0);
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

  const db = await ensureDb();
  const result = await db
    .updateTable("ai_agents")
    .set({
      name: data.name ?? current.name,
      provider: data.provider ?? current.provider,
      model: data.model ?? current.model,
      context_length: nextContextLength,
      max_input_tokens: nextMaxInputTokens,
      max_output_tokens: nextMaxOutputTokens,
      base_url: data.baseUrl ?? current.baseUrl,
      api_key_encrypted: data.apiKey ? encryptSecret(data.apiKey) : current.apiKeyEncrypted,
      api_key_masked: data.apiKey ? maskSecret(data.apiKey) : current.apiKeyMasked,
      ...(shouldResetConnectivityCheck
        ? resetConnectivityCheckFields()
        : {
            last_connectivity_check_status: current.lastConnectivityCheckStatus,
            last_connectivity_check_at: current.lastConnectivityCheckAt,
            last_connectivity_check_message: current.lastConnectivityCheckMessage
          }),
      is_active: nextIsActive,
      updated_at: new Date().toISOString()
    })
    .where("id", "=", id)
    .where("user_id", "=", session.userId)
    .returningAll()
    .executeTakeFirst();

  if (!result) {
    throw new AppError("NOT_FOUND", 404, "Agent not found");
  }

  return toAgentView(normalizeAgentRow(result as Record<string, unknown>));
}

export async function deleteAgent(id: string) {
  const session = await requireSessionUser();
  const db = await ensureDb();
  const relation = await db
    .selectFrom("debate_agents as da")
    .innerJoin("debates as d", "d.id", "da.debate_id")
    .select("da.id")
    .where("da.ai_agent_id", "=", id)
    .where("d.user_id", "=", session.userId)
    .where("d.status", "in", ["pending", "running", "paused"])
    .limit(1)
    .executeTakeFirst();
  if (relation) {
    throw new AppError("CONFLICT", 409, "Agent is already used by an active debate");
  }

  const now = new Date().toISOString();
  const result = await db
    .updateTable("ai_agents")
    .set({
      deleted_at: now,
      is_active: false,
      updated_at: now
    })
    .where("id", "=", id)
    .where("user_id", "=", session.userId)
    .where("deleted_at", "is", null)
    .returning("id")
    .executeTakeFirst();
  if (!result) {
    throw new AppError("NOT_FOUND", 404, "Agent not found");
  }
}

export async function testAgentConnection(id: string) {
  const agent = await getAgentById(id);
  try {
    const result = await callProviderHealthCheck({
      provider: agent.provider,
      baseUrl: agent.baseUrl,
      apiKey: decryptSecret(agent.apiKeyEncrypted),
      model: agent.model
    });
    const message = `${agent.name} is reachable`;
    await recordAgentConnectivityCheck(id, { status: "reachable", message });
    return { ...result, message };
  } catch (error) {
    const message = error instanceof AppError ? error.message : "连接校验失败";
    await recordAgentConnectivityCheck(id, { status: "failed", message });
    throw error;
  }
}

export async function testAgentConnectionDebug(id: string) {
  const agent = await getAgentById(id);
  try {
    const result = await callProviderDebug({
      provider: agent.provider,
      baseUrl: agent.baseUrl,
      apiKey: decryptSecret(agent.apiKeyEncrypted),
      model: agent.model
    });
    await recordAgentConnectivityCheck(id, { status: "reachable", message: `${agent.name} debug check passed` });
    return { ...result, agentId: agent.id, agentName: agent.name, model: agent.model };
  } catch (error) {
    const message = error instanceof AppError ? error.message : "连接校验失败";
    await recordAgentConnectivityCheck(id, { status: "failed", message });
    throw error;
  }
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
