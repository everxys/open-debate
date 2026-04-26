export const OPENAI_COMPAT_MAX_OUTPUT_TOKENS = 32_768;
export const DEFAULT_REQUESTED_MAX_TOKENS = 65_535;

function toPositiveInt(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return Math.floor(value);
}

export function getProviderMaxOutputTokensLimit(provider: string | null | undefined) {
  return provider === "openai" ? OPENAI_COMPAT_MAX_OUTPUT_TOKENS : null;
}

export function sanitizeProviderMaxOutputTokens(
  provider: string | null | undefined,
  maxTokens: number | null | undefined
) {
  const normalized = toPositiveInt(maxTokens);
  if (normalized === null) return null;
  const limit = getProviderMaxOutputTokensLimit(provider);
  return limit === null ? normalized : Math.min(normalized, limit);
}

export function resolveProviderRequestedMaxTokens(
  provider: string | null | undefined,
  maxTokens: number | null | undefined
) {
  const normalized = sanitizeProviderMaxOutputTokens(provider, maxTokens);
  if (normalized !== null) return normalized;
  return provider === "openai" ? OPENAI_COMPAT_MAX_OUTPUT_TOKENS : DEFAULT_REQUESTED_MAX_TOKENS;
}
