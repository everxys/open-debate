type OpenRouterModelRow = {
  id: string;
  name: string;
  contextLength: number | null;
};

type Cache = { atMs: number; models: OpenRouterModelRow[] };

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
let cache: Cache | null = null;

function toPositiveInt(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  const v = Math.floor(n);
  return v > 0 ? v : null;
}

function extractContextLength(model: Record<string, unknown>) {
  const topProvider = model.top_provider as Record<string, unknown> | null | undefined;
  return (
    toPositiveInt(topProvider?.context_length) ??
    toPositiveInt(model.context_length) ??
    toPositiveInt((model as { contextLength?: unknown }).contextLength) ??
    null
  );
}

export async function listOpenRouterModels(): Promise<OpenRouterModelRow[]> {
  const now = Date.now();
  if (cache && now - cache.atMs < CACHE_TTL_MS) return cache.models;

  let response: Response;
  try {
    response = await fetch("https://openrouter.ai/api/v1/models", {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store"
    });
  } catch {
    return cache?.models ?? [];
  }

  if (!response.ok) {
    return cache?.models ?? [];
  }

  const payload = (await response.json().catch(() => null)) as { data?: unknown } | null;
  const data = payload?.data;
  const list = Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];

  const models: OpenRouterModelRow[] = [];
  for (const raw of list) {
    const id = typeof raw?.id === "string" ? raw.id : "";
    if (!id) continue;
    const name = typeof raw?.name === "string" ? raw.name : "";
    models.push({ id, name, contextLength: extractContextLength(raw) });
  }

  models.sort((a, b) => a.id.localeCompare(b.id));
  cache = { atMs: now, models };
  return models;
}

export async function getOpenRouterModelContextLength(modelId: string): Promise<number | null> {
  const id = String(modelId ?? "").trim();
  if (!id) return null;
  const models = await listOpenRouterModels();
  const hit = models.find((m) => m.id === id);
  return hit?.contextLength ?? null;
}

