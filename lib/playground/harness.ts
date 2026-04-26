import { randomUUID } from "node:crypto";

import { AppError } from "@/lib/http";
import { PlaygroundSandbox } from "@/lib/playground/sandbox";
import type {
  PlaygroundAssistantMessage,
  PlaygroundChecklistStage,
  PlaygroundRunRequest,
  PlaygroundToolCallTrace,
  PlaygroundToolExecutionTrace
} from "@/lib/playground/types";
import { resolveChatUrl, openAiChatOnce } from "@/lib/runtime/provider-openai";
import {
  buildRuntimeActionInstructions,
  detectRuntimeActionLoop,
  makeRuntimeActionLoopRecord,
  parseRuntimeHarnessAction,
  pushRuntimeActionLoopRecord,
  type RuntimeHarnessAction
} from "@/lib/runtime/runtime-action-harness";
import { buildResponseFormatInstructions } from "@/lib/runtime/provider-shared";
import { withOptionalMaxTokens } from "@/lib/runtime/workflow-phase";
import type { AgentRecord } from "@/lib/types";

type PlaygroundStageReporter = (stage: PlaygroundChecklistStage, message: string) => Promise<void>;

function buildHarnessResultMessage(result: unknown, allowedActions: string[]) {
  return [
    "HARNESS_ACTION_RESULT",
    typeof result === "string" ? result : JSON.stringify(result),
    `NEXT_ALLOWED_ACTIONS: ${allowedActions.join(", ") || "none"}`,
    "If another action is needed, output exactly one new ```debate-action``` block. Otherwise return the final Markdown answer."
  ].join("\n\n");
}

function buildHarnessPolicy(request: PlaygroundRunRequest, sandbox: PlaygroundSandbox) {
  const knownTargetPaths = sandbox.snapshot().filter((item) => item.scope === "debate").map((item) => item.path).slice(0, 10);
  return {
    allowedActions: request.enabledHarnessActions,
    preferredWriteAction: request.enabledHarnessActions.find((item) => item.startsWith("write_")) ?? null,
    reason: "Playground harness capability check.",
    knownTargetPaths,
    knownWritableTargetPaths: knownTargetPaths.filter((path) => path.startsWith("sandbox/") || path.startsWith("outputs/"))
  };
}

function searchSandboxBothScopes(sandbox: PlaygroundSandbox, query: string) {
  return [
    ...sandbox.searchFiles("agent", query).map((item) => ({ ...item, scope: "agent" })),
    ...sandbox.searchFiles("debate", query).map((item) => ({ ...item, scope: "debate" }))
  ].slice(0, 8);
}

async function executeHarnessAction(input: {
  sandbox: PlaygroundSandbox;
  action: RuntimeHarnessAction;
  traceToolName: string;
  traceId: string;
}): Promise<PlaygroundToolExecutionTrace> {
  const action = input.action;
  let result: unknown;
  if (action.action === "list") {
    result = [
      ...input.sandbox.listFiles("agent", action.prefix ?? undefined).map((path) => ({ path, scope: "agent" })),
      ...input.sandbox.listFiles("debate", action.prefix ?? undefined).map((path) => ({ path, scope: "debate" }))
    ];
  } else if (action.action === "search") {
    result = searchSandboxBothScopes(input.sandbox, action.query);
  } else if (action.action === "read") {
    const debateContent = input.sandbox.readFile("debate", action.path);
    const agentContent = input.sandbox.readFile("agent", action.path);
    result =
      !String(debateContent).startsWith("NOT_FOUND:")
        ? { ok: true, scope: "debate", path: action.path, content: debateContent }
        : !String(agentContent).startsWith("NOT_FOUND:")
          ? { ok: true, scope: "agent", path: action.path, content: agentContent }
          : { error: `NOT_FOUND: ${action.path}` };
  } else if (action.action === "vote_cast") {
    result = input.sandbox.castVote({
      choice: action.choice,
      reason: action.reason ?? undefined
    });
  } else {
    const stat = input.sandbox.statDebateFile(action.path);
    result = input.sandbox.writeDebateFile({
      path: action.path,
      content: action.content,
      mode:
        action.action === "write_replace"
          ? "replace"
          : action.action === "write_append"
            ? "append"
            : "section_merge",
      baseVersion: stat.exists ? stat.version : null,
      baseUpdatedAt: stat.exists ? stat.updatedAt : null,
      reason: null,
      targetHeading: action.action === "write_section" ? action.heading : null,
      allowShrink: false
    });
  }
  return {
    id: input.traceId,
    toolName: input.traceToolName,
    parsedArguments: action,
    result,
    ok: !(
      result &&
      typeof result === "object" &&
      "error" in result &&
      typeof (result as { error?: unknown }).error === "string"
    ),
    at: new Date().toISOString()
  };
}

