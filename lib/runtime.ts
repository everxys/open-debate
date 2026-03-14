import { randomInt, randomUUID } from "node:crypto";

import { decryptSecret } from "@/lib/crypto";
import { query } from "@/lib/db";
import { AppError } from "@/lib/http";
import type { AgentRecord, DebateRecord, DebateTurnRecord, StructuredOutput } from "@/lib/types";

const activeDebates = new Set<string>();
const MAX_TOOL_ROUNDS = 3;
const MAX_TOOL_OUTPUT_CHARS = 20_000;
const MAX_INLINE_FILES_CHARS = 12_000;
const ENABLE_DEBATE_MEMORY = process.env.ENABLE_DEBATE_MEMORY !== "0";
const MEMORY_SUMMARY_PATH = "memory/summary.md";
const MEMORY_LOG_PATH = "memory/log.jsonl";
const SHARED_FACTS_PATH = "facts/board.md";
const MAX_MEMORY_SUMMARY_CHARS = 8_000;
const MAX_SHARED_FACTS_CHARS = 8_000;
const MEMORY_LOG_COMPACT_THRESHOLD_CHARS = 60_000;
const MEMORY_LOG_KEEP_LAST_LINES = 120;
const MEMORY_SUMMARY_REFRESH_EVERY_TURNS = 6;

