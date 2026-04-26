import { emitDebateLiveEvent } from "@/lib/debate-live";
import { AppError } from "@/lib/http";
import { ensureQuotaReservationOrDelay, type QuotaReservationInput } from "@/lib/quota-control";
import type { AgentRecord } from "@/lib/types";

export function resolveChatUrl(agent: AgentRecord) {
  const normalized = agent.baseUrl.replace(/\/+$/, "");
  return agent.provider === "openai"
    ? `${normalized}/chat/completions`
    : `${normalized}/messages`;
}

function normalizeOpenAiChatBody(body: Record<string, unknown>) {
  const messages = Array.isArray(body.messages)
    ? body.messages.map((message) => {
        if (!message || typeof message !== "object") return message;
        const record = message as Record<string, unknown>;
        if (!Array.isArray(record.tool_calls)) return message;
        return {
          ...record,
          tool_calls: record.tool_calls.map((toolCall) => {
            if (!toolCall || typeof toolCall !== "object") return toolCall;
            const call = toolCall as Record<string, unknown>;
            return {
              ...call,
              type: typeof call.type === "string" && call.type ? call.type : "function"
            };
          })
        };
      })
    : body.messages;

  return { ...body, messages };
}

function toOpenAiApiError(response: Response, payload: unknown) {
  const payloadText = JSON.stringify(payload).slice(0, 400);
  const errorObject =
    payload && typeof payload === "object" && "error" in payload && payload.error && typeof payload.error === "object"
      ? (payload.error as Record<string, unknown>)
      : null;
  const providerCode = typeof errorObject?.code === "string" ? errorObject.code : "";
  const providerType = typeof errorObject?.type === "string" ? errorObject.type : "";
  const providerMessage = typeof errorObject?.message === "string" ? errorObject.message : "";
  const normalizedCode = `${providerCode} ${providerType} ${providerMessage}`.toLowerCase();
  const looksInvalidKey =
    response.status === 401 ||
    normalizedCode.includes("invalid_api_key") ||
    normalizedCode.includes("invalid access token") ||
    normalizedCode.includes("token expired") ||
    normalizedCode.includes("incorrect api key") ||
    normalizedCode.includes("unauthorized");
  if (looksInvalidKey) {
    return new AppError("AI_INVALID_API_KEY", 401, payloadText);
  }
  return new AppError("AI_API_ERROR", 502, payloadText);
}

async function readSseJsonLines(response: Response, onData: (data: string) => void) {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const raw of lines) {
      const line = raw.trimEnd();
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data) continue;
      onData(data);
    }
  }

  const tail = buffer.trim();
  if (tail.startsWith("data:")) {
    const data = tail.slice(5).trim();
    if (data) onData(data);
  }
}

export async function openAiChatStream(args: {
  debateId: string;
  messageNumber: number;
  roundNumber: number;
  agentName: string;
  baseRoleName?: string | null;
  url: string;
  apiKey: string;
  body: Record<string, unknown>;
  quotaRequest?: QuotaReservationInput;
}) {
  const body = normalizeOpenAiChatBody(args.body);
  if (args.quotaRequest) {
    await ensureQuotaReservationOrDelay(args.quotaRequest);
  }
  const response = await fetch(args.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${args.apiKey}`
    },
    body: JSON.stringify({
      ...body,
      stream: true,
      stream_options: { include_usage: true }
    })
  });

  const contentParts: string[] = [];
  const toolCallsByIndex = new Map<
    number,
    { id?: string; function?: { name?: string; arguments?: string } }
  >();
  let lastUsage: unknown = null;
  let lastFinishReason: string | null = null;

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw toOpenAiApiError(response, payload);
  }

  await readSseJsonLines(response, (data) => {
    if (data === "[DONE]") return;
    let payload: any = null;
    try {
      payload = JSON.parse(data);
    } catch {
      return;
    }

    const delta = payload?.choices?.[0]?.delta;
    const text = typeof delta?.content === "string" ? delta.content : "";
    if (text) {
      contentParts.push(text);
      emitDebateLiveEvent(args.debateId, {
        type: "chunk",
        debateId: args.debateId,
        turnNumber: args.messageNumber,
        agentName: args.agentName,
        baseRoleName: args.baseRoleName ?? null,
        text,
        at: new Date().toISOString()
      });
    }

    const toolDeltas = Array.isArray(delta?.tool_calls) ? delta.tool_calls : [];
    for (const td of toolDeltas) {
      const index = Number(td?.index ?? NaN);
      if (!Number.isFinite(index)) continue;
      const existing = toolCallsByIndex.get(index) ?? {};
      const next = { ...existing };
      if (typeof td?.id === "string") next.id = td.id;
      const fn = td?.function ?? {};
      next.function = next.function ?? {};
      if (typeof fn?.name === "string") next.function.name = fn.name;
      if (typeof fn?.arguments === "string") {
        next.function.arguments = (next.function.arguments ?? "") + fn.arguments;
      }
      toolCallsByIndex.set(index, next);
    }

    if (payload?.usage) lastUsage = payload.usage;
    const finishReason = payload?.choices?.[0]?.finish_reason;
    if (typeof finishReason === "string" && finishReason) lastFinishReason = finishReason;
  });

  const toolCalls = [...toolCallsByIndex.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, value]) => ({
      id: value.id ?? "",
      type: "function",
      function: {
        name: value.function?.name ?? "",
        arguments: value.function?.arguments ?? "{}"
      }
    }))
    .filter((x) => x.function.name);

  return { content: contentParts.join(""), toolCalls, usage: lastUsage, finishReason: lastFinishReason };
}

export async function openAiChatOnce(args: {
  url: string;
  apiKey: string;
  body: Record<string, unknown>;
  quotaRequest?: QuotaReservationInput;
}) {
  if (args.quotaRequest) {
    await ensureQuotaReservationOrDelay(args.quotaRequest);
  }
  const response = await fetch(args.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${args.apiKey}`
    },
    body: JSON.stringify(normalizeOpenAiChatBody(args.body))
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw toOpenAiApiError(response, payload);
  }

  const message = payload?.choices?.[0]?.message ?? null;
  const content = String(message?.content ?? "");
  const toolCalls = Array.isArray(message?.tool_calls)
    ? (message.tool_calls as Array<{ id?: unknown; function?: { name?: unknown; arguments?: unknown } }>).map((c) => ({
        id: typeof c.id === "string" ? c.id : "",
        type: "function",
        function: {
          name: typeof c.function?.name === "string" ? c.function.name : "",
          arguments: typeof c.function?.arguments === "string" ? c.function.arguments : "{}"
        }
      })).filter((c) => c.function.name)
    : [];
  const usage = payload?.usage ?? null;
  const finishReason = typeof payload?.choices?.[0]?.finish_reason === "string" ? payload.choices[0].finish_reason : null;
  return { content, toolCalls, usage, finishReason };
}

export async function openAiUsageProbe(args: {
  url: string;
  apiKey: string;
  body: Record<string, unknown>;
  quotaRequest?: QuotaReservationInput;
}) {
  const body = normalizeOpenAiChatBody(args.body);
  if (args.quotaRequest) {
    await ensureQuotaReservationOrDelay(args.quotaRequest);
  }
  const response = await fetch(args.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${args.apiKey}`
    },
    body: JSON.stringify({
      ...body,
      max_tokens: 1,
      stream: false,
      tool_choice: "none",
      temperature: 0
    })
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw toOpenAiApiError(response, payload);
  }
  return payload?.usage ?? null;
}
