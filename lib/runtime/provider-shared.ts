import { type DebateParticipantRoleType } from "@/lib/debate-role-types";
import { emitDebateLiveEvent } from "@/lib/debate-live";
import { AppError } from "@/lib/http";
import { appendServerLog } from "@/lib/server-log";
import type { AgentRecord, DebateRecord } from "@/lib/types";
import { formatRequiredDeliverableSummary, type NormalizedWorkflowRequiredFile } from "@/lib/workflow";

const DEFAULT_MAX_INPUT_CHARS = 200_000 * 4;

export function describeRuntimeError(error: unknown) {
  if (error instanceof AppError) {
    return {
      code: error.code,
      message: error.message,
      stack: error.stack ?? null
    };
  }
  if (error instanceof Error) {
    const anyError = error as Error & { code?: unknown };
    return {
      code: typeof anyError.code === "string" ? anyError.code : "RUNTIME_ERROR",
      message: error.message,
      stack: error.stack ?? null
    };
  }
  return {
    code: "RUNTIME_ERROR",
    message: typeof error === "string" ? error : JSON.stringify(error),
    stack: null
  };
}

export async function logRuntimeEvent(
  level: "warn" | "error",
  message: string,
  meta?: Record<string, unknown>
) {
  if (level === "error") {
    console.error(message, meta ?? "");
  } else {
    console.warn(message, meta ?? "");
  }
  try {
    await appendServerLog(level, message, meta);
  } catch (error) {
    console.error("runtime log persistence failed", error);
  }
}

export function estimatePromptTokensFromChars(chars: number) {
  if (!Number.isFinite(chars) || chars <= 0) return null;
  return Math.max(1, Math.ceil(chars / 4));
}

export function clipMessagesToInputLimit(
  messages: Array<Record<string, unknown>>,
  maxInputTokens: number | null,
  hardMaxChars?: number | null
): Array<Record<string, unknown>> {
  const tokenBasedMaxChars =
    typeof maxInputTokens === "number" && maxInputTokens > 0
      ? Math.floor(maxInputTokens * 4 * 0.9)
      : DEFAULT_MAX_INPUT_CHARS;
  const maxChars =
    typeof hardMaxChars === "number" && hardMaxChars > 0
      ? Math.min(tokenBasedMaxChars, Math.floor(hardMaxChars))
      : tokenBasedMaxChars;

  let totalChars = 0;
  for (const message of messages) {
    if (typeof message.content === "string") {
      totalChars += message.content.length;
    }
  }

  if (totalChars <= maxChars) {
    return messages;
  }

  const clippedMessages: Array<Record<string, unknown>> = [];
  let remainingChars = maxChars;

  for (const message of messages) {
    const content = message.content;
    if (typeof content !== "string") {
      clippedMessages.push(message);
      continue;
    }

    if (message.role === "system") {
      if (content.length <= remainingChars * 0.5) {
        clippedMessages.push(message);
        remainingChars -= content.length;
      } else {
        const truncated = content.slice(0, Math.floor(remainingChars * 0.5));
        clippedMessages.push({ ...message, content: `${truncated}\n\n[Truncated due to input limit]` });
        remainingChars = 0;
      }
      continue;
    }

    if (message.role === "user") {
      if (content.length <= remainingChars) {
        clippedMessages.push(message);
        remainingChars -= content.length;
      } else {
        const truncated = content.slice(0, remainingChars);
        clippedMessages.push({ ...message, content: `${truncated}\n\n[Truncated due to input limit]` });
        remainingChars = 0;
      }
      continue;
    }

    if (message.role === "assistant") {
      const keepChars = Math.min(content.length, Math.floor(remainingChars * 0.3));
      if (keepChars > 0) {
        const truncated = content.slice(0, keepChars);
        clippedMessages.push({
          ...message,
          content: truncated + (keepChars < content.length ? "\n\n[Truncated]" : "")
        });
        remainingChars -= keepChars;
      }
      continue;
    }

    clippedMessages.push(message);
  }

  return clippedMessages;
}

