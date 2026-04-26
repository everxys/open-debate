import { sanitizeProviderMaxOutputTokens } from "@/lib/token-limits";
import type { AgentRecord, DebateRecord, DebateTurnRecord, StructuredOutput } from "@/lib/types";
import type { NormalizedDebateWorkflow } from "@/lib/workflow";

export function aggregateConsensusByLastRound(
  turns: DebateTurnRecord[],
  participantCount: number,
  consensus?: NormalizedDebateWorkflow["consensus"] | null
) {
  if (participantCount <= 0) participantCount = 1;

  const enabled = consensus?.enabled === undefined ? true : Boolean(consensus.enabled);
  const minAvgScoreRaw = consensus?.minAvgScore ?? 8;
  const minAvgScore = typeof minAvgScoreRaw === "number" && Number.isFinite(minAvgScoreRaw) ? minAvgScoreRaw : 8;
  const requireAllSeats =
    consensus?.requireAllSeats === undefined ? true : Boolean(consensus.requireAllSeats);

  if (!enabled) {
    return { reached: false, leadingSolution: null as string | null, score: 0 };
  }

  if (turns.length < participantCount) {
    return { reached: false, leadingSolution: null as string | null, score: 0 };
  }
  if (turns.length % participantCount !== 0) {
    return { reached: false, leadingSolution: null as string | null, score: 0 };
  }

  const lastRoundTurns = turns.slice(-participantCount);
  const solutions = lastRoundTurns.map((t) => t.structuredOutput?.proposed_solution ?? null);
  if (solutions.some((s) => !s || !String(s).trim())) {
    return { reached: false, leadingSolution: null as string | null, score: 0 };
  }

  const normalized = solutions.map((s) => String(s));
  const first = normalized[0];
  const unanimous = normalized.every((s) => s === first);
  if (!unanimous) {
    return { reached: false, leadingSolution: first, score: 0 };
  }

  const scores = lastRoundTurns
    .map((t) => t.structuredOutput?.agreement_score)
    .filter((x): x is number => typeof x === "number");
  const avg = scores.length > 0 ? scores.reduce((sum, item) => sum + item, 0) / scores.length : 0;
  const reached = (requireAllSeats ? scores.length === participantCount : scores.length > 0) && avg >= minAvgScore;

  return { reached, leadingSolution: first, score: Number((avg / 10).toFixed(3)) };
}

export function parseResponse(raw: string): {
  content: string;
  structuredOutput: StructuredOutput | null;
  parseStatus: "ok" | "fallback";
} {
  const trimmed = raw.trim();

  function extractJsonCandidate(text: string) {
    const value = text.trim();
    if (value.startsWith("{") && value.endsWith("}")) return value;
    if (!value.startsWith("```")) return null;

    const fenceEnd = value.indexOf("\n");
    if (fenceEnd <= 0) return null;
    const closeFence = value.lastIndexOf("```");
    if (closeFence <= fenceEnd) return null;
    if (closeFence < value.length - 3) return null;
    return value.slice(fenceEnd + 1, closeFence).trim();
  }

  function toStructuredOutput(parsed: unknown): StructuredOutput | null {
    if (typeof parsed !== "object" || parsed === null) return null;
    const obj = parsed as Record<string, unknown>;

    const proposed_solution =
      typeof obj.proposed_solution === "string" ? obj.proposed_solution.trim() : undefined;

    const agreement_score = typeof obj.agreement_score === "number" ? obj.agreement_score : undefined;

    const argumentsRaw = Array.isArray(obj.arguments) ? obj.arguments : [];
    const argumentsParsed = argumentsRaw
      .map((item) => {
        if (typeof item !== "object" || item === null) return null;
        const arg = item as Record<string, unknown>;
        const type: "support" | "rebuttal" = arg.type === "rebuttal" ? "rebuttal" : "support";
        const content = typeof arg.content === "string" ? arg.content.trim() : "";
        const target = typeof arg.target === "string" ? arg.target.trim() : undefined;
        if (!content) return null;
        return { type, content, ...(target ? { target } : {}) };
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item));

    const hasAny = Boolean(proposed_solution || agreement_score !== undefined || argumentsParsed.length > 0);
    if (!hasAny) return null;

    return {
      proposed_solution,
      agreement_score,
      arguments: argumentsParsed.length > 0 ? argumentsParsed : undefined
    };
  }

  const jsonCandidate = extractJsonCandidate(trimmed);
  if (jsonCandidate) {
    try {
      const parsed = JSON.parse(jsonCandidate);
      const structuredOutput = toStructuredOutput(parsed);
      if (structuredOutput) {
        const lines: string[] = [];
        if (structuredOutput.proposed_solution) {
          lines.push(`## 方案`);
          lines.push(structuredOutput.proposed_solution);
          lines.push("");
        }

        const args = structuredOutput.arguments ?? [];
        const support = args.filter((arg) => arg.type === "support");
        const rebuttal = args.filter((arg) => arg.type === "rebuttal");

        if (support.length > 0) {
          lines.push("## 支持点");
          for (const arg of support) lines.push(`- ${arg.content}`);
          lines.push("");
        }
        if (rebuttal.length > 0) {
          lines.push("## 反对点");
          for (const arg of rebuttal) lines.push(`- ${arg.content}`);
          lines.push("");
        }

        if (typeof structuredOutput.agreement_score === "number") {
          lines.push("## 同意度");
          lines.push(String(structuredOutput.agreement_score));
          lines.push("");
        }

        return {
          content: lines.join("\n").trim() || raw,
          structuredOutput,
          parseStatus: "ok" as const
        };
      }
    } catch {
      return { content: raw, structuredOutput: null, parseStatus: "fallback" as const };
    }
  }

  return { content: raw, structuredOutput: null, parseStatus: "ok" as const };
}

