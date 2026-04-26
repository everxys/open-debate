import { sql } from "kysely";

import { ensureDb } from "@/lib/db";
import {
  CONTEXT_SEGMENT_PATH,
  CONTEXT_WINDOW_PATH,
  MEMORY_SUMMARY_PATH,
  SHARED_FACTS_PATH
} from "@/lib/runtime/constants";
import {
  clipPromptInlineContent,
  isDirectChildPath,
  isMemoryPath,
  normalizeContextPath,
  hasContextAccessRules,
  resolveContextAccessRules,
  type ResolvedContextAccessRule
} from "@/lib/runtime/context-inline";
import {
  readDebateAgentFile,
  readDebateFile
} from "@/lib/runtime/file-store";
import {
  isMissingTableError,
  listMergedSeatFiles,
  recordImplicitFileReads,
  type DebateFileActivityAudit,
  type SeatFileEntry
} from "@/lib/runtime/debate-file-access";
import type { DebateRecord } from "@/lib/types";
import type { NormalizedDebateWorkflow, WorkflowPhaseKind } from "@/lib/workflow";
import {
  getWorkflowCompletionMode,
  getWorkflowEarliestCompletionRound,
  getWorkflowEarliestFinalizationRound,
  getWorkflowEarliestFinalizationVoteRound,
  hasWorkflowPhase,
  resolveCurrentWorkflowPhase,
  requiresWorkflowOutputsForCompletion,
  safeJsonParse,
  type OfficialVote
} from "@/lib/runtime/workflow-phase";

export async function loadAgentFilesInline(
  userId: string,
  debateAgentId: string,
  agentId: string,
  maxChars?: number | null,
  audit: DebateFileActivityAudit | null = null
) {
  try {
    const db = await ensureDb();
    const result = await db
      .selectFrom("ai_agent_files as f")
      .innerJoin("ai_agents as a", "a.id", "f.ai_agent_id")
      .select(["f.path", "f.content"])
      .where("f.ai_agent_id", "=", agentId)
      .where("a.user_id", "=", userId)
      .orderBy("f.path", "asc")
      .execute();

    const parts: string[] = [];
    const auditedPaths: string[] = [];
    for (const row of result) {
      const path = String(row.path);
      if (isMemoryPath(path)) continue;
      const content = String(row.content ?? "");
      const header = `\n\n---\nFILE: ${path}\n---\n`;
      parts.push(header + content);
      auditedPaths.push(path);
    }

    if (parts.length === 0) return null;
    await recordImplicitFileReads({
      audit,
      scope: "agent",
      paths: auditedPaths,
      targetDebateAgentId: null
    });
    return `Agent files (read-only context):${clipPromptInlineContent(parts.join(""), maxChars ?? 18_000)}`;
  } catch (error) {
    return null;
  }
}

export async function loadDebateAgentSystemPrompt(userId: string, debateAgentId: string) {
  try {
    const db = await ensureDb();
    const result = await db
      .selectFrom("debate_agent_overrides as o")
      .innerJoin("debate_agents as da", "da.id", "o.debate_agent_id")
      .innerJoin("debates as d", "d.id", "da.debate_id")
      .select("o.system_prompt")
      .where("o.debate_agent_id", "=", debateAgentId)
      .where("d.user_id", "=", userId)
      .limit(1)
      .executeTakeFirst();
    return (result?.system_prompt as string | null | undefined) ?? null;
  } catch (error) {
    if (isMissingTableError(error, "debate_agent_overrides")) return null;
    return null;
  }
}

export async function loadDebateAgentFilesInline(
  userId: string,
  debateAgentId: string,
  agentId: string,
  maxChars?: number | null,
  audit: DebateFileActivityAudit | null = null
) {
  try {
    const files = await listMergedSeatFiles(userId, debateAgentId, agentId);
    const parts: string[] = [];
    const auditedDebatePaths: string[] = [];
    const auditedAgentPaths: string[] = [];
    for (const row of files) {
      const path = String(row.path ?? "");
      if (isMemoryPath(path)) continue;
      const content = String(row.content ?? "");
      const header = `\n\n---\nFILE: ${path}\n---\n`;
      parts.push(header + content);
      if (row.source === "debate") {
        auditedDebatePaths.push(path);
      } else {
        auditedAgentPaths.push(path);
      }
    }

    if (parts.length === 0) {
      return loadAgentFilesInline(userId, debateAgentId, agentId, maxChars, audit);
    }
    await recordImplicitFileReads({ audit, scope: "agent", paths: auditedDebatePaths, targetDebateAgentId: debateAgentId });
    await recordImplicitFileReads({ audit, scope: "agent", paths: auditedAgentPaths, targetDebateAgentId: null });
    return `Agent files (read-only context):${clipPromptInlineContent(parts.join(""), maxChars ?? 18_000)}`;
  } catch (error) {
    if (isMissingTableError(error, "debate_agent_files")) {
      return loadAgentFilesInline(userId, debateAgentId, agentId, maxChars, audit);
    }
    return loadAgentFilesInline(userId, debateAgentId, agentId, maxChars, audit);
  }
}

