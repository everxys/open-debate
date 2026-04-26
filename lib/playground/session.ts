import { randomUUID } from "node:crypto";

import { decryptSecret } from "@/lib/crypto";
import { getAgentById } from "@/lib/agents";
import { AppError } from "@/lib/http";
import { createServerLogger } from "@/lib/logger/server";
import type {
  PlaygroundAssistantMessage,
  PlaygroundChecklistStage,
  PlaygroundRunAssertions,
  PlaygroundRunDiagnostics,
  PlaygroundRunRequest,
  PlaygroundSandboxFileSnapshot,
  PlaygroundToolCallTrace,
  PlaygroundToolExecutionTrace
} from "@/lib/playground/types";
import { PlaygroundSandbox } from "@/lib/playground/sandbox";
import { runPlaygroundHarnessSession } from "@/lib/playground/harness";
import { buildPlaygroundTools, executePlaygroundToolCall } from "@/lib/playground/tool-runner";
import { ensureQuotaAvailableOrThrowAppError } from "@/lib/quota-control";
import { resolveChatUrl, openAiChatOnce } from "@/lib/runtime/provider-openai";
import { buildResponseFormatInstructions } from "@/lib/runtime/provider-shared";
import { withOptionalMaxTokens } from "@/lib/runtime/workflow-phase";
import type { AgentRecord } from "@/lib/types";

const playgroundLogger = createServerLogger("playground");

type PlaygroundRequestKind = "playground_checklist" | "playground_free_run";

type PlaygroundStageReporter = (stage: PlaygroundChecklistStage, message: string) => Promise<void>;

type OpenAiMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
};

type AnthropicBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string };

type AnthropicMessage = {
  role: "user" | "assistant";
  content: AnthropicBlock[] | string;
};

function hasSandboxChanged(before: PlaygroundSandboxFileSnapshot[], after: PlaygroundSandboxFileSnapshot[]) {
  if (before.length !== after.length) return true;
  const beforeMap = new Map(before.map((item) => [`${item.scope}:${item.path}`, item] as const));
  for (const item of after) {
    const previous = beforeMap.get(`${item.scope}:${item.path}`);
    if (!previous) return true;
    if (previous.version !== item.version || previous.content !== item.content || previous.updatedAt !== item.updatedAt) {
      return true;
    }
  }
  return false;
}

function buildQuotaInput(agent: AgentRecord, requestKind: PlaygroundRequestKind) {
  return {
    userId: agent.userId,
    usageControlMode: agent.usageControlMode,
    quotaProfileId: agent.quotaProfileId,
    requestKind,
    agentId: agent.id,
    agentName: agent.name
  };
}

function extractOpenAiUsageTotals(items: unknown[]) {
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let hasPrompt = false;
  let hasCompletion = false;
  let hasTotal = false;
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const usage = item as {
      prompt_tokens?: unknown;
      completion_tokens?: unknown;
      total_tokens?: unknown;
      input_tokens?: unknown;
      output_tokens?: unknown;
    };
    if (typeof usage.prompt_tokens === "number") {
      promptTokens += usage.prompt_tokens;
      hasPrompt = true;
    } else if (typeof usage.input_tokens === "number") {
      promptTokens += usage.input_tokens;
      hasPrompt = true;
    }
    if (typeof usage.completion_tokens === "number") {
      completionTokens += usage.completion_tokens;
      hasCompletion = true;
    } else if (typeof usage.output_tokens === "number") {
      completionTokens += usage.output_tokens;
      hasCompletion = true;
    }
    if (typeof usage.total_tokens === "number") {
      totalTokens += usage.total_tokens;
      hasTotal = true;
    }
  }
  return {
    promptTokens: hasPrompt ? promptTokens : null,
    completionTokens: hasCompletion ? completionTokens : null,
    totalTokens: hasTotal ? totalTokens : hasPrompt || hasCompletion ? promptTokens + completionTokens : null
  };
}

function buildAssertions(input: {
  enabledTools: string[];
  toolExecutions: PlaygroundToolExecutionTrace[];
  finalText: string;
  sandboxBefore: PlaygroundSandboxFileSnapshot[];
  sandboxAfter: PlaygroundSandboxFileSnapshot[];
}) {
  const calledAnyTool = input.toolExecutions.length > 0;
  const expectedWrite = input.enabledTools.includes("debate_files_write");
  const calledExpectedTool = expectedWrite
    ? input.toolExecutions.some((item) => item.toolName === "debate_files_write")
    : calledAnyTool;
  const beforeByPath = new Map(input.sandboxBefore.filter((item) => item.scope === "debate").map((item) => [item.path, item]));
  const createdOrUpdatedOutput = input.sandboxAfter.some((item) => {
    if (item.scope !== "debate" || !item.path.startsWith("outputs/")) return false;
    const before = beforeByPath.get(item.path);
    return !before || before.version !== item.version || before.content !== item.content;
  });
  const lowerText = input.finalText.toLowerCase();
  const promisedWriteWithoutTool =
    !input.toolExecutions.some((item) => item.toolName === "debate_files_write") &&
    (lowerText.includes("write") || lowerText.includes("写入") || lowerText.includes("保存"));

  return {
    calledAnyTool,
    calledExpectedTool,
    createdOrUpdatedOutput,
    promisedWriteWithoutTool
  } satisfies PlaygroundRunAssertions;
}

