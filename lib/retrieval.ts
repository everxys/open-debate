import { randomUUID, createHash } from "node:crypto";
import { sql } from "kysely";

import { decryptSecret, encryptSecret, maskSecret } from "@/lib/crypto";
import { ensureDb } from "@/lib/db";
import { AppError } from "@/lib/http";
import { readSession } from "@/lib/session";
import type { RetrievalConfigRecord, RetrievalProvider } from "@/lib/types";
import {
  createRetrievalConfigSchema,
  testRetrievalConfigSchema,
  updateRetrievalConfigSchema
} from "@/lib/validation";

type RetrievalChunkRecord = {
  id: string;
  debate_id: string;
  debate_agent_id: string | null;
  chunk_key: string;
  source_type: string;
  source_path: string | null;
  turn_number_start: number | null;
  turn_number_end: number | null;
  round_number: number | null;
  phase_kind: string | null;
  segment_tag: string | null;
  content: string;
  content_hash: string;
  created_at: string;
  updated_at: string;
};

type RetrievalEmbeddingRecord = {
  chunk_id: string;
  model: string;
  dimensions: number | null;
  embedding_json: unknown;
};

function normalizeRetrievalConfigRow(row: Record<string, unknown>): RetrievalConfigRecord {
  const dimensionsRaw = row.dimensions ?? null;
  const dimensions = dimensionsRaw === null ? null : Number(dimensionsRaw);
  return {
    id: String(row.id),
    userId: String(row.user_id),
    provider: "openai",
    name: String(row.name),
    model: String(row.model),
    dimensions: dimensions !== null && Number.isFinite(dimensions) && dimensions > 0 ? Math.floor(dimensions) : null,
    baseUrl: String(row.base_url),
    apiKeyEncrypted: String(row.api_key_encrypted),
    apiKeyMasked: String(row.api_key_masked),
    isActive: Boolean(row.is_active),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function toRetrievalConfigView(config: RetrievalConfigRecord) {
  return {
    id: config.id,
    name: config.name,
    provider: config.provider,
    model: config.model,
    dimensions: config.dimensions,
    baseUrl: config.baseUrl,
    apiKeyMasked: config.apiKeyMasked,
    isActive: config.isActive,
    createdAt: config.createdAt,
    updatedAt: config.updatedAt
  };
}

async function requireSessionUser() {
  const session = await readSession();
  if (!session) throw new AppError("AUTH_REQUIRED", 401, "Authentication required");
  return session;
}

function isMissingTableError(error: unknown, table: string) {
  if (typeof error !== "object" || error === null) return false;
  const anyError = error as { code?: unknown; message?: unknown };
  if (anyError.code !== "42P01") return false;
  const message = typeof anyError.message === "string" ? anyError.message : "";
  return message.toLowerCase().includes(table.toLowerCase());
}

function resolveEmbeddingUrlCandidates(provider: RetrievalProvider, baseUrl: string) {
  const normalized = baseUrl.replace(/\/+$/, "");
  const urls = [normalized];
  try {
    const parsed = new URL(normalized);
    const path = parsed.pathname.replace(/\/+$/, "");
    const endsWithV1 = path === "/v1" || path.endsWith("/v1");
    if (!endsWithV1) urls.push(`${normalized}/v1`);
  } catch {
    // ignore
  }
  return Array.from(new Set(urls)).map((root) =>
    provider === "openai" ? `${root.replace(/\/+$/, "")}/embeddings` : `${root.replace(/\/+$/, "")}/embeddings`
  );
}

async function callEmbeddingApi(input: {
  provider: RetrievalProvider;
  baseUrl: string;
  apiKey: string;
  model: string;
  dimensions?: number | null;
  texts: string[];
}) {
  const urls = resolveEmbeddingUrlCandidates(input.provider, input.baseUrl);
  let lastError: AppError | null = null;

  for (const url of urls) {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${input.apiKey}`
        },
        body: JSON.stringify({
          model: input.model,
          input: input.texts,
          ...(typeof input.dimensions === "number" && input.dimensions > 0 ? { dimensions: input.dimensions } : {})
        })
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error ?? "");
      lastError = new AppError("AI_NETWORK_ERROR", 502, `Embedding request failed for ${url}: ${message}`);
      continue;
    }

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      lastError = new AppError("AI_API_ERROR", 502, JSON.stringify(payload).slice(0, 400));
      if (response.status === 404) continue;
      throw lastError;
    }

    const data = Array.isArray((payload as { data?: unknown[] }).data) ? (payload as { data: unknown[] }).data : [];
    const embeddings = data
      .map((item) => {
        const embedding = Array.isArray((item as { embedding?: unknown }).embedding)
          ? (item as { embedding: unknown[] }).embedding
          : [];
        return embedding
          .map((value) => (typeof value === "number" && Number.isFinite(value) ? value : Number.NaN))
          .filter((value) => Number.isFinite(value));
      })
      .filter((item) => item.length > 0);

    if (embeddings.length !== input.texts.length) {
      throw new AppError("AI_API_ERROR", 502, "Embedding response shape is invalid");
    }

    return embeddings;
  }

  throw lastError ?? new AppError("AI_API_ERROR", 502, "Embedding request failed");
}

export async function getRetrievalConfig() {
  const session = await requireSessionUser();
  try {
    const db = await ensureDb();
    const row = await db
      .selectFrom("retrieval_configs")
      .selectAll()
      .where("user_id", "=", session.userId)
      .limit(1)
      .executeTakeFirst();
    if (!row) return null;
    return toRetrievalConfigView(normalizeRetrievalConfigRow(row));
  } catch (error) {
    if (isMissingTableError(error, "retrieval_configs")) return null;
    throw error;
  }
}

async function getRetrievalConfigRecordForUser(userId: string) {
  try {
    const db = await ensureDb();
    const row = await db
      .selectFrom("retrieval_configs")
      .selectAll()
      .where("user_id", "=", userId)
      .where("is_active", "=", true)
      .limit(1)
      .executeTakeFirst();
    if (!row) return null;
    return normalizeRetrievalConfigRow(row);
  } catch (error) {
    if (isMissingTableError(error, "retrieval_configs")) return null;
    throw error;
  }
}

export async function upsertRetrievalConfig(input: unknown) {
  const data = createRetrievalConfigSchema.partial({ apiKey: true }).parse(input);
  const session = await requireSessionUser();
  const now = new Date().toISOString();
  const existing = await getRetrievalConfig();

  const currentRecord = existing ? await getRetrievalConfigRecordForUser(session.userId) : null;
  if (!data.apiKey && !currentRecord) {
    throw new AppError("VALIDATION_ERROR", 400, "apiKey is required");
  }

  try {
    const nextId = currentRecord?.id ?? randomUUID();
    const provider = data.provider ?? currentRecord?.provider ?? "openai";
    const name = data.name ?? currentRecord?.name ?? "Default Retrieval";
    const model = data.model ?? currentRecord?.model ?? "";
    const dimensions = data.dimensions ?? currentRecord?.dimensions ?? null;
    const baseUrl = data.baseUrl ?? currentRecord?.baseUrl ?? "";
    const apiKeyEncrypted = data.apiKey ? encryptSecret(data.apiKey) : currentRecord?.apiKeyEncrypted ?? "";
    const apiKeyMasked = data.apiKey ? maskSecret(data.apiKey) : currentRecord?.apiKeyMasked ?? "";
    const db = await ensureDb();
    const nextRow = await db
      .insertInto("retrieval_configs")
      .values({
        id: nextId,
        user_id: session.userId,
        provider,
        name,
        model,
        dimensions,
        base_url: baseUrl,
        api_key_encrypted: apiKeyEncrypted,
        api_key_masked: apiKeyMasked,
        is_active: true,
        created_at: now,
        updated_at: now
      })
      .onConflict((oc) =>
        oc.column("user_id").doUpdateSet({
          provider,
          name,
          model,
          dimensions,
          base_url: baseUrl,
          api_key_encrypted: apiKeyEncrypted,
          api_key_masked: apiKeyMasked,
          is_active: true,
          updated_at: now
        })
      )
      .returningAll()
      .executeTakeFirstOrThrow();
    return toRetrievalConfigView(normalizeRetrievalConfigRow(nextRow));
  } catch (error) {
    throw error;
  }
}

export async function updateRetrievalConfig(input: unknown) {
  const data = updateRetrievalConfigSchema.parse(input);
  return upsertRetrievalConfig(data);
}

export async function testRetrievalConfig(input: unknown) {
  const data = testRetrievalConfigSchema.parse(input);
  const session = await requireSessionUser();
  const current = await getRetrievalConfigRecordForUser(session.userId);
  const apiKey = data.apiKey ?? (current ? decryptSecret(current.apiKeyEncrypted) : null);
  if (!apiKey) {
    throw new AppError("VALIDATION_ERROR", 400, "apiKey is required");
  }
  const embeddings = await callEmbeddingApi({
    provider: data.provider,
    baseUrl: data.baseUrl,
    apiKey,
    model: data.model,
    dimensions: data.dimensions ?? null,
    texts: ["hello retrieval"]
  });
  return {
    connected: true,
    dimensions: embeddings[0]?.length ?? null,
    message: "Embedding API is reachable"
  };
}

function normalizeText(value: string) {
  return value.replace(/\r\n/g, "\n").trim();
}

function makeHash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function splitTextIntoRetrievalChunks(content: string, maxChars = 1200, overlapChars = 150) {
  const normalized = normalizeText(content);
  if (!normalized) return [];
  if (normalized.length <= maxChars) return [normalized];
  const chunks: string[] = [];
  let start = 0;
  while (start < normalized.length) {
    const end = Math.min(normalized.length, start + maxChars);
    const slice = normalized.slice(start, end).trim();
    if (slice) chunks.push(slice);
    if (end >= normalized.length) break;
    start = Math.max(end - overlapChars, start + 1);
  }
  return chunks;
}

export async function indexDebateContextChunk(input: {
  userId: string;
  debateId: string;
  debateAgentId?: string | null;
  chunkKey: string;
  sourceType: string;
  sourcePath?: string | null;
  turnNumberStart?: number | null;
  turnNumberEnd?: number | null;
  roundNumber?: number | null;
  phaseKind?: string | null;
  segmentTag?: string | null;
  content: string;
  now: string;
}) {
  const normalizedContent = normalizeText(input.content);
  if (!normalizedContent) return null;

  const contentHash = makeHash(normalizedContent);
  let chunkRecord: RetrievalChunkRecord | null = null;

  const existing = await (async () => {
    try {
      const db = await ensureDb();
      return await db
        .selectFrom("debate_context_chunks")
        .selectAll()
        .where("debate_id", "=", input.debateId)
        .where("chunk_key", "=", input.chunkKey)
        .limit(1)
        .executeTakeFirst();
    } catch (error) {
      if (isMissingTableError(error, "debate_context_chunks")) return null;
      throw error;
    }
  })();

  if (existing) {
    chunkRecord = existing;
    if (String(chunkRecord.content_hash ?? "") === contentHash) return chunkRecord;
  }

  const chunkId = chunkRecord?.id ?? randomUUID();
  const db = await ensureDb();
  const saved = await db
    .insertInto("debate_context_chunks")
    .values({
      id: chunkId,
      debate_id: input.debateId,
      debate_agent_id: input.debateAgentId ?? null,
      chunk_key: input.chunkKey,
      source_type: input.sourceType,
      source_path: input.sourcePath ?? null,
      turn_number_start: input.turnNumberStart ?? null,
      turn_number_end: input.turnNumberEnd ?? null,
      round_number: input.roundNumber ?? null,
      phase_kind: input.phaseKind ?? null,
      segment_tag: input.segmentTag ?? null,
      content: normalizedContent,
      content_hash: contentHash,
      created_at: input.now,
      updated_at: input.now
    })
    .onConflict((oc) =>
      oc.columns(["debate_id", "chunk_key"]).doUpdateSet({
        debate_agent_id: input.debateAgentId ?? null,
        source_type: input.sourceType,
        source_path: input.sourcePath ?? null,
        turn_number_start: input.turnNumberStart ?? null,
        turn_number_end: input.turnNumberEnd ?? null,
        round_number: input.roundNumber ?? null,
        phase_kind: input.phaseKind ?? null,
        segment_tag: input.segmentTag ?? null,
        content: normalizedContent,
        content_hash: contentHash,
        updated_at: input.now
      })
    )
    .returningAll()
    .executeTakeFirstOrThrow();

  const config = await getRetrievalConfigRecordForUser(input.userId);
  if (!config || !config.isActive) return saved;

  const embeddings = await callEmbeddingApi({
    provider: config.provider,
    baseUrl: config.baseUrl,
    apiKey: decryptSecret(config.apiKeyEncrypted),
    model: config.model,
    dimensions: config.dimensions,
    texts: [normalizedContent]
  });

  await db
    .insertInto("debate_context_embeddings")
    .values({
      id: randomUUID(),
      debate_id: input.debateId,
      chunk_id: chunkId,
      model: config.model,
      dimensions: embeddings[0].length,
      embedding_json: sql`CAST(${JSON.stringify(embeddings[0])} AS jsonb)`,
      created_at: input.now,
      updated_at: input.now
    })
    .onConflict((oc) =>
      oc.column("chunk_id").doUpdateSet({
        model: config.model,
        dimensions: embeddings[0].length,
        embedding_json: sql`CAST(${JSON.stringify(embeddings[0])} AS jsonb)`,
        updated_at: input.now
      })
    )
    .execute();

  return saved;
}

function cosineSimilarity(a: number[], b: number[]) {
  const limit = Math.min(a.length, b.length);
  if (limit <= 0) return 0;
  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;
  for (let i = 0; i < limit; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    aNorm += av * av;
    bNorm += bv * bv;
  }
  if (aNorm <= 0 || bNorm <= 0) return 0;
  return dot / (Math.sqrt(aNorm) * Math.sqrt(bNorm));
}

export async function retrieveRelevantHistory(input: {
  userId: string;
  debateId: string;
  queryText: string;
  limit?: number;
  minTurnNumber?: number | null;
  maxChars?: number;
}) {
  const config = await getRetrievalConfigRecordForUser(input.userId);
  if (!config || !config.isActive) return [];

  const queryEmbedding = (
    await callEmbeddingApi({
      provider: config.provider,
      baseUrl: config.baseUrl,
      apiKey: decryptSecret(config.apiKeyEncrypted),
      model: config.model,
      dimensions: config.dimensions,
      texts: [normalizeText(input.queryText)]
    })
  )[0];

  const rows = await (async () => {
    try {
      const db = await ensureDb();
      const minTurnNumber = input.minTurnNumber ?? null;
      return await db
        .selectFrom("debate_context_chunks as c")
        .innerJoin("debate_context_embeddings as e", "e.chunk_id", "c.id")
        .selectAll("c")
        .select(["e.chunk_id", "e.model", "e.dimensions", "e.embedding_json"])
        .where("c.debate_id", "=", input.debateId)
        .where(
          sql<boolean>`${minTurnNumber}::int is null or c.turn_number_end is null or c.turn_number_end >= ${minTurnNumber}`
        )
        .orderBy("c.updated_at", "desc")
        .limit(2000)
        .execute();
    } catch (error) {
      if (
        isMissingTableError(error, "debate_context_chunks") ||
        isMissingTableError(error, "debate_context_embeddings")
      ) {
        return null;
      }
      throw error;
    }
  })();
  if (!rows) return [];

  const scored = rows
    .map((row) => {
      const embedding = Array.isArray(row.embedding_json) ? row.embedding_json : [];
      const vector = embedding
        .map((value) => (typeof value === "number" && Number.isFinite(value) ? value : Number.NaN))
        .filter((value) => Number.isFinite(value));
      if (vector.length <= 0) return null;
      return {
        chunkKey: row.chunk_key,
        sourceType: row.source_type,
        sourcePath: row.source_path,
        turnNumberStart: row.turn_number_start,
        turnNumberEnd: row.turn_number_end,
        roundNumber: row.round_number,
        content: String(row.content ?? ""),
        score: cosineSimilarity(queryEmbedding, vector)
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .sort((a, b) => b.score - a.score);

  const deduped: typeof scored = [];
  const seen = new Set<string>();
  let usedChars = 0;
  const maxChars = input.maxChars ?? 12_000;
  const limit = input.limit ?? 6;
  for (const item of scored) {
    if (item.score <= 0) continue;
    const dedupeKey = item.chunkKey || `${item.sourceType}:${item.sourcePath ?? ""}:${item.turnNumberStart ?? ""}`;
    if (seen.has(dedupeKey)) continue;
    if (deduped.length >= limit) break;
    if (usedChars >= maxChars) break;
    seen.add(dedupeKey);
    deduped.push(item);
    usedChars += item.content.length;
  }
  return deduped;
}