export async function listSeatContextFilesForRule(
  userId: string,
  debateAgentId: string,
  agentId: string,
  rule: ResolvedContextAccessRule
) {
  if (rule.targetType === "file") {
    const rows = await listMergedSeatFiles(userId, debateAgentId, agentId);
    return rows.filter((row) => normalizeContextPath(String(row.path ?? "")) === normalizeContextPath(rule.pathPrefix));
  }
  const rows = await listMergedSeatFiles(userId, debateAgentId, agentId, rule.pathPrefix);
  return rows.filter((row) => (rule.recursive ? true : isDirectChildPath(rule.pathPrefix, String(row.path ?? ""))));
}

export async function listSharedContextFilesForRule(userId: string, debateId: string, rule: ResolvedContextAccessRule) {
  const db = await ensureDb();
  try {
    let query = db
      .selectFrom("debate_files as f")
      .innerJoin("debates as d", "d.id", "f.debate_id")
      .select(["f.path", "f.content"])
      .where("f.debate_id", "=", debateId)
      .where("d.user_id", "=", userId)
      .orderBy("f.path", "asc");
    query =
      rule.targetType === "file"
        ? query.where("f.path", "=", rule.pathPrefix)
        : query.where("f.path", "like", `${rule.pathPrefix}%`);
    const result = await query.execute();
    if (rule.targetType === "file") return result;
    return result.filter((row) => (rule.recursive ? true : isDirectChildPath(rule.pathPrefix, String(row.path ?? ""))));
  } catch (error) {
    if (isMissingTableError(error, "debate_files")) return [];
    throw error;
  }
}

export async function loadContextAccessAutoReadInline(input: {
  userId: string;
  debateId: string;
  debateAgentId: string;
  agentId: string;
  workflow: NormalizedDebateWorkflow | null;
  currentPhaseKind: WorkflowPhaseKind | null | undefined;
  audit?: DebateFileActivityAudit | null;
}) {
  if (!hasContextAccessRules(input.workflow)) return null;
  const resolved = resolveContextAccessRules(input.workflow, input.currentPhaseKind);
  if (resolved.autoRead.length <= 0) return null;

  const blocks: string[] = ["Context access auto-read files (IMPORTANT):"];
  for (const rule of resolved.autoRead) {
    const rows =
      rule.scope === "shared"
        ? await listSharedContextFilesForRule(input.userId, input.debateId, rule)
        : await listSeatContextFilesForRule(input.userId, input.debateAgentId, input.agentId, rule);
    if (rows.length <= 0) continue;
    const limitedRows = rows.slice(0, Math.max(1, rule.maxFiles));
    if (rule.scope === "shared") {
      await recordImplicitFileReads({
        audit: input.audit ?? null,
        scope: "debate",
        paths: limitedRows.map((row) => String(row.path ?? "")),
        targetDebateAgentId: null
      });
    } else {
      const seatRows = limitedRows as SeatFileEntry[];
      await recordImplicitFileReads({
        audit: input.audit ?? null,
        scope: "agent",
        paths: seatRows.filter((row) => row.source === "debate").map((row) => String(row.path ?? "")),
        targetDebateAgentId: input.debateAgentId
      });
      await recordImplicitFileReads({
        audit: input.audit ?? null,
        scope: "agent",
        paths: seatRows.filter((row) => row.source === "agent").map((row) => String(row.path ?? "")),
        targetDebateAgentId: null
      });
    }
    blocks.push(`- [${rule.scope}] ${rule.targetType === "file" ? "file" : "dir"} ${rule.pathPrefix}`);
    for (const row of limitedRows) {
      const path = normalizeContextPath(String(row.path ?? ""));
      const content = clipPromptInlineContent(String(row.content ?? ""), Math.max(400, rule.maxCharsPerFile));
      blocks.push(`\n---\nFILE: ${path}\n---\n${content}`);
    }
    if (rows.length > limitedRows.length) {
      blocks.push(`[Truncated: ${rows.length - limitedRows.length} more files under ${rule.pathPrefix}]`);
    }
  }

  return blocks.length > 1 ? blocks.join("\n") : null;
}