async function runOpenAiPlayground(input: {
  agent: AgentRecord;
  apiKey: string;
  request: PlaygroundRunRequest;
  sandbox: PlaygroundSandbox;
  requestKind: PlaygroundRequestKind;
  onStageChange?: PlaygroundStageReporter;
}) {
  const tools = buildPlaygroundTools("openai", input.request.enabledTools);
  const messages: OpenAiMessage[] = [];
  if (input.request.systemPrompt.trim()) {
    messages.push({ role: "system", content: input.request.systemPrompt.trim() });
  }
  messages.push({
    role: "user",
    content: `${input.request.userPrompt.trim()}\n\n${buildResponseFormatInstructions()}`
  });

  const assistantMessages: PlaygroundAssistantMessage[] = [];
  const toolCalls: PlaygroundToolCallTrace[] = [];
  const toolExecutions: PlaygroundToolExecutionTrace[] = [];
  const usageItems: unknown[] = [];
  let finalText = "";
  let finishReason: string | null = null;
  let reportedModelOutput = false;
  let reportedExecutingTools = false;
  let reportedSandboxChanged = false;

  for (let round = 0; round <= input.request.maxToolRounds; round += 1) {
    if (round === 0) {
      await input.onStageChange?.("requesting_model", "已发起 provider 请求，等待模型首个响应");
    }
    const requestBody = withOptionalMaxTokens(
      {
        model: input.agent.model,
        messages,
        ...(tools.length > 0 ? { tools, tool_choice: "auto" as const } : {})
      },
      input.agent.maxOutputTokens ?? 2048,
      input.agent.provider
    );
    const response = await openAiChatOnce({
      url: resolveChatUrl(input.agent),
      apiKey: input.apiKey,
      quotaRequest: buildQuotaInput(input.agent, input.requestKind),
      body: requestBody
    });

    usageItems.push(response.usage);
    finishReason = response.finishReason ?? null;
    const assistantText = String(response.content ?? "");
    finalText = assistantText;
    if (!reportedModelOutput) {
      reportedModelOutput = true;
      await input.onStageChange?.(
        "receiving_model_output",
        response.toolCalls.length > 0 ? `已收到模型输出，准备执行 ${response.toolCalls.length} 个工具` : "已收到模型输出，等待最终校验"
      );
    }
    assistantMessages.push({
      role: "assistant",
      content: assistantText,
      finishReason,
      toolCallCount: response.toolCalls.length,
      at: new Date().toISOString()
    });

    if (!response.toolCalls.length) {
      return { assistantMessages, toolCalls, toolExecutions, usageItems, finalText, finishReason };
    }

    if (!reportedExecutingTools) {
      reportedExecutingTools = true;
      await input.onStageChange?.("executing_tools", `开始执行 ${response.toolCalls.length} 个工具`);
    }

    messages.push({
      role: "assistant",
      content: assistantText,
      tool_calls: response.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: call.function
      }))
    });

    for (const call of response.toolCalls) {
      let parsedArguments: unknown = {};
      try {
        parsedArguments = JSON.parse(call.function.arguments || "{}");
      } catch {
        parsedArguments = {};
      }
      const traceId = call.id || randomUUID();
      const callTrace: PlaygroundToolCallTrace = {
        id: traceId,
        toolName: call.function.name,
        rawArguments: call.function.arguments || "{}",
        parsedArguments,
        at: new Date().toISOString()
      };
      toolCalls.push(callTrace);
      playgroundLogger.info("playground.tool_call", {
        agentId: input.agent.id,
        agentName: input.agent.name,
        toolName: call.function.name,
        traceId
      });

      const sandboxBeforeTool = input.sandbox.snapshot();
      const execution = await executePlaygroundToolCall({
        sandbox: input.sandbox,
        toolName: call.function.name,
        parsedArguments,
        traceId
      });
      toolExecutions.push(execution);
      if (!reportedSandboxChanged) {
        const sandboxAfterTool = input.sandbox.snapshot();
        if (hasSandboxChanged(sandboxBeforeTool, sandboxAfterTool)) {
          reportedSandboxChanged = true;
          await input.onStageChange?.("sandbox_changed", "检测到 sandbox 文件新增或修改");
        }
      }
      playgroundLogger.info("playground.tool_result", {
        agentId: input.agent.id,
        agentName: input.agent.name,
        toolName: call.function.name,
        traceId,
        ok: execution.ok
      });

      messages.push({
        role: "tool",
        tool_call_id: call.id,
        name: call.function.name,
        content: typeof execution.result === "string" ? execution.result : JSON.stringify(execution.result)
      });
    }
  }

  return {
    assistantMessages,
    toolCalls,
    toolExecutions,
    usageItems,
    finalText,
    finishReason: finishReason ?? "tool_round_limit"
  };
}

