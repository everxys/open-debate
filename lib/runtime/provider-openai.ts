import { emitDebateLiveEvent } from "@/lib/debate-live";
import { AppError } from "@/lib/http";
import type { AgentRecord } from "@/lib/types";

export function resolveChatUrl(agent: AgentRecord) {
  const normalized = agent.baseUrl.replace(/\/+$/, "");
  return agent.provider === "openai"
    ? `${normalized}/chat/completions`
    : `${normalized}/messages`;
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
  url: string;
  apiKey: string;
  body: Record<string, unknown>;
}) {
  const response = await fetch(args.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${args.apiKey}`
    },
    body: JSON.stringify({
      ...args.body,
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
    throw new AppError("AI_API_ERROR", 502, JSON.stringify(payload).slice(0, 400));
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
      function: {
        name: value.function?.name ?? "",
        arguments: value.function?.arguments ?? "{}"
      }
    }))
    .filter((x) => x.function.name);

  return { content: contentParts.join(""), toolCalls, usage: lastUsage, finishReason: lastFinishReason };
}

export async function openAiChatOnce(args: { url: string; apiKey: string; body: Record<string, unknown> }) {
  const response = await fetch(args.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${args.apiKey}`
    },
    body: JSON.stringify(args.body)
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new AppError("AI_API_ERROR", 502, JSON.stringify(payload).slice(0, 400));
  }

  const message = payload?.choices?.[0]?.message ?? null;
  const content = String(message?.content ?? "");
  const toolCalls = Array.isArray(message?.tool_calls)
    ? (message.tool_calls as Array<{ id?: unknown; function?: { name?: unknown; arguments?: unknown } }>).map((c) => ({
        id: typeof c.id === "string" ? c.id : "",
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

export async function openAiUsageProbe(args: { url: string; apiKey: string; body: Record<string, unknown> }) {
  const response = await fetch(args.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${args.apiKey}`
    },
    body: JSON.stringify({
      ...args.body,
      max_tokens: 1,
      stream: false,
      tool_choice: "none",
      temperature: 0
    })
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new AppError("AI_API_ERROR", 502, JSON.stringify(payload).slice(0, 400));
  }
  return payload?.usage ?? null;
}