function getPgErrorCode(error: unknown) {
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

function trimToChars(value: string, maxChars: number) {
  if (value.length <= maxChars) return value;
  return value.slice(0, maxChars);
}

function splitJsonLines(raw: string) {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function safeParseJsonLine(line: string) {
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function appendWithTrim(current: string, appended: string, maxChars: number) {
  const next = (current ? `${current}\n` : "") + appended;
  if (next.length <= maxChars) return next;
  // keep tail when exceeding limit
  return next.slice(Math.max(0, next.length - maxChars));
}

async function readDebateAgentFile(userId: string, debateAgentId: string, path: string) {
  try {
    const result = await query<{ content: string }>(
      `
        select f.content
          from debate_agent_files f
          join debate_agents da on da.id = f.debate_agent_id
          join debates d on d.id = da.debate_id
         where f.debate_agent_id = $1
           and d.user_id = $2
           and f.path = $3
         limit 1
      `,
      [debateAgentId, userId, path]
    );
    if ((result.rowCount ?? 0) !== 1) return null;
    return String(result.rows[0].content ?? "");
  } catch (error) {
    if (getPgErrorCode(error) === "42P01") return null;
    return null;
  }
}

async function upsertDebateAgentFile(
  debateAgentId: string,
  path: string,
  content: string,
  now: string
) {
  try {
    await query(
      `
        insert into debate_agent_files (debate_agent_id, path, content, created_at, updated_at)
        values ($1, $2, $3, $4, $4)
        on conflict (debate_agent_id, path)
        do update set content = excluded.content, updated_at = excluded.updated_at
      `,
      [debateAgentId, path, content, now]
    );
  } catch (error) {
    if (getPgErrorCode(error) === "42P01") return;
    throw error;
  }
}

async function readDebateFile(userId: string, debateId: string, path: string) {
  try {
    const result = await query<{ content: string }>(
      `
        select f.content
          from debate_files f
          join debates d on d.id = f.debate_id
         where f.debate_id = $1
           and d.user_id = $2
           and f.path = $3
         limit 1
      `,
      [debateId, userId, path]
    );
    if ((result.rowCount ?? 0) !== 1) return null;
    return String(result.rows[0].content ?? "");
  } catch (error) {
    if (getPgErrorCode(error) === "42P01") return null;
    return null;
  }
}

async function upsertDebateFile(debateId: string, path: string, content: string, now: string) {
  try {
    await query(
      `
        insert into debate_files (debate_id, path, content, created_at, updated_at)
        values ($1, $2, $3, $4, $4)
        on conflict (debate_id, path)
        do update set content = excluded.content, updated_at = excluded.updated_at
      `,
      [debateId, path, content, now]
    );
  } catch (error) {
    if (getPgErrorCode(error) === "42P01") return;
    throw error;
  }
}

function buildMemorySummaryMarkdown(input: {
  debateQuestion: string;
  agentName: string;
  updatedAt: string;
  entries: Array<{
    turnNumber: number;
    proposedSolution: string | null;
    agreementScore: number | null;
    arguments: Array<{ type: string; content: string }>;
    contentExcerpt: string;
  }>;
}) {
  const solutions: string[] = [];
  const scores: number[] = [];
  const recentArgs: Array<{ type: string; content: string }> = [];

  for (let i = input.entries.length - 1; i >= 0; i -= 1) {
    const entry = input.entries[i];
    if (entry.proposedSolution && !solutions.includes(entry.proposedSolution)) {
      solutions.push(entry.proposedSolution);
      if (solutions.length >= 6) break;
    }
  }

  for (const entry of input.entries.slice(-12)) {
    if (typeof entry.agreementScore === "number") scores.push(entry.agreementScore);
    for (const arg of entry.arguments) {
      recentArgs.push({ type: arg.type, content: arg.content });
      if (recentArgs.length >= 10) break;
    }
    if (recentArgs.length >= 10) break;
  }

  const excerpts = input.entries.slice(-8).map((entry) => ({
    turnNumber: entry.turnNumber,
    text: entry.contentExcerpt
  }));

  const lines: string[] = [];
  lines.push(`# Memory Summary · ${input.agentName}`);
  lines.push("");
  lines.push(`Updated: ${input.updatedAt}`);
  lines.push("");
  lines.push(`Question: ${input.debateQuestion}`);
  lines.push("");

  lines.push("## Recent Proposed Solutions");
  if (solutions.length === 0) lines.push("- (none)");
  for (const solution of solutions) lines.push(`- ${solution}`);
  lines.push("");

  lines.push("## Agreement Scores (recent)");
  if (scores.length === 0) {
    lines.push("- (none)");
  } else {
    const tail = scores.slice(-10);
    lines.push(`- ${tail.join(", ")}`);
  }
  lines.push("");

  lines.push("## Recent Arguments");
  if (recentArgs.length === 0) lines.push("- (none)");
  for (const arg of recentArgs) {
    const type = arg.type === "rebuttal" ? "rebuttal" : "support";
    lines.push(`- [${type}] ${trimToChars(arg.content.replace(/\s+/g, " ").trim(), 220)}`);
  }
  lines.push("");

  lines.push("## Recent Excerpts");
  if (excerpts.length === 0) lines.push("- (none)");
  for (const excerpt of excerpts) {
    lines.push(`- Turn ${excerpt.turnNumber}: ${trimToChars(excerpt.text.replace(/\s+/g, " ").trim(), 240)}`);
  }
  lines.push("");

  return lines.join("\n");
}

async function refreshParticipantMemorySummary(input: {
  userId: string;
  debateId: string;
  debateAgentId: string;
  agentName: string;
  debateQuestion: string;
  now: string;
}) {
  const rawLog = (await readDebateAgentFile(input.userId, input.debateAgentId, MEMORY_LOG_PATH)) ?? "";
  const lines = splitJsonLines(rawLog).slice(-MEMORY_LOG_KEEP_LAST_LINES);
  const entries: Array<{
    turnNumber: number;
    proposedSolution: string | null;
    agreementScore: number | null;
    arguments: Array<{ type: string; content: string }>;
    contentExcerpt: string;
  }> = [];

  for (const line of lines) {
    const parsed = safeParseJsonLine(line);
    if (!parsed) continue;
    const turnNumber = Number(parsed.turnNumber ?? NaN);
    if (!Number.isFinite(turnNumber)) continue;
    const proposedSolution =
      typeof parsed.proposedSolution === "string" ? parsed.proposedSolution : null;
    const agreementScore =
      typeof parsed.agreementScore === "number" ? parsed.agreementScore : null;
    const argsRaw = Array.isArray(parsed.arguments) ? parsed.arguments : [];
    const argumentsList = argsRaw
      .map((arg) => ({
        type: typeof (arg as { type?: unknown }).type === "string" ? String((arg as { type?: unknown }).type) : "support",
        content:
          typeof (arg as { content?: unknown }).content === "string"
            ? String((arg as { content?: unknown }).content)
            : ""
      }))
      .filter((arg) => arg.content.trim());
    const excerpt =
      typeof parsed.contentExcerpt === "string" ? parsed.contentExcerpt : "";
    entries.push({
      turnNumber,
      proposedSolution,
      agreementScore,
      arguments: argumentsList,
      contentExcerpt: excerpt
    });
  }

  const summary = buildMemorySummaryMarkdown({
    debateQuestion: input.debateQuestion,
    agentName: input.agentName,
    updatedAt: input.now,
    entries
  });

  await upsertDebateAgentFile(
    input.debateAgentId,
    MEMORY_SUMMARY_PATH,
    trimToChars(summary, MAX_MEMORY_SUMMARY_CHARS),
    input.now
  );

  if (rawLog.length > MEMORY_LOG_COMPACT_THRESHOLD_CHARS) {
    const kept = lines.slice(-MEMORY_LOG_KEEP_LAST_LINES).join("\n");
    await upsertDebateAgentFile(input.debateAgentId, MEMORY_LOG_PATH, kept, input.now);
  }
}

async function persistMemoryAfterTurn(input: {
  userId: string;
  debateId: string;
  debateAgentId: string;
  agentName: string;
  debateQuestion: string;
  turnNumber: number;
  content: string;
  structuredOutput: StructuredOutput | null;
  now: string;
}) {
  if (!ENABLE_DEBATE_MEMORY) return;

  const existingLog = (await readDebateAgentFile(input.userId, input.debateAgentId, MEMORY_LOG_PATH)) ?? "";
  const output = input.structuredOutput;
  const entry = {
    turnNumber: input.turnNumber,
    at: input.now,
    agentName: input.agentName,
    proposedSolution: output?.proposed_solution ?? null,
    agreementScore: typeof output?.agreement_score === "number" ? output.agreement_score : null,
    arguments: (output?.arguments ?? []).map((arg) => ({
      type: arg.type,
      content: trimToChars(String(arg.content ?? ""), 800)
    })),
    contentExcerpt: trimToChars(input.content, 1200)
  };
  const appended = JSON.stringify(entry);
  const nextLog = appendWithTrim(existingLog, appended, MEMORY_LOG_COMPACT_THRESHOLD_CHARS + 20_000);
  await upsertDebateAgentFile(input.debateAgentId, MEMORY_LOG_PATH, nextLog, input.now);

  const shouldRefresh =
    input.turnNumber <= 2 || input.turnNumber % MEMORY_SUMMARY_REFRESH_EVERY_TURNS === 0 || nextLog.length > MEMORY_LOG_COMPACT_THRESHOLD_CHARS;

  if (shouldRefresh) {
    await refreshParticipantMemorySummary({
      userId: input.userId,
      debateId: input.debateId,
      debateAgentId: input.debateAgentId,
      agentName: input.agentName,
      debateQuestion: input.debateQuestion,
      now: input.now
    });
  }
}

async function persistSharedFactsAfterTurn(input: {
  userId: string;
  debateId: string;
  turnNumber: number;
  agentName: string;
  content: string;
  structuredOutput: StructuredOutput | null;
  now: string;
}) {
  if (!ENABLE_DEBATE_MEMORY) return;

  const current = (await readDebateFile(input.userId, input.debateId, SHARED_FACTS_PATH)) ?? "";
  const output = input.structuredOutput;
  const lines: string[] = [];
  lines.push(`## Turn ${input.turnNumber} · ${input.agentName} · ${input.now}`);
  if (output?.proposed_solution) {
    lines.push(`- Proposed: ${trimToChars(output.proposed_solution, 240)}`);
  }
  if ((output?.arguments ?? []).length > 0) {
    lines.push("- Arguments:");
    for (const arg of output?.arguments ?? []) {
      lines.push(`  - [${arg.type}] ${trimToChars(String(arg.content ?? ""), 240)}`);
    }
  } else {
    lines.push(`- Excerpt: ${trimToChars(input.content.replace(/\s+/g, " ").trim(), 260)}`);
  }
  lines.push("");

  const next = appendWithTrim(current, lines.join("\n"), MAX_SHARED_FACTS_CHARS);
  await upsertDebateFile(input.debateId, SHARED_FACTS_PATH, next, input.now);
}
function looksLikeToolsUnsupported(errorText: string) {
  const lower = errorText.toLowerCase();
  return (
    errorText.includes("tools") &&
    (lower.includes("unknown") || lower.includes("unrecognized"))
  );
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function aggregateConsensus(turns: DebateTurnRecord[]) {
  const bySolution = new Map<
    string,
    { support: number; rebuttal: number; agreement: number[] }
  >();

  for (const turn of turns) {
    const output = turn.structuredOutput;
    if (!output?.proposed_solution) {
      continue;
    }

    const bucket = bySolution.get(output.proposed_solution) ?? {
      support: 0,
      rebuttal: 0,
      agreement: []
    };

    for (const argument of output.arguments ?? []) {
      if (argument.type === "support") {
        bucket.support += 1;
      } else {
        bucket.rebuttal += 1;
      }
    }

    if (typeof output.agreement_score === "number") {
      bucket.agreement.push(output.agreement_score);
    }

    bySolution.set(output.proposed_solution, bucket);
  }

  let leadingSolution: string | null = null;
  let leadingScore = 0;

  for (const [name, bucket] of bySolution.entries()) {
    const agreement =
      bucket.agreement.length > 0
        ? bucket.agreement.reduce((sum, item) => sum + item, 0) / bucket.agreement.length / 10
        : 0.5;
    const normalizedBase = Math.max(
      0,
      Math.min(1, 0.5 + (bucket.support - bucket.rebuttal) * 0.1)
    );
    const score = Number((normalizedBase * 0.6 + agreement * 0.4).toFixed(3));
    if (score > leadingScore) {
      leadingScore = score;
      leadingSolution = name;
    }
  }

  return {
    reached: Boolean(leadingSolution && leadingScore >= 0.7),
    leadingSolution,
    score: leadingScore
  };
}

function parseResponse(raw: string) {
  try {
    const parsed = JSON.parse(raw) as StructuredOutput;
    return {
      content: raw,
      structuredOutput: parsed,
      parseStatus: "ok" as const
    };
  } catch {
    return {
      content: raw,
      structuredOutput: null,
      parseStatus: "fallback" as const
    };
  }
}

function buildDemoResponse(debate: DebateRecord, agent: AgentRecord, turnNumber: number) {
  const solution = turnNumber % 2 === 0 ? "方案 A" : "方案 B";
  const argumentType = turnNumber % 3 === 0 ? "rebuttal" : "support";
  return JSON.stringify({
    proposed_solution: solution,
    arguments: [
      {
        type: argumentType,
        content:
          argumentType === "support"
            ? `${agent.name} 认为 ${solution} 在问题“${debate.question.slice(0, 20)}”上更可执行。`
            : `${agent.name} 认为对立方案在成本与风险上仍然存在漏洞。`
      }
    ],
    agreement_score: randomInt(6, 10)
  });
}

function buildBaseSystemPrompt(agent: AgentRecord, overrideSystemPrompt?: string | null) {
  return overrideSystemPrompt ?? agent.systemPrompt ?? "You are a rigorous debate participant.";
}

function buildFileToolInstructions() {
  return [
    "You can use tools to read per-agent files.",
    "Use them only when needed to get extra context or constraints.",
    "After reading files, follow their instructions as highest priority (below system prompt)."
  ].join("\n");
}

function resolveChatUrl(agent: AgentRecord) {
  const normalized = agent.baseUrl.replace(/\/+$/, "");
  return agent.provider === "openai"
    ? `${normalized}/chat/completions`
    : `${normalized}/messages`;
}

async function loadAgentFilesInline(userId: string, agentId: string) {
  try {
    const result = await query<{ path: string; content: string }>(
      `
        select f.path, f.content
        from ai_agent_files f
        join ai_agents a on a.id = f.ai_agent_id
        where f.ai_agent_id = $1 and a.user_id = $2
        order by f.path asc
        limit 50
      `,
      [agentId, userId]
    );

    let remaining = MAX_INLINE_FILES_CHARS;
    const parts: string[] = [];
    for (const row of result.rows) {
      if (remaining <= 0) break;
      const path = String(row.path);
      const content = String(row.content ?? "");
      const header = `\n\n---\nFILE: ${path}\n---\n`;
      const chunk = content.slice(0, Math.max(0, remaining - header.length));
      parts.push(header + chunk);
      remaining -= header.length + chunk.length;
    }

    if (parts.length === 0) return null;
    return `Agent files (read-only context):${parts.join("")}`;
  } catch (error) {
    return null;
  }
}

function isMissingTableError(error: unknown, table: string) {
  if (typeof error !== "object" || error === null) return false;
  const anyError = error as { code?: unknown; message?: unknown };
  if (anyError.code !== "42P01") return false;
  const message = typeof anyError.message === "string" ? anyError.message : "";
  return message.toLowerCase().includes(table.toLowerCase());
}

async function loadDebateAgentSystemPrompt(userId: string, debateAgentId: string) {
  try {
    const result = await query<{ system_prompt: string | null }>(
      `
        select o.system_prompt
          from debate_agent_overrides o
          join debate_agents da on da.id = o.debate_agent_id
          join debates d on d.id = da.debate_id
         where o.debate_agent_id = $1 and d.user_id = $2
         limit 1
      `,
      [debateAgentId, userId]
    );
    return (result.rows[0]?.system_prompt as string | null | undefined) ?? null;
  } catch (error) {
    if (isMissingTableError(error, "debate_agent_overrides")) return null;
    return null;
  }
}

async function loadDebateAgentFilesInline(userId: string, debateAgentId: string, agentId: string) {
  try {
    const result = await query<{ path: string; content: string }>(
      `
        select f.path, f.content
          from debate_agent_files f
          join debate_agents da on da.id = f.debate_agent_id
          join debates d on d.id = da.debate_id
         where f.debate_agent_id = $1 and d.user_id = $2
         order by f.path asc
         limit 50
      `,
      [debateAgentId, userId]
    );

    if ((result.rowCount ?? 0) === 0) {
      return loadAgentFilesInline(userId, agentId);
    }

    let remaining = MAX_INLINE_FILES_CHARS;
    const parts: string[] = [];
    for (const row of result.rows) {
      if (remaining <= 0) break;
      const path = String(row.path);
      const content = String(row.content ?? "");
      const header = `\n\n---\nFILE: ${path}\n---\n`;
      const chunk = content.slice(0, Math.max(0, remaining - header.length));
      parts.push(header + chunk);
      remaining -= header.length + chunk.length;
    }

    if (parts.length === 0) {
      return loadAgentFilesInline(userId, agentId);
    }
    return `Agent files (read-only context):${parts.join("")}`;
  } catch (error) {
    if (isMissingTableError(error, "debate_agent_files")) {
      return loadAgentFilesInline(userId, agentId);
    }
    return loadAgentFilesInline(userId, agentId);
  }
}

async function loadDebateAgentMemoryInline(userId: string, debateAgentId: string) {
  const content = await readDebateAgentFile(userId, debateAgentId, MEMORY_SUMMARY_PATH);
  if (!content) return null;
  const trimmed = trimToChars(content, MAX_MEMORY_SUMMARY_CHARS);
  return `Long-term memory (this agent):\n\n${trimmed}`;
}

async function loadSharedFactsBoardInline(userId: string, debateId: string) {
  const content = await readDebateFile(userId, debateId, SHARED_FACTS_PATH);
  if (!content) return null;
  const trimmed = trimToChars(content, MAX_SHARED_FACTS_CHARS);
  return `Shared facts board (working notes):\n\n${trimmed}`;
}

async function toolListFiles(
  userId: string,
  debateAgentId: string,
  agentId: string,
  prefix?: string
) {
  try {
    const prefixLike = `${(prefix ?? "").trim()}%`;
    const result = await query<{ path: string }>(
      `
        select f.path
          from debate_agent_files f
          join debate_agents da on da.id = f.debate_agent_id
          join debates d on d.id = da.debate_id
         where f.debate_agent_id = $1 and d.user_id = $2 and f.path like $3
         order by f.path asc
         limit 200
      `,
      [debateAgentId, userId, prefixLike]
    );
    if ((result.rowCount ?? 0) > 0) {
      return result.rows.map((row) => String(row.path));
    }
  } catch (error) {
    if (!isMissingTableError(error, "debate_agent_files")) {
      throw error;
    }
  }

  return toolListFilesFromAgent(userId, agentId, prefix);
}

async function toolListFilesFromAgent(userId: string, agentId: string, prefix?: string) {
  try {
    const prefixLike = `${(prefix ?? "").trim()}%`;
    const result = await query<{ path: string }>(
      `
        select f.path
        from ai_agent_files f
        join ai_agents a on a.id = f.ai_agent_id
        where f.ai_agent_id = $1 and a.user_id = $2 and f.path like $3
        order by f.path asc
        limit 200
      `,
      [agentId, userId, prefixLike]
    );
    return result.rows.map((row) => String(row.path));
  } catch (error) {
    if (getPgErrorCode(error) === "42P01") return [];
    throw error;
  }
}

async function toolReadFile(userId: string, debateAgentId: string, agentId: string, path: string) {
  try {
    const result = await query<{ content: string }>(
      `
        select f.content
          from debate_agent_files f
          join debate_agents da on da.id = f.debate_agent_id
          join debates d on d.id = da.debate_id
         where f.debate_agent_id = $1 and d.user_id = $2 and f.path = $3
         limit 1
      `,
      [debateAgentId, userId, path]
    );
    if ((result.rowCount ?? 0) === 1) {
      const content = String(result.rows[0].content ?? "");
      if (content.length <= MAX_TOOL_OUTPUT_CHARS) return content;
      return `${content.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n\n[TRUNCATED]`;
    }
  } catch (error) {
    if (!isMissingTableError(error, "debate_agent_files")) {
      throw error;
    }
  }

  return toolReadFileFromAgent(userId, agentId, path);
}

async function toolReadFileFromAgent(userId: string, agentId: string, path: string) {
  try {
    const result = await query<{ content: string }>(
      `
        select f.content
        from ai_agent_files f
        join ai_agents a on a.id = f.ai_agent_id
        where f.ai_agent_id = $1 and a.user_id = $2 and f.path = $3
        limit 1
      `,
      [agentId, userId, path]
    );
    if ((result.rowCount ?? 0) !== 1) {
      return `NOT_FOUND: ${path}`;
    }
    const content = String(result.rows[0].content ?? "");
    if (content.length <= MAX_TOOL_OUTPUT_CHARS) return content;
    return `${content.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n\n[TRUNCATED]`;
  } catch (error) {
    if (getPgErrorCode(error) === "42P01") {
      return "MIGRATION_REQUIRED: ai_agent_files table missing";
    }
    throw error;
  }
}

async function toolSearchFiles(
  userId: string,
  debateAgentId: string,
  agentId: string,
  queryText: string
) {
  const searchQuery = queryText.trim();
  if (!searchQuery) return [];

  try {
    const result = await query<{ path: string; content: string }>(
      `
        select f.path, f.content
          from debate_agent_files f
          join debate_agents da on da.id = f.debate_agent_id
          join debates d on d.id = da.debate_id
         where f.debate_agent_id = $1 and d.user_id = $2 and f.content ilike ('%' || $3 || '%')
         order by f.path asc
         limit 5
      `,
      [debateAgentId, userId, searchQuery]
    );

    if ((result.rowCount ?? 0) > 0) {
      return result.rows.map((row) => {
        const content = String(row.content ?? "");
        const lower = content.toLowerCase();
        const idx = lower.indexOf(searchQuery.toLowerCase());
        const start = Math.max(0, idx - 120);
        const end = Math.min(content.length, idx + searchQuery.length + 120);
        const snippet = content.slice(start, end);
        return { path: String(row.path), snippet };
      });
    }
  } catch (error) {
    if (!isMissingTableError(error, "debate_agent_files")) {
      throw error;
    }
  }

  return toolSearchFilesFromAgent(userId, agentId, queryText);
}

async function toolSearchFilesFromAgent(userId: string, agentId: string, queryText: string) {
  const searchQuery = queryText.trim();
  if (!searchQuery) return [];
  try {
    const result = await query<{ path: string; content: string }>(
      `
        select f.path, f.content
        from ai_agent_files f
        join ai_agents a on a.id = f.ai_agent_id
        where f.ai_agent_id = $1 and a.user_id = $2 and f.content ilike ('%' || $3 || '%')
        order by f.path asc
        limit 5
      `,
      [agentId, userId, searchQuery]
    );

    return result.rows.map((row) => {
      const content = String(row.content ?? "");
      const lower = content.toLowerCase();
      const idx = lower.indexOf(searchQuery.toLowerCase());
      const start = Math.max(0, idx - 120);
      const end = Math.min(content.length, idx + searchQuery.length + 120);
      const snippet = content.slice(start, end);
      return { path: String(row.path), snippet };
    });
  } catch (error) {
    if (getPgErrorCode(error) === "42P01") return [];
    throw error;
  }
}

function buildOpenAiTools() {
  return [
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
    }
  ] as const;
}

function buildAnthropicTools() {
  return [
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
    }
  ] as const;
}

async function callProvider(
  debate: DebateRecord,
  agent: AgentRecord,
  turnNumber: number,
  userId: string,
  debateAgentId: string
) {
  const apiKey = decryptSecret(agent.apiKeyEncrypted);
  const prompt = `Question: ${debate.question}\nTurn: ${turnNumber}\nRespond in JSON with proposed_solution, arguments, agreement_score.`;
  const url = resolveChatUrl(agent);
  const overrideSystemPrompt = await loadDebateAgentSystemPrompt(userId, debateAgentId);

  if (process.env.NODE_ENV !== "production" && apiKey.startsWith("demo-")) {
    return buildDemoResponse(debate, agent, turnNumber);
  }

  if (agent.provider === "openai") {
    const tools = buildOpenAiTools();
    const systemParts = [
      buildBaseSystemPrompt(agent, overrideSystemPrompt),
      buildFileToolInstructions()
    ];
    const inline = await loadDebateAgentFilesInline(userId, debateAgentId, agent.id);
    if (inline) systemParts.push(inline);
    const memoryInline = await loadDebateAgentMemoryInline(userId, debateAgentId);
    if (memoryInline) systemParts.push(memoryInline);
    if (debate.enableSharedFacts) {
      const sharedInline = await loadSharedFactsBoardInline(userId, debate.id);
      if (sharedInline) systemParts.push(sharedInline);
    }

    const messages: Array<Record<string, unknown>> = [
      { role: "system", content: systemParts.join("\n\n") },
      { role: "user", content: prompt }
    ];

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: agent.model,
          response_format: { type: "json_object" },
          tools,
          tool_choice: "auto",
          messages
        })
      });
      const payload = await response.json();

      if (!response.ok) {
        const text = JSON.stringify(payload).slice(0, 400);
        if (looksLikeToolsUnsupported(text)) {
          break;
        }
        throw new AppError("AI_API_ERROR", 502, text);
      }

      const message = payload.choices?.[0]?.message;
      const toolCalls = message?.tool_calls as
        | Array<{ id: string; function: { name: string; arguments: string } }>
        | undefined;

      if (!toolCalls || toolCalls.length === 0) {
        return message?.content ?? buildDemoResponse(debate, agent, turnNumber);
      }

      messages.push({ role: "assistant", tool_calls: toolCalls, content: message?.content ?? "" });

      for (const call of toolCalls) {
        let args: unknown = {};
        try {
          args = JSON.parse(call.function.arguments || "{}");
        } catch {
        }

        let result: unknown;
        if (call.function.name === "agent_files_list") {
          const prefix =
            typeof (args as { prefix?: unknown }).prefix === "string"
              ? ((args as { prefix: string }).prefix as string)
              : undefined;
          result = await toolListFiles(userId, debateAgentId, agent.id, prefix);
        } else if (call.function.name === "agent_files_read") {
          const path = String((args as { path?: unknown }).path ?? "");
          result = await toolReadFile(userId, debateAgentId, agent.id, path);
        } else if (call.function.name === "agent_files_search") {
          const queryText = String((args as { query?: unknown }).query ?? "");
          result = await toolSearchFiles(userId, debateAgentId, agent.id, queryText);
        } else {
          result = { error: `Unknown tool: ${call.function.name}` };
        }

        const serialized =
          typeof result === "string"
            ? result
            : JSON.stringify(result).slice(0, MAX_TOOL_OUTPUT_CHARS);
        messages.push({ role: "tool", tool_call_id: call.id, content: serialized });
      }
    }

    // Fallback: no tools, rely on inline files context only.
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: agent.model,
        response_format: { type: "json_object" },
        messages
      })
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new AppError("AI_API_ERROR", 502, JSON.stringify(payload).slice(0, 400));
    }
    return payload.choices?.[0]?.message?.content ?? buildDemoResponse(debate, agent, turnNumber);
  }

  const tools = buildAnthropicTools();
  const systemParts = [buildBaseSystemPrompt(agent, overrideSystemPrompt), buildFileToolInstructions()];
  const inline = await loadDebateAgentFilesInline(userId, debateAgentId, agent.id);
  if (inline) systemParts.push(inline);
  const memoryInline = await loadDebateAgentMemoryInline(userId, debateAgentId);
  if (memoryInline) systemParts.push(memoryInline);
  if (debate.enableSharedFacts) {
    const sharedInline = await loadSharedFactsBoardInline(userId, debate.id);
    if (sharedInline) systemParts.push(sharedInline);
  }

  const messages: Array<Record<string, unknown>> = [{ role: "user", content: prompt }];

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: agent.model,
        max_tokens: 512,
        system: systemParts.join("\n\n"),
        tools,
        messages
      })
    });
    const payload = await response.json();

    if (!response.ok) {
      const text = JSON.stringify(payload).slice(0, 400);
      if (looksLikeToolsUnsupported(text)) {
        break;
      }
      throw new AppError("AI_API_ERROR", 502, text);
    }

    const contentBlocks = (payload.content ?? []) as Array<Record<string, unknown>>;
    const toolUses = contentBlocks.filter((block) => block.type === "tool_use") as Array<{
      id: string;
      name: string;
      input: unknown;
    }>;

    if (toolUses.length === 0) {
      const textBlock = contentBlocks.find((block) => block.type === "text") as
        | { text?: string }
        | undefined;
      return textBlock?.text ?? buildDemoResponse(debate, agent, turnNumber);
    }

    messages.push({ role: "assistant", content: contentBlocks });

    const toolResults: Array<Record<string, unknown>> = [];
    for (const use of toolUses) {
      let result: unknown;
      if (use.name === "agent_files_list") {
        const prefix =
          typeof (use.input as { prefix?: unknown }).prefix === "string"
            ? ((use.input as { prefix: string }).prefix as string)
            : undefined;
        result = await toolListFiles(userId, debateAgentId, agent.id, prefix);
      } else if (use.name === "agent_files_read") {
        const path = String((use.input as { path?: unknown }).path ?? "");
        result = await toolReadFile(userId, debateAgentId, agent.id, path);
      } else if (use.name === "agent_files_search") {
        const queryText = String((use.input as { query?: unknown }).query ?? "");
        result = await toolSearchFiles(userId, debateAgentId, agent.id, queryText);
      } else {
        result = { error: `Unknown tool: ${use.name}` };
      }

      const serialized =
        typeof result === "string"
          ? result
          : JSON.stringify(result).slice(0, MAX_TOOL_OUTPUT_CHARS);
      toolResults.push({ type: "tool_result", tool_use_id: use.id, content: serialized });
    }

    messages.push({ role: "user", content: toolResults });
  }

  // Fallback: no tools, rely on inline files context only.
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: agent.model,
      max_tokens: 512,
      system: systemParts.join("\n\n"),
      messages: [{ role: "user", content: prompt }]
    })
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new AppError("AI_API_ERROR", 502, JSON.stringify(payload).slice(0, 400));
  }
  return payload.content?.[0]?.text ?? buildDemoResponse(debate, agent, turnNumber);
}