export async function loadDebateAgentMemoryInline(
  userId: string,
  debateAgentId: string,
  maxChars?: number | null,
  audit: DebateFileActivityAudit | null = null
) {
  const content = await readDebateAgentFile(userId, debateAgentId, MEMORY_SUMMARY_PATH);
  if (!content) return null;
  await recordImplicitFileReads({
    audit,
    scope: "agent",
    paths: [MEMORY_SUMMARY_PATH],
    targetDebateAgentId: debateAgentId
  });
  return `Long-term memory (this agent):\n\n${clipPromptInlineContent(content, maxChars ?? 10_000)}`;
}

export async function loadSharedFactsBoardInline(
  userId: string,
  debateId: string,
  maxChars?: number | null,
  audit: DebateFileActivityAudit | null = null
) {
  const content = await readDebateFile(userId, debateId, SHARED_FACTS_PATH);
  if (!content) return null;
  await recordImplicitFileReads({
    audit,
    scope: "debate",
    paths: [SHARED_FACTS_PATH]
  });
  return `Shared facts board (structured working notes):\n\n${clipPromptInlineContent(content, maxChars ?? 10_000)}`;
}

export async function loadDebateSegmentInline(userId: string, debateId: string, maxChars?: number | null) {
  const content = await readDebateFile(userId, debateId, CONTEXT_SEGMENT_PATH);
  if (!content) return null;
  return `Segment checkpoint (read-only; summary for continuing the debate):\n\n${clipPromptInlineContent(content, maxChars ?? 12_000)}`;
}

export async function loadDebateAgentSegmentInline(
  userId: string,
  debateId: string,
  debateAgentId: string,
  maxChars?: number | null,
  audit: DebateFileActivityAudit | null = null
) {
  const agentContent = await readDebateAgentFile(userId, debateAgentId, CONTEXT_SEGMENT_PATH);
  const content = agentContent ?? (await readDebateFile(userId, debateId, CONTEXT_SEGMENT_PATH));
  if (!content) return null;
  await recordImplicitFileReads({
    audit,
    scope: agentContent ? "agent" : "debate",
    paths: [CONTEXT_SEGMENT_PATH],
    targetDebateAgentId: agentContent ? debateAgentId : null
  });
  return `Segment checkpoint (read-only; this seat only):\n\n${clipPromptInlineContent(content, maxChars ?? 12_000)}`;
}

export async function loadContextWindowMinTurnNumber(userId: string, debateId: string) {
  const raw = await readDebateFile(userId, debateId, CONTEXT_WINDOW_PATH);
  if (!raw) return null;
  const parsed = safeJsonParse<{ minTurnNumber?: unknown; enabled?: unknown }>(raw);
  if (!parsed) return null;
  const enabled = parsed.enabled === undefined ? true : Boolean(parsed.enabled);
  if (!enabled) return null;
  const minTurnNumber = typeof parsed.minTurnNumber === "number" ? parsed.minTurnNumber : Number(parsed.minTurnNumber);
  if (!Number.isFinite(minTurnNumber) || minTurnNumber <= 1) return null;
  return Math.floor(minTurnNumber);
}

export async function loadContextWindowMinTurnNumberForDebateAgent(
  userId: string,
  debateId: string,
  debateAgentId: string
) {
  const agentRaw = await readDebateAgentFile(userId, debateAgentId, CONTEXT_WINDOW_PATH);
  const raw = agentRaw ?? (await readDebateFile(userId, debateId, CONTEXT_WINDOW_PATH));
  if (!raw) return null;
  const parsed = safeJsonParse<{ minTurnNumber?: unknown; enabled?: unknown }>(raw);
  if (!parsed) return null;
  const enabled = parsed.enabled === undefined ? true : Boolean(parsed.enabled);
  if (!enabled) return null;
  const minTurnNumber = typeof parsed.minTurnNumber === "number" ? parsed.minTurnNumber : Number(parsed.minTurnNumber);
  if (!Number.isFinite(minTurnNumber) || minTurnNumber <= 1) return null;
  return Math.floor(minTurnNumber);
}

