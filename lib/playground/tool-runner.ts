import { buildAnthropicTools, buildOpenAiTools } from "@/lib/runtime/provider-shared";
import { PlaygroundSandbox } from "@/lib/playground/sandbox";
import type {
  PlaygroundToolExecutionTrace,
  PlaygroundToolName
} from "@/lib/playground/types";

type ExecutePlaygroundToolCallInput = {
  sandbox: PlaygroundSandbox;
  toolName: PlaygroundToolName | string;
  parsedArguments: unknown;
  traceId: string;
};

export function buildPlaygroundTools(provider: "openai" | "anthropic", enabledTools: PlaygroundToolName[]) {
  const filter = new Set(enabledTools);
  const enableVoting = enabledTools.some((toolName) => toolName.startsWith("debate_vote_"));
  const base =
    provider === "openai"
      ? buildOpenAiTools({ enableVoting, allowedOutputPaths: ["sandbox/", "outputs/"] })
      : buildAnthropicTools({ enableVoting, allowedOutputPaths: ["sandbox/", "outputs/"] });

  return base.filter((tool) => {
    const name =
      provider === "openai"
        ? String((tool as { function?: { name?: unknown } }).function?.name ?? "")
        : String((tool as { name?: unknown }).name ?? "");
    return filter.has(name as PlaygroundToolName);
  });
}

export async function executePlaygroundToolCall(
  input: ExecutePlaygroundToolCallInput
): Promise<PlaygroundToolExecutionTrace> {
  let result: unknown;

  if (input.toolName === "agent_files_list") {
    const prefix = typeof (input.parsedArguments as { prefix?: unknown }).prefix === "string"
      ? (input.parsedArguments as { prefix: string }).prefix
      : undefined;
    result = input.sandbox.listFiles("agent", prefix);
  } else if (input.toolName === "agent_files_read") {
    result = input.sandbox.readFile("agent", String((input.parsedArguments as { path?: unknown }).path ?? ""));
  } else if (input.toolName === "agent_files_search") {
    result = input.sandbox.searchFiles("agent", String((input.parsedArguments as { query?: unknown }).query ?? ""));
  } else if (input.toolName === "debate_files_read") {
    result = input.sandbox.readFile("debate", String((input.parsedArguments as { path?: unknown }).path ?? ""));
  } else if (input.toolName === "debate_files_stat") {
    result = input.sandbox.statDebateFile(String((input.parsedArguments as { path?: unknown }).path ?? ""));
  } else if (input.toolName === "debate_files_write") {
    result = input.sandbox.writeDebateFile({
      path: String((input.parsedArguments as { path?: unknown }).path ?? ""),
      content: String((input.parsedArguments as { content?: unknown }).content ?? ""),
      mode: typeof (input.parsedArguments as { mode?: unknown }).mode === "string"
        ? String((input.parsedArguments as { mode: string }).mode)
        : null,
      baseVersion: typeof (input.parsedArguments as { baseVersion?: unknown }).baseVersion === "number"
        ? Number((input.parsedArguments as { baseVersion: number }).baseVersion)
        : null,
      baseUpdatedAt: typeof (input.parsedArguments as { baseUpdatedAt?: unknown }).baseUpdatedAt === "string"
        ? String((input.parsedArguments as { baseUpdatedAt: string }).baseUpdatedAt)
        : null,
      reason: typeof (input.parsedArguments as { reason?: unknown }).reason === "string"
        ? String((input.parsedArguments as { reason: string }).reason)
        : null,
      targetHeading: typeof (input.parsedArguments as { targetHeading?: unknown }).targetHeading === "string"
        ? String((input.parsedArguments as { targetHeading: string }).targetHeading)
        : null,
      allowShrink: (input.parsedArguments as { allowShrink?: unknown }).allowShrink === true
    });
  } else if (input.toolName === "debate_vote_open") {
    result = input.sandbox.openVote({
      kind: String((input.parsedArguments as { kind?: unknown }).kind ?? "custom") === "finalization" ? "finalization" : "custom",
      title: String((input.parsedArguments as { title?: unknown }).title ?? ""),
      prompt: typeof (input.parsedArguments as { prompt?: unknown }).prompt === "string"
        ? String((input.parsedArguments as { prompt: string }).prompt)
        : undefined,
      options: Array.isArray((input.parsedArguments as { options?: unknown }).options)
        ? ((input.parsedArguments as { options: unknown[] }).options).map((item) => String(item))
        : undefined
    });
  } else if (input.toolName === "debate_vote_cast") {
    result = input.sandbox.castVote({
      choice: typeof (input.parsedArguments as { choice?: unknown }).choice === "string"
        ? String((input.parsedArguments as { choice: string }).choice)
        : undefined,
      reason: typeof (input.parsedArguments as { reason?: unknown }).reason === "string"
        ? String((input.parsedArguments as { reason: string }).reason)
        : undefined
    });
  } else if (input.toolName === "debate_vote_close") {
    result = input.sandbox.closeVote();
  } else {
    result = { error: `Unknown tool: ${input.toolName}` };
  }

  const ok =
    typeof result === "string"
      ? !result.startsWith("NOT_FOUND:") && !result.startsWith("ACCESS_DENIED:")
      : !(
          result &&
          typeof result === "object" &&
          "error" in result &&
          typeof (result as { error?: unknown }).error === "string"
        );

  return {
    id: input.traceId,
    toolName: input.toolName,
    parsedArguments: input.parsedArguments,
    result,
    ok,
    at: new Date().toISOString()
  };
}