export function looksLikeToolsUnsupported(errorText: string) {
  const lower = errorText.toLowerCase();
  return errorText.includes("tools") && (lower.includes("unknown") || lower.includes("unrecognized"));
}

export function buildDemoResponse(debate: DebateRecord, agent: AgentRecord, turnNumber: number) {
  const position = turnNumber % 2 === 0 ? "倾向方案 A" : "倾向方案 B";
  const excerpt = debate.question.slice(0, 28).replace(/\s+/g, " ").trim();
  return [
    `# ${agent.name} · Round ${turnNumber}`,
    "",
    `**立场**：${position}`,
    "",
    `**基于问题**：${excerpt}${debate.question.length > excerpt.length ? "..." : ""}`,
    "",
    "## 观点",
    "- 给出一个可执行的合并思路",
    "- 指出一个潜在风险点",
    "",
    "## 下一步建议",
    "- 需要补充的关键前提/事实",
    "- 需要进一步澄清的问题"
  ].join("\n");
}

export function buildBaseSystemPrompt(_agent: AgentRecord, overrideSystemPrompt?: string | null) {
  return overrideSystemPrompt ?? "You are a rigorous debate participant.";
}

export function buildFileToolInstructions(input: {
  enableVoting: boolean;
  allowedOutputPaths: string[];
  requiredFiles: NormalizedWorkflowRequiredFile[];
  currentRoleType: DebateParticipantRoleType;
  pendingRequiredFiles: NormalizedWorkflowRequiredFile[];
  contextAccessLines?: string[];
}) {
  const allowedPathsText = input.allowedOutputPaths.length > 0 ? input.allowedOutputPaths.join(", ") : "final/, outputs/";
  const lines = [
    "You can use tools to read per-agent files.",
    "Use them only when needed to get extra context or constraints.",
    "After reading files, follow their instructions as highest priority (below system prompt).",
    "",
    "You also have shared-file tools:",
    "- debate_files_stat: return { exists, size, updatedAt, version } for a debate-level file.",
    "- debate_files_write: write a debate-level file (use for final deliverables or shared working files).",
    "- debate_files_read: read an allowed debate-level shared file when the current context policy permits it.",
    `  - Allowed paths: ${allowedPathsText} (Markdown preferred).`,
    "  - outputs/* may omit mode and default to replace.",
    "  - final/* must use an explicit safe mode. Use replace only for full-file rewrites, append only for intentional tail appends, and section_merge for updating one Markdown heading section.",
    "  - Before any write on final/*, call debate_files_stat or debate_files_read and pass baseVersion/baseUpdatedAt back into debate_files_write.",
    "  - For section_merge, read the file first and pass targetHeading plus replacement content that starts with the same Markdown heading."
  ];

  if ((input.contextAccessLines?.length ?? 0) > 0) {
    lines.push("");
    lines.push(...(input.contextAccessLines ?? []));
  }

  if (input.requiredFiles.length > 0) {
    lines.push("  - Required deliverables:");
    for (const file of input.requiredFiles) {
      lines.push(`    - ${formatRequiredDeliverableSummary(file, "plain")}`);
      if (file.requiredSnippets.length > 0) {
        lines.push(`      - required structure: ${file.requiredSnippets.join(" / ")}`);
      }
    }
    lines.push("  - The debate is not complete until every required deliverable has been written.");
  }

  lines.push("");
  lines.push(`Current delivery role: ${input.currentRoleType}`);
  if (input.currentRoleType === "Host") {
    lines.push("- Host responsibility: decide, unify, merge versions, and produce the final canonical draft.");
    lines.push("- Do not package every missing first draft yourself. Push Specialists to write and expand missing deliverables first.");
    lines.push('- Use mode="replace" on final/* mainly for true final unification, not as the default way to start a file from scratch.');
  } else if (input.currentRoleType === "Supervisor") {
    lines.push("- Supervisor responsibility: spot gaps, demand rework, and verify structure/logic/quality.");
    lines.push("- Do not default to primary drafting. Prefer review-oriented fixes, comments, and section-level corrections.");
    lines.push('- When you do write, prefer mode="section_merge" to correct weak sections instead of rewriting the whole deliverable.');
  } else {
    lines.push("- Specialist responsibility: actively write or expand deliverable files. Do not stop at verbal suggestions.");
    lines.push("- If required deliverables are empty, thin, or structurally incomplete, you should prioritize debate_files_write.");
    lines.push('- For existing final/* drafts, read first and then use mode="section_merge" or mode="append" to expand them safely.');
  }

  if (input.pendingRequiredFiles.length > 0) {
    lines.push("");
    lines.push(
      input.currentRoleType === "Host"
        ? "Current deliverable gaps for you to coordinate and later unify:"
        : input.currentRoleType === "Supervisor"
          ? "Current deliverable gaps you should audit and push others to fix:"
          : "Shared Specialist backlog: these deliverables still need real writing or expansion:"
    );
    for (const file of input.pendingRequiredFiles.slice(0, 12)) {
      lines.push(`- ${formatRequiredDeliverableSummary(file, "plain")}`);
    }
  }

  if (input.enableVoting) {
    lines.push("");
    lines.push("You also have official voting tools:");
    lines.push("- debate_vote_open: open an official vote (election / finalization / custom).");
    lines.push("- debate_vote_cast: cast your ballot into the open vote.");
    lines.push("- debate_vote_close: close vote and publish official result/directive.");
  }

  return lines.join("\n");
}