export type RecentTurnRow = {
  turnNumber: number;
  content: string;
  createdAt: string;
  speakerName: string | null;
  seatNumber: number | null;
};

export function formatRecentTurnsInline(rows: RecentTurnRow[], participantCount: number, minTurnNumber?: number | null) {
  if (rows.length <= 0) return null;
  const min = typeof minTurnNumber === "number" && Number.isFinite(minTurnNumber) ? Math.floor(minTurnNumber) : null;
  const parts: string[] = [];
  parts.push(
    [
      "Recent messages context (read-only):",
      ...(min ? [`- Window: Turn >= ${min}.`] : []),
      `- Seats: ${participantCount}. 1 round = ${participantCount} messages (each seat speaks once).`,
      "- Turn #N below means the N-th message overall, NOT the number of seats/legislators."
    ].join("\n")
  );
  for (const row of rows) {
    const speakerName = String(row.speakerName ?? "Unknown");
    const seatLabel = row.seatNumber === null ? "" : `Seat-${Number(row.seatNumber)} · `;
    const header = `\n\n---\nTurn #${row.turnNumber} · ${seatLabel}${speakerName} · ${row.createdAt}\n---\n`;
    parts.push(header + row.content);
  }
  return parts.join("");
}

export async function loadRecentTurnRows(
  userId: string,
  debateId: string,
  participantCount: number,
  limit: number,
  minTurnNumber?: number | null
) {
  try {
    const min = typeof minTurnNumber === "number" && Number.isFinite(minTurnNumber) ? Math.floor(minTurnNumber) : null;
    const db = await ensureDb();
    let queryBuilder = db
      .selectFrom("debate_turns as t")
      .innerJoin("ai_agents as a", "a.id", "t.ai_agent_id")
      .leftJoin("debate_agents as da", "da.id", "t.debate_agent_id")
      .innerJoin("debates as d", "d.id", "t.debate_id")
      .select([
        "t.turn_number",
        "t.content",
        "t.created_at",
        sql<string>`coalesce(da.display_name, a.name)`.as("speaker_name"),
        "t.seat_number as seat_number"
      ])
      .where("t.debate_id", "=", debateId)
      .where("d.user_id", "=", userId);
    if (min !== null) {
      queryBuilder = queryBuilder.where("t.turn_number", ">=", min);
    }
    const result = await queryBuilder
      .orderBy("t.turn_number", "desc")
      .limit(Math.max(0, Math.floor(limit)))
      .execute();

    if (result.length === 0) return [];

    return [...result].reverse().map((row) => ({
      turnNumber: Number(row.turn_number),
      content: String(row.content ?? ""),
      createdAt: String(row.created_at ?? ""),
      speakerName: row.speaker_name === null ? null : String(row.speaker_name),
      seatNumber: row.seat_number === null ? null : Number(row.seat_number)
    }));
  } catch {
    return [];
  }
}

export async function loadDebateSeatInline(userId: string, debateId: string, debateAgentId: string) {
  try {
    const db = await ensureDb();
    const result = await db
      .selectFrom("debate_agents as da")
      .innerJoin("debates as d", "d.id", "da.debate_id")
      .select(["da.turn_order", "da.display_name"])
      .where("da.debate_id", "=", debateId)
      .where("da.id", "=", debateAgentId)
      .where("d.user_id", "=", userId)
      .limit(1)
      .executeTakeFirst();
    if (!result) return null;
    const seatNumber = Number(result.turn_order ?? 0);
    const displayName = String(result.display_name ?? "");
    if (!Number.isFinite(seatNumber) || seatNumber <= 0) return null;
    const namePart = displayName ? ` (${displayName})` : "";
    return `Identity (read-only):\n- You are Seat-${seatNumber}${namePart}.`;
  } catch {
    return null;
  }
}