async function runAnthropicPlayground(input: {
  agent: AgentRecord;
  apiKey: string;
  request: PlaygroundRunRequest;
  sandbox: PlaygroundSandbox;
  requestKind: PlaygroundRequestKind;
  onStageChange?: PlaygroundStageReporter;
}) {
  const tools = buildPlaygroundTools("anthropic", input.request.enabledTools);
  const messages: AnthropicMessage[] = [
    {
      role: "user",
      content: [{ type: "text", text: `${input.request.userPrompt.trim()}\n\n${buildResponseFormatInstructions()}` }]
    }
  ];

  const assistantMessages: PlaygroundAssistantMessage[] = [];
  const toolCalls: PlaygroundToolCallTrace[] = [];
  const toolExecutions: PlaygroundToolExecutionTrace[] = [];
  const usageItems: unknown[] = [];
  let finalText = "";
  let finishReason: string | null = null;
  let reportedModelOutput = false;
  let reportedExecutingTools = false;
  let reportedSandboxChanged = false;

  for (let round = 0; round <= input.request.maxToolRounds; round += 1) {
    if (round === 0) {
      await input.onStageChange?.("requesting_model", "已发起 provider 请求，等待模型首个响应");
    }
    await ensureQuotaAvailableOrThrowAppError(buildQuotaInput(input.agent, input.requestKind));
    const requestBody = withOptionalMaxTokens(
      {
        model: input.agent.model,
        system: input.request.systemPrompt.trim() || undefined,
        messages,
        ...(tools.length > 0 ? { tools } : {})
      },
      input.agent.maxOutputTokens ?? 2048,
      input.agent.provider
    );
    const response = await fetch(resolveChatUrl(input.agent), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": input.apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify(requestBody)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new AppError("AI_API_ERROR", 502, JSON.stringify(payload).slice(0, 400));
    }

    usageItems.push(payload?.usage ?? null);
    finishReason = typeof payload?.stop_reason === "string" ? payload.stop_reason : null;
    const contentBlocks = Array.isArray(payload?.content) ? (payload.content as AnthropicBlock[]) : [];
    const textContent = contentBlocks
      .filter((block): block is Extract<AnthropicBlock, { type: "text" }> => block.type === "text")
      .map((block) => block.text)
      .join("");
    finalText = textContent;
    const toolUseBlocks = contentBlocks.filter(
      (block): block is Extract<AnthropicBlock, { type: "tool_use" }> => block.type === "tool_use"
    );
    if (!reportedModelOutput) {
      reportedModelOutput = true;
      await input.onStageChange?.(
        "receiving_model_output",
        toolUseBlocks.length > 0 ? `已收到模型输出，准备执行 ${toolUseBlocks.length} 个工具` : "已收到模型输出，等待最终校验"
      );
    }
    assistantMessages.push({
      role: "assistant",
      content: textContent,
      finishReason,
      toolCallCount: toolUseBlocks.length,
      at: new Date().toISOString()
    });

    if (!toolUseBlocks.length) {
      return { assistantMessages, toolCalls, toolExecutions, usageItems, finalText, finishReason };
    }

    if (!reportedExecutingTools) {
      reportedExecutingTools = true;
      await input.onStageChange?.("executing_tools", `开始执行 ${toolUseBlocks.length} 个工具`);
    }

    messages.push({ role: "assistant", content: contentBlocks });
    const toolResults: AnthropicBlock[] = [];
    for (const call of toolUseBlocks) {
      const traceId = call.id || randomUUID();
      const callTrace: PlaygroundToolCallTrace = {
        id: traceId,
        toolName: call.name,
        rawArguments: JSON.stringify(call.input ?? {}),
        parsedArguments: call.input ?? {},
        at: new Date().toISOString()
      };
      toolCalls.push(callTrace);
      playgroundLogger.info("playground.tool_call", {
        agentId: input.agent.id,
        agentName: input.agent.name,
        toolName: call.name,
        traceId
      });

      const sandboxBeforeTool = input.sandbox.snapshot();
      const execution = await executePlaygroundToolCall({
        sandbox: input.sandbox,
        toolName: call.name,
        parsedArguments: call.input ?? {},
        traceId
      });
      toolExecutions.push(execution);
      if (!reportedSandboxChanged) {
        const sandboxAfterTool = input.sandbox.snapshot();
        if (hasSandboxChanged(sandboxBeforeTool, sandboxAfterTool)) {
          reportedSandboxChanged = true;
          await input.onStageChange?.("sandbox_changed", "检测到 sandbox 文件新增或修改");
        }
      }
      playgroundLogger.info("playground.tool_result", {
        agentId: input.agent.id,
        agentName: input.agent.name,
        toolName: call.name,
        traceId,
        ok: execution.ok
      });

      toolResults.push({
        type: "tool_result",
        tool_use_id: call.id,
        content: typeof execution.result === "string" ? execution.result : JSON.stringify(execution.result)
      });
    }
    messages.push({ role: "user", content: toolResults });
  }

  return {
    assistantMessages,
    toolCalls,
    toolExecutions,
    usageItems,
    finalText,
    finishReason: finishReason ?? "tool_round_limit"
  };
}