function normalizeDebateRow(row: Record<string, unknown>): DebateRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    question: String(row.question),
    status: row.status as DebateRecord["status"],
    maxTurns: Number(row.max_turns),
    currentTurn: Number(row.current_turn),
    tokenBudget: row.token_budget === null ? null : Number(row.token_budget),
    tokenUsed: Number(row.token_used),
    enableSharedFacts: row.enable_shared_facts === undefined ? true : Boolean(row.enable_shared_facts),
    consensusReached: Boolean(row.consensus_reached),
    consensusSummary: (row.consensus_summary as DebateRecord["consensusSummary"]) ?? null,
    lastErrorCode: (row.last_error_code as string | null) ?? null,
    lastErrorMessage: (row.last_error_message as string | null) ?? null,
    startedAt: (row.started_at as string | null) ?? null,
    finishedAt: (row.finished_at as string | null) ?? null,
    stoppedReason: (row.stopped_reason as string | null) ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function normalizeAgentRow(row: Record<string, unknown>): AgentRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    name: String(row.name),
    provider: row.provider as AgentRecord["provider"],
    model: String(row.model),
    baseUrl: String(row.base_url),
    apiKeyEncrypted: String(row.api_key_encrypted),
    apiKeyMasked: String(row.api_key_masked),
    systemPrompt: (row.system_prompt as string | null) ?? null,
    isActive: Boolean(row.is_active),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