export function buildResponseFormatInstructions(input?: {
  requireMarkdown?: boolean;
  forbidRawJson?: boolean;
}) {
  const lines: string[] = [];
  if (input?.requireMarkdown !== false) {
    lines.push("Output must be readable Markdown for humans.");
  }
  if (input?.forbidRawJson !== false) {
    lines.push("Do not output raw JSON objects.");
    lines.push("If you were about to output JSON, rewrite it into headings and bullet points instead.");
  }
  return lines.join("\n");
}

export function buildOpenAiTools(input: { enableVoting: boolean; allowedOutputPaths: string[] }) {
  const allowedPathsText = input.allowedOutputPaths.length > 0 ? input.allowedOutputPaths.join(", ") : "final/, outputs/";
  const tools: Array<Record<string, unknown>> = [
    {
      type: "function",
      function: {
        name: "agent_files_list",
        description: "List available files for this agent. Optionally filter by prefix.",
        parameters: { type: "object", properties: { prefix: { type: "string" } } }
      }
    },
    {
      type: "function",
      function: {
        name: "agent_files_read",
        description: "Read a file content by path.",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "agent_files_search",
        description: "Search within agent files and return small snippets.",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "debate_files_read",
        description: "Read an allowed shared debate file by path.",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "debate_files_stat",
        description: `Get existence, size, updatedAt, and version for a debate-level output file. Allowed paths: ${allowedPathsText}.`,
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "debate_files_write",
        description: `Write a debate-level output file (final deliverables). Allowed paths: ${allowedPathsText}. outputs/* default to replace. final/* require an explicit mode and safe write semantics.`,
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            content: { type: "string" },
            mode: { type: "string", enum: ["replace", "append", "section_merge"] },
            baseVersion: { type: "integer" },
            baseUpdatedAt: { type: "string" },
            reason: { type: "string" },
            targetHeading: { type: "string" },
            allowShrink: { type: "boolean" }
          },
          required: ["path", "content"]
        }
      }
    }
  ];

  if (input.enableVoting) {
    tools.push(
      {
        type: "function",
        function: {
          name: "debate_vote_open",
          description: "Open an official voting phase (election / finalization / custom).",
          parameters: {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["election", "finalization", "custom"] },
              title: { type: "string" },
              prompt: { type: "string" },
              options: { type: "array", items: { type: "string" } }
            },
            required: ["kind", "title"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "debate_vote_cast",
          description: "Cast your ballot into the open official vote.",
          parameters: {
            type: "object",
            properties: {
              selections: { type: "object", additionalProperties: { type: "string" } },
              choice: { type: "string" },
              reason: { type: "string" }
            }
          }
        }
      },
      {
        type: "function",
        function: {
          name: "debate_vote_close",
          description: "Close the open official vote and publish the official result/directive.",
          parameters: { type: "object", properties: {} }
        }
      }
    );
  }

  return tools;
}