export async function runPlaygroundSession(
  request: PlaygroundRunRequest,
  options?: {
    requestKind?: PlaygroundRequestKind;
    onStageChange?: PlaygroundStageReporter;
  }
) {
  const agent = await getAgentById(request.agentId);
  if (!agent.isActive) {
    throw new AppError("VALIDATION_ERROR", 400, "只能使用已启用的 AI 配置运行 Playground");
  }

  const requestKind = options?.requestKind ?? "playground_free_run";
  const sandbox = new PlaygroundSandbox(request.sandboxFiles);
  const sandboxFilesBefore = sandbox.snapshot();
  const apiKey = decryptSecret(agent.apiKeyEncrypted);
  playgroundLogger.info("playground.run_started", {
    agentId: agent.id,
    agentName: agent.name,
    requestKind,
    enabledTools: request.enabledTools,
    sandboxFileCountBefore: sandboxFilesBefore.length
  });

  try {
    const startedAt = Date.now();
    const result =
      request.useHarnessActions
        ? await runPlaygroundHarnessSession({
            agent,
            apiKey,
            request,
            sandbox,
            onStageChange: options?.onStageChange
          })
        : agent.provider === "openai"
          ? await runOpenAiPlayground({
              agent,
              apiKey,
              request,
              sandbox,
              requestKind,
              onStageChange: options?.onStageChange
            })
          : await runAnthropicPlayground({
              agent,
              apiKey,
              request,
              sandbox,
              requestKind,
              onStageChange: options?.onStageChange
            });
    const sandboxFilesAfter = sandbox.snapshot();
    const assertions = buildAssertions({
      enabledTools: request.enabledTools,
      toolExecutions: result.toolExecutions,
      finalText: result.finalText,
      sandboxBefore: sandboxFilesBefore,
      sandboxAfter: sandboxFilesAfter
    });
    const diagnostics: PlaygroundRunDiagnostics = {
      provider: agent.provider,
      finishReason: result.finishReason,
      toolCallCount: result.toolCalls.length,
      sandboxFileCountBefore: sandboxFilesBefore.length,
      sandboxFileCountAfter: sandboxFilesAfter.length,
      assertions
    };
    const usageTotals = extractOpenAiUsageTotals(result.usageItems);

    playgroundLogger.info("playground.run_finished", {
      agentId: agent.id,
      agentName: agent.name,
      requestKind,
      enabledTools: request.enabledTools,
      finishReason: result.finishReason,
      toolCallCount: result.toolCalls.length,
      sandboxFileCountBefore: sandboxFilesBefore.length,
      sandboxFileCountAfter: sandboxFilesAfter.length
    });

    return {
      assistantMessages: result.assistantMessages,
      toolCalls: result.toolCalls,
      toolExecutions: result.toolExecutions,
      finalText: result.finalText,
      finishReason: result.finishReason,
      usage: {
        requests: result.usageItems.length,
        ...usageTotals,
        raw: result.usageItems
      },
      sandboxFilesBefore,
      sandboxFilesAfter,
      diagnostics,
      latencyMs: Date.now() - startedAt
    };
  } catch (error) {
    playgroundLogger.error("playground.run_failed", {
      agentId: agent.id,
      agentName: agent.name,
      requestKind,
      enabledTools: request.enabledTools,
      error
    });
    throw error;
  }
}