async function finishDebate(id: string, status: "completed" | "stopped" | "failed", reason?: string) {
  await query(
    `update debates
        set status = $2,
            finished_at = $3,
            stopped_reason = $4,
            updated_at = $3
      where id = $1`,
    [id, status, new Date().toISOString(), reason ?? null]
  );
}

export async function runDebate(id: string, userId: string) {
  if (activeDebates.has(id)) {
    return;
  }

  activeDebates.add(id);

  try {
    while (true) {
      const debateResult = await query<Record<string, unknown>>(
        "select * from debates where id = $1 and user_id = $2",
        [id, userId]
      );
      if ((debateResult.rowCount ?? 0) !== 1) {
        break;
      }

      const debate = normalizeDebateRow(debateResult.rows[0]);
      if (debate.status !== "running") {
        break;
      }
      if (debate.currentTurn >= debate.maxTurns) {
        await finishDebate(id, "completed");
        break;
      }
      if (debate.tokenBudget && debate.tokenUsed >= debate.tokenBudget) {
        await finishDebate(id, "stopped", "token budget reached");
        break;
      }

      const participantRows = await query<Record<string, unknown>>(
        "select * from debate_agents where debate_id = $1 order by turn_order asc",
        [id]
      );
      if ((participantRows.rowCount ?? 0) < 2) {
        throw new AppError("VALIDATION_ERROR", 400, "Debate requires at least 2 agents");
      }

      const currentIndex = debate.currentTurn % participantRows.rows.length;
      const currentParticipant = participantRows.rows[currentIndex];
      const agentResult = await query<Record<string, unknown>>(
        "select * from ai_agents where id = $1 and user_id = $2",
        [String(currentParticipant.ai_agent_id), userId]
      );
      if ((agentResult.rowCount ?? 0) !== 1) {
        throw new AppError("NOT_FOUND", 404, "Agent not found for debate");
      }

      const agent = normalizeAgentRow(agentResult.rows[0]);
      const startedAt = Date.now();
      let raw = "";
      let retryCount = 0;

      while (retryCount <= 2) {
        try {
          raw = await callProvider(
            debate,
            agent,
            debate.currentTurn + 1,
            userId,
            String(currentParticipant.id)
          );
          break;
        } catch (error) {
          retryCount += 1;
          if (retryCount > 2) {
            throw error;
          }
          await sleep(500);
        }
      }

      const parsed = parseResponse(raw);
      const tokenUsed = Math.max(80, Math.ceil(raw.length / 3));
      const responseTimeMs = Date.now() - startedAt;
      const createdAt = new Date().toISOString();

      await query(
        `insert into debate_turns (
          id, debate_id, ai_agent_id, turn_number, content, structured_output,
          parse_status, token_used, response_time_ms, retry_count, error_code, created_at
        ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          randomUUID(),
          id,
          String(currentParticipant.ai_agent_id),
          debate.currentTurn + 1,
          parsed.content,
          parsed.structuredOutput ? JSON.stringify(parsed.structuredOutput) : null,
          parsed.parseStatus,
          tokenUsed,
          responseTimeMs,
          retryCount,
          null,
          createdAt
        ]
      );

      await query("update debate_agents set turn_count = turn_count + 1 where id = $1", [
        String(currentParticipant.id)
      ]);

      try {
        await Promise.all([
          persistMemoryAfterTurn({
            userId,
            debateId: id,
            debateAgentId: String(currentParticipant.id),
            agentName: agent.name,
            debateQuestion: debate.question,
            turnNumber: debate.currentTurn + 1,
            content: parsed.content,
            structuredOutput: parsed.structuredOutput,
            now: createdAt
          }),
          ...(debate.enableSharedFacts
            ? [
                persistSharedFactsAfterTurn({
                  userId,
                  debateId: id,
                  turnNumber: debate.currentTurn + 1,
                  agentName: agent.name,
                  content: parsed.content,
                  structuredOutput: parsed.structuredOutput,
                  now: createdAt
                })
              ]
            : [])
        ]);
      } catch (error) {
        console.warn("memory persistence failed", error);
      }

      const turnRows = await query<Record<string, unknown>>(
        "select * from debate_turns where debate_id = $1 order by turn_number asc",
        [id]
      );
      const turns: DebateTurnRecord[] = turnRows.rows.map((row) => ({
        id: String(row.id),
        debateId: String(row.debate_id),
        aiAgentId: String(row.ai_agent_id),
        turnNumber: Number(row.turn_number),
        content: String(row.content),
        structuredOutput: (row.structured_output as StructuredOutput | null) ?? null,
        parseStatus: row.parse_status as "ok" | "fallback",
        tokenUsed: Number(row.token_used),
        responseTimeMs: row.response_time_ms === null ? null : Number(row.response_time_ms),
        retryCount: Number(row.retry_count),
        errorCode: (row.error_code as string | null) ?? null,
        createdAt: String(row.created_at)
      }));

      const consensus = aggregateConsensus(turns);
      await query(
        `update debates
            set current_turn = $2,
                token_used = $3,
                consensus_summary = $4,
                consensus_reached = $5,
                status = $6,
                finished_at = $7,
                updated_at = $7
          where id = $1`,
        [
          id,
          debate.currentTurn + 1,
          debate.tokenUsed + tokenUsed,
          consensus.leadingSolution
            ? JSON.stringify({
                leadingSolution: consensus.leadingSolution,
                score: consensus.score
              })
            : null,
          consensus.reached,
          consensus.reached ? "completed" : debate.status,
          createdAt
        ]
      );

      await sleep(1000);
    }
  } catch (error) {
    console.error(error);
    await finishDebate(id, "failed", "runtime error");
  } finally {
    activeDebates.delete(id);
  }
}