export async function loadDebateParticipantsInline(userId: string, debateId: string) {
  try {
    const db = await ensureDb();
    const result = await db
      .selectFrom("debate_agents as da")
      .innerJoin("debates as d", "d.id", "da.debate_id")
      .select(["da.turn_order", "da.display_name as display_name"])
      .where("da.debate_id", "=", debateId)
      .where("d.user_id", "=", userId)
      .orderBy("da.turn_order", "asc")
      .execute();
    if (result.length <= 0) return null;
    const lines = result.map(
      (row) => `- Seat-${Number(row.turn_order)}: ${String(row.display_name ?? `Seat-${Number(row.turn_order)}`)}`
    );
    return [
      "Seats (read-only):",
      ...lines
    ].join("\n");
  } catch {
    return null;
  }
}

export function buildWorkflowPhaseInline(input: {
  workflow: NormalizedDebateWorkflow | null;
  debate: DebateRecord;
  roundNumber: number;
  openVote: OfficialVote | null;
  latestVote?: OfficialVote | null;
}) {
  const isLightweightWorkflow =
    input.workflow?.enabled &&
    input.workflow.completion.mode === "consensus_only" &&
    input.workflow.deliverables.requiredFiles.length === 0 &&
    !input.workflow.ideaBank.rawIdeaBankPath &&
    !Object.values(input.workflow.ideaBank.derivedFiles).some(Boolean) &&
    input.workflow.contextAccess.alwaysRead.length === 0 &&
    input.workflow.contextAccess.readWhenNeeded.length === 0 &&
    input.workflow.contextAccess.unlockAfterPhase.length === 0 &&
    input.workflow.phaseMachine.phases.length === 1 &&
    input.workflow.phaseMachine.phases[0]?.kind === "deliberation";
  const current = resolveCurrentWorkflowPhase({
    workflow: input.workflow,
    roundNumber: input.roundNumber,
    openVote: input.openVote,
    latestVote: input.latestVote,
    persistedPhaseKind: input.debate.workflowPhaseKind
  });
  if (!current) return null;
  if (isLightweightWorkflow) {
    const lines = ["Discussion guidance (IMPORTANT):"];
    if (current.description) lines.push(`- Focus: ${current.description}`);
    if (current.injectedPrompt) {
      lines.push("- Discussion prompt:");
      lines.push(current.injectedPrompt);
    }
    lines.push(`- Earliest completion round: ${getWorkflowEarliestCompletionRound(input.workflow)}`);
    lines.push(`- Completion mode: ${getWorkflowCompletionMode(input.workflow)}`);
    return lines.join("\n");
  }
  const lines = [
    "Rule guidance (IMPORTANT):",
    `- Current phase: ${current.title}`,
    `- Phase kind: ${current.kind}`
  ];
  if (current.description) lines.push(`- Goal: ${current.description}`);
  if (current.injectedPrompt) {
    lines.push("- Phase-specific prompt:");
    lines.push(current.injectedPrompt);
  }
  if (current.minRounds) lines.push(`- Minimum rounds for this phase: ${current.minRounds}`);
  if (hasWorkflowPhase(input.workflow, "finalization_vote")) {
    lines.push(`- Earliest consolidation vote round: ${getWorkflowEarliestFinalizationVoteRound(input.workflow)}`);
  } else {
    lines.push("- Consolidation vote phase: not configured");
  }
  if (hasWorkflowPhase(input.workflow, "finalization")) {
    lines.push(`- Earliest consolidation round: ${getWorkflowEarliestFinalizationRound(input.workflow)}`);
  } else {
    lines.push("- Consolidation phase: not configured");
  }
  lines.push(`- Earliest completion round: ${getWorkflowEarliestCompletionRound(input.workflow)}`);
  lines.push(`- Completion mode: ${getWorkflowCompletionMode(input.workflow)}`);
  const allPhases = input.workflow?.phaseMachine.phases ?? [];
  if (allPhases.length > 0) {
    lines.push("- Full phase machine:");
    for (const phase of allPhases) {
      lines.push(
        `  - ${phase.title}${phase.description ? `: ${phase.description}` : ""}${phase.minRounds ? ` (minRounds=${phase.minRounds})` : ""}`
      );
    }
  }
  const requiredDeliverables = input.workflow?.deliverables.requiredFiles ?? [];
  if (requiredDeliverables.length > 0 && requiresWorkflowOutputsForCompletion(input.workflow)) {
    lines.push("- Completion gate: this workflow requires the listed deliverables before the debate can finish.");
  }
  return lines.join("\n");
}