export async function runPlaygroundHarnessSession(input: {
  agent: AgentRecord;
  apiKey: string;
  request: PlaygroundRunRequest;
  sandbox: PlaygroundSandbox;
  onStageChange?: PlaygroundStageReporter;
}) {
  if (input.request.enabledHarnessActions.includes("vote_cast")) {
    input.sandbox.openVote({
      kind: "custom",
      title: "Sandbox Vote Round",
      prompt: "Choose the strongest option",
      options: ["Option Alpha", "Option Beta"]
    });
  }
  const policy = buildHarnessPolicy(input.request, input.sandbox);
  const systemPrompt = [
    input.request.systemPrompt.trim(),
    buildRuntimeActionInstructions({
      policy,
      allowedOutputPaths: ["sandbox/", "outputs/"]
    })
  ]
    .filter(Boolean)
    .join("\n\n");
  const assistantMessages: PlaygroundAssistantMessage[] = [];
  const toolCalls: PlaygroundToolCallTrace[] = [];
  const toolExecutions: PlaygroundToolExecutionTrace[] = [];
  const usageItems: unknown[] = [];
  const messages: Array<Record<string, unknown>> = [
    { role: "system", content: systemPrompt },
    { role: "user", content: `${input.request.userPrompt.trim()}\n\n${buildResponseFormatInstructions()}` }
  ];
  let finalText = "";
  let finishReason: string | null = null;
  let loopState = { records: [] as ReturnType<typeof makeRuntimeActionLoopRecord>[] };

  for (let round = 0; round <= input.request.maxToolRounds; round += 1) {
    if (round === 0) {
      await input.onStageChange?.("requesting_model", "已发起 harness provider 请求");
    }
    if (input.agent.provider === "openai") {
      const response = await openAiChatOnce({
        url: resolveChatUrl(input.agent),
        apiKey: input.apiKey,
        quotaRequest: {
          userId: input.agent.userId,
          usageControlMode: input.agent.usageControlMode,
          quotaProfileId: input.agent.quotaProfileId,
          requestKind: "playground_checklist",
          agentId: input.agent.id,
          agentName: input.agent.name
        },
        body: withOptionalMaxTokens(
          {
            model: input.agent.model,
            messages
          },
          input.agent.maxOutputTokens ?? 2048,
          input.agent.provider
        )
      });
      usageItems.push(response.usage);
      finishReason = response.finishReason ?? null;
      finalText = String(response.content ?? "");
    } else {
      const response = await fetch(resolveChatUrl(input.agent), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": input.apiKey,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify(
          withOptionalMaxTokens(
            {
              model: input.agent.model,
              system: systemPrompt,
              messages: messages
                .filter((item) => item.role !== "system")
                .map((item) => ({ role: item.role === "assistant" ? "assistant" : "user", content: String(item.content ?? "") }))
            },
            input.agent.maxOutputTokens ?? 2048,
            input.agent.provider
          )
        )
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new AppError("AI_API_ERROR", 502, JSON.stringify(payload).slice(0, 400));
      }
      usageItems.push(payload?.usage ?? null);
      finishReason = typeof payload?.stop_reason === "string" ? payload.stop_reason : null;
      finalText = Array.isArray(payload?.content)
        ? payload.content
            .filter((item: { type?: unknown }) => item.type === "text")
            .map((item: { text?: unknown }) => String(item.text ?? ""))
            .join("\n")
        : "";
    }

    await input.onStageChange?.("receiving_model_output", "已收到 harness 模型输出");
    assistantMessages.push({
      role: "assistant",
      content: finalText,
      finishReason,
      toolCallCount: toolExecutions.length,
      at: new Date().toISOString()
    });

    const parsed = parseRuntimeHarnessAction(finalText, input.request.enabledHarnessActions);
    if ("error" in parsed) {
      throw new AppError("AI_ACTION_PROTOCOL_ERROR", 502, String(parsed.error));
    }
    if (!parsed.action) {
      return { assistantMessages, toolCalls, toolExecutions, usageItems, finalText, finishReason };
    }

    const loopRecord = makeRuntimeActionLoopRecord(parsed.action);
    const repeatedPattern = detectRuntimeActionLoop(loopState, loopRecord);
    if (repeatedPattern) {
      throw new AppError("AI_TOOL_LOOP_DETECTED", 502, repeatedPattern);
    }
    loopState = pushRuntimeActionLoopRecord(loopState, loopRecord);

    const traceId = randomUUID();
    toolCalls.push({
      id: traceId,
      toolName: input.request.enabledTools[0] ?? "harness",
      rawArguments: JSON.stringify(parsed.action),
      parsedArguments: parsed.action,
      at: new Date().toISOString()
    });
    await input.onStageChange?.("executing_tools", `执行 harness action: ${parsed.action.action}`);
    const execution = await executeHarnessAction({
      sandbox: input.sandbox,
      action: parsed.action,
      traceToolName: input.request.enabledTools[0] ?? "harness",
      traceId
    });
    toolExecutions.push(execution);
    messages.push({ role: "assistant", content: finalText });
    messages.push({
      role: "user",
      content: buildHarnessResultMessage(execution.result, input.request.enabledHarnessActions)
    });
  }

  return { assistantMessages, toolCalls, toolExecutions, usageItems, finalText, finishReason };
}