function normalizeTimestampString(value: unknown) {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function normalizeNullableTimestampString(value: unknown) {
  if (value === null || value === undefined) return null;
  return normalizeTimestampString(value);
}

export function normalizeDebateTurnRow(row: Record<string, unknown>): DebateTurnRecord {
  return {
    id: String(row.id),
    debateId: String(row.debate_id),
    aiAgentId: String(row.ai_agent_id),
    debateAgentId: row.debate_agent_id ? String(row.debate_agent_id) : null,
    seatNumber: row.seat_number === null ? null : Number(row.seat_number),
    turnNumber: Number(row.turn_number),
    content: String(row.content),
    structuredOutput: (row.structured_output as StructuredOutput | null) ?? null,
    parseStatus: row.parse_status as "ok" | "fallback",
    tokenUsed: Number(row.token_used),
    responseTimeMs: row.response_time_ms === null ? null : Number(row.response_time_ms),
    retryCount: Number(row.retry_count),
    errorCode: (row.error_code as string | null) ?? null,
    createdAt: normalizeTimestampString(row.created_at)
  };
}

export function normalizeDebateRow(row: Record<string, unknown>): DebateRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    question: String(row.question),
    status: row.status as DebateRecord["status"],
    maxTurns: Number(row.max_turns),
    currentTurn: Number(row.current_turn),
    tokenUsed: Number(row.token_used),
    enableSharedFacts: row.enable_shared_facts === undefined ? true : Boolean(row.enable_shared_facts),
    isShared: row.is_shared === undefined ? false : Boolean(row.is_shared),
    consensusReached: Boolean(row.consensus_reached),
    consensusSummary: (row.consensus_summary as DebateRecord["consensusSummary"]) ?? null,
    workflowPhaseKind: (row.workflow_phase_kind as DebateRecord["workflowPhaseKind"]) ?? null,
    workflowPhaseTitle: (row.workflow_phase_title as string | null) ?? null,
    workflowPhaseRound: row.workflow_phase_round === null ? null : Number(row.workflow_phase_round),
    runtimeNoticeKind: (row.runtime_notice_kind as DebateRecord["runtimeNoticeKind"]) ?? null,
    runtimeNoticeMessage: (row.runtime_notice_message as string | null) ?? null,
    runtimeNoticeAt: normalizeNullableTimestampString(row.runtime_notice_at),
    lastErrorCode: (row.last_error_code as string | null) ?? null,
    lastErrorMessage: (row.last_error_message as string | null) ?? null,
    ignoredRuntimeErrorSignature: (row.ignored_runtime_error_signature as string | null) ?? null,
    ignoredRuntimeErrorAt: normalizeNullableTimestampString(row.ignored_runtime_error_at),
    autoRecoverOnceOnFailed: Boolean(row.auto_recover_once_on_failed),
    autoRecoverOnceUsedAt: normalizeNullableTimestampString(row.auto_recover_once_used_at),
    startedAt: normalizeNullableTimestampString(row.started_at),
    finishedAt: normalizeNullableTimestampString(row.finished_at),
    stoppedReason: (row.stopped_reason as string | null) ?? null,
    createdAt: normalizeTimestampString(row.created_at),
    updatedAt: normalizeTimestampString(row.updated_at)
  };
}

export function normalizeAgentRow(row: Record<string, unknown>): AgentRecord {
  const contextLengthRaw = row.context_length ?? row.contextLength ?? null;
  const contextLength = contextLengthRaw === null ? null : Number(contextLengthRaw);
  const maxInputTokensRaw = row.max_input_tokens ?? row.maxInputTokens ?? null;
  const maxInputTokens = maxInputTokensRaw === null ? null : Number(maxInputTokensRaw);
  const maxOutputTokensRaw = row.max_output_tokens ?? row.maxOutputTokens ?? null;
  const maxOutputTokens =
    maxOutputTokensRaw === null ? null : sanitizeProviderMaxOutputTokens(String(row.provider ?? ""), Number(maxOutputTokensRaw));
  return {
    id: String(row.id),
    userId: String(row.user_id),
    name: String(row.name),
    provider: row.provider as AgentRecord["provider"],
    model: String(row.model),
    contextLength:
      contextLength !== null && Number.isFinite(contextLength) && contextLength > 0 ? Math.floor(contextLength) : null,
    maxInputTokens:
      maxInputTokens !== null && Number.isFinite(maxInputTokens) && maxInputTokens > 0
        ? Math.floor(maxInputTokens)
        : null,
    maxOutputTokens:
      maxOutputTokens !== null && Number.isFinite(maxOutputTokens) && maxOutputTokens > 0
        ? Math.floor(maxOutputTokens)
        : null,
    baseUrl: String(row.base_url),
    apiKeyEncrypted: String(row.api_key_encrypted),
    apiKeyMasked: String(row.api_key_masked),
    lastConnectivityCheckStatus: (row.last_connectivity_check_status as AgentRecord["lastConnectivityCheckStatus"]) ?? null,
    lastConnectivityCheckAt: normalizeNullableTimestampString(row.last_connectivity_check_at),
    lastConnectivityCheckMessage: (row.last_connectivity_check_message as string | null) ?? null,
    usageControlMode:
      row.usage_control_mode === "coding_plan" || row.usageControlMode === "coding_plan" ? "coding_plan" : "none",
    quotaProfileId:
      typeof (row.quota_profile_id ?? row.quotaProfileId) === "string"
        ? String(row.quota_profile_id ?? row.quotaProfileId)
        : null,
    isActive: row.is_active === undefined ? true : Boolean(row.is_active),
    createdAt: normalizeTimestampString(row.created_at),
    updatedAt: normalizeTimestampString(row.updated_at)
  };
}