export async function loadWorkflowIdeaBankInline(input: {
  workflow: NormalizedDebateWorkflow | null;
  phaseKind: "analysis" | "deliberation" | "finalization_vote" | "finalization" | null;
  userId: string;
  debateId: string;
}) {
  if (!input.workflow?.enabled || !input.phaseKind) return null;
  if (input.phaseKind === "analysis") return null;

  const lines: string[] = ["Idea bank routing (IMPORTANT):"];
  const ideaBank = await resolveDebateIdeaBankPaths({
    workflow: input.workflow,
    userId: input.userId,
    debateId: input.debateId
  });
  const rawPath = ideaBank.rawIdeaBankPath;
  const derived = ideaBank.derivedFiles;

  if (input.phaseKind === "deliberation") {
    if (rawPath) {
      lines.push(`- Raw idea bank path: ${rawPath} (read-only source material; do not overwrite this file).`);
      const rawContent = (await readDebateFile(input.userId, input.debateId, rawPath)) ?? "";
      if (rawContent.trim()) {
        lines.push("", `## Raw idea bank · ${rawPath}`, clipPromptInlineContent(rawContent.trim()));
      }
    }
    lines.push("- In this phase, you must collaboratively filter, merge, reject, regroup, and invent ideas.");
    lines.push("- Write the screening results into derived idea files instead of mutating the raw idea bank.");
    const derivedTargets = [
      derived.selectedSTierPath,
      derived.selectedATierPath,
      derived.rejectedOrMergedPath,
      derived.eventMappingsPath,
      derived.newlyInventedIdeasPath
    ].filter((item): item is string => Boolean(item));
    if (derivedTargets.length > 0) {
      lines.push(`- Preferred derived files: ${derivedTargets.join(" / ")}`);
    }
  } else if (input.phaseKind === "finalization_vote") {
    if (rawPath) {
      lines.push(`- Raw idea bank path: ${rawPath} (do not reopen the raw bank unless you must verify unresolved risk).`);
    }
    lines.push("- In this phase, do not expand the scope again by default.");
    lines.push("- Focus on whether the debate is ready to enter consolidation, what blockers remain, and whether the required outputs can now be unified.");
  } else if (input.phaseKind === "finalization") {
    if (rawPath) {
      lines.push(`- Raw idea bank path: ${rawPath} (do not return to this file by default in finalization).`);
    }
    lines.push("- In this phase, use the idea screening results as the primary source of truth.");
  }

  const derivedReadOrder =
    input.phaseKind === "deliberation"
      ? [
          derived.selectedSTierPath,
          derived.selectedATierPath,
          derived.rejectedOrMergedPath,
          derived.eventMappingsPath,
          derived.newlyInventedIdeasPath
        ]
      : [derived.selectedSTierPath, derived.eventMappingsPath, derived.selectedATierPath];

  for (const path of derivedReadOrder) {
    if (!path) continue;
    const content = (await readDebateFile(input.userId, input.debateId, path)) ?? "";
    if (!content.trim()) continue;
    lines.push("", `## Idea result file · ${path}`, clipPromptInlineContent(content.trim(), 12_000));
  }

  return lines.length > 1 ? lines.join("\n") : null;
}

type ResolvedIdeaBankPaths = {
  rawIdeaBankPath: string | null;
  derivedFiles: {
    selectedSTierPath: string | null;
    selectedATierPath: string | null;
    rejectedOrMergedPath: string | null;
    eventMappingsPath: string | null;
    newlyInventedIdeasPath: string | null;
  };
};

export async function resolveDebateIdeaBankPaths(input: {
  workflow: NormalizedDebateWorkflow | null;
  userId: string;
  debateId: string;
}): Promise<ResolvedIdeaBankPaths> {
  const configured = input.workflow?.ideaBank;

  return {
    rawIdeaBankPath: configured?.rawIdeaBankPath ?? null,
    derivedFiles: {
      selectedSTierPath: configured?.derivedFiles.selectedSTierPath ?? null,
      selectedATierPath: configured?.derivedFiles.selectedATierPath ?? null,
      rejectedOrMergedPath: configured?.derivedFiles.rejectedOrMergedPath ?? null,
      eventMappingsPath: configured?.derivedFiles.eventMappingsPath ?? null,
      newlyInventedIdeasPath: configured?.derivedFiles.newlyInventedIdeasPath ?? null
    }
  };
}