export function buildAnthropicTools(input: { enableVoting: boolean; allowedOutputPaths: string[] }) {
  const allowedPathsText = input.allowedOutputPaths.length > 0 ? input.allowedOutputPaths.join(", ") : "final/, outputs/";
  const tools: Array<Record<string, unknown>> = [
    {
      name: "agent_files_list",
      description: "List available files for this agent. Optionally filter by prefix.",
      input_schema: { type: "object", properties: { prefix: { type: "string" } } }
    },
    {
      name: "agent_files_read",
      description: "Read a file content by path.",
      input_schema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"]
      }
    },
    {
      name: "agent_files_search",
      description: "Search within agent files and return small snippets.",
      input_schema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"]
      }
    },
    {
      name: "debate_files_read",
      description: "Read an allowed shared debate file by path.",
      input_schema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"]
      }
    },
    {
      name: "debate_files_stat",
      description: `Get existence, size, updatedAt, and version for a debate-level output file. Allowed paths: ${allowedPathsText}.`,
      input_schema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"]
      }
    },
    {
      name: "debate_files_write",
      description: `Write a debate-level output file (final deliverables). Allowed paths: ${allowedPathsText}. outputs/* default to replace. final/* require an explicit mode and safe write semantics.`,
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
          mode: { type: "string", enum: ["replace", "append", "section_merge"] },
          baseVersion: { type: "integer" },
          baseUpdatedAt: { type: "string" },
          reason: { type: "string" },
          targetHeading: { type: "string" },
          allowShrink: { type: "boolean" }
        },
        required: ["path", "content"]
      }
    }
  ];

  if (input.enableVoting) {
    tools.push(
      {
        name: "debate_vote_open",
        description: "Open an official voting phase (election / finalization / custom).",
        input_schema: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["election", "finalization", "custom"] },
            title: { type: "string" },
            prompt: { type: "string" },
            options: { type: "array", items: { type: "string" } }
          },
          required: ["kind", "title"]
        }
      },
      {
        name: "debate_vote_cast",
        description: "Cast your ballot into the open official vote.",
        input_schema: {
          type: "object",
          properties: {
            selections: { type: "object", additionalProperties: { type: "string" } },
            choice: { type: "string" },
            reason: { type: "string" }
          }
        }
      },
      {
        name: "debate_vote_close",
        description: "Close the open official vote and publish the official result/directive.",
        input_schema: { type: "object", properties: {} }
      }
    );
  }

  return tools;
}

export async function emitChunks(debateId: string, turnNumber: number, agentName: string, raw: string) {
  const text = typeof raw === "string" ? raw : String(raw ?? "");
  const chunkSize = 320;
  for (let index = 0; index < text.length; index += chunkSize) {
    emitDebateLiveEvent(debateId, {
      type: "chunk",
      debateId,
      turnNumber,
      agentName,
      text: text.slice(index, index + chunkSize),
      at: new Date().toISOString()
    });
    // allow SSE flush without adding noticeable latency
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

export function summarizeOptionText(text: string, maxChars: number) {
  const compact = String(text ?? "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");
  if (!compact) return "";
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, Math.max(0, maxChars - 1))}…`;
}
