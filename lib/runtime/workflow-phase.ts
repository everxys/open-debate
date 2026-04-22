import { ensureDb } from "@/lib/db";
import { sql } from "kysely";
import type { DebateRecord } from "@/lib/types";
import type { NormalizedDebateWorkflow } from "@/lib/workflow";
import { safeParseWorkflowJson } from "@/lib/workflow";

import { readDebateFile } from "@/lib/runtime/file-store";
import { WORKFLOW_PATH } from "@/lib/runtime/constants";

function getPgErrorCode(error: unknown) {
  if (typeof error !== "object" || error === null) return null;
  const anyError = error as { code?: unknown };
  return typeof anyError.code === "string" ? anyError.code : null;
}

export type OfficialVote =
  | {
      status: "open";
      kind: "finalization" | "custom";
      roundNumber: number;
      title: string;
      prompt: string;
      options: string[];
      ballots: Array<{
        debateAgentId: string;
        voter: string;
        voterSeat?: string;
        choice: string;
        reason?: string;
        at: string;
      }>;
      meta?: {
        forcedOpen?: boolean;
        reason?: string;
        tieRound?: number;
        reopenedBecause?: string;
        attempt?: number;
        previousFailedRound?: number;
      };
      createdAt: string;
    }
  | {
      status: "closed";
      kind: "finalization" | "custom";
      roundNumber: number;
      title: string;
      prompt: string;
      result: Record<string, unknown>;
      meta?: {
        forcedOpen?: boolean;
        reason?: string;
        tieRound?: number;
        reopenedBecause?: string;
        attempt?: number;
        previousFailedRound?: number;
      };
      closedAt: string;
      createdAt: string;
    }
  ;

export type OpenOfficialVote = Extract<OfficialVote, { status: "open" }>;
export type ClosedOfficialVote = Extract<OfficialVote, { status: "closed" }>;

export const FINALIZATION_VOTE_APPROVE = "同意进入收束阶段";
export const FINALIZATION_VOTE_REJECT = "不同意，继续讨论";
export const LEGACY_FINALIZATION_VOTE_APPROVE = "同意进入 Phase 3";
export const LEGACY_FINALIZATION_VOTE_REJECT = "不同意，继续 Phase 2";

export function buildFinalizationVoteOptions() {
  return [FINALIZATION_VOTE_APPROVE, FINALIZATION_VOTE_REJECT];
}

export function isFinalizationApproveChoice(choice: string) {
  return choice === FINALIZATION_VOTE_APPROVE || choice === LEGACY_FINALIZATION_VOTE_APPROVE;
}

export function isFinalizationRejectChoice(choice: string) {
  return choice === FINALIZATION_VOTE_REJECT || choice === LEGACY_FINALIZATION_VOTE_REJECT;
}

export function safeJsonParse<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export async function loadDebateWorkflow(userId: string, debateId: string): Promise<NormalizedDebateWorkflow | null> {
  const raw = await readDebateFile(userId, debateId, WORKFLOW_PATH);
  return safeParseWorkflowJson(raw);
}

export function isOfficialVotingAllowed(workflow: NormalizedDebateWorkflow | null, roundNumber: number) {
  if (!workflow?.enabled) return false;
  return roundNumber >= 1;
}

export function getWorkflowPhaseByKind(
  workflow: NormalizedDebateWorkflow | null,
  kind: "analysis" | "deliberation" | "finalization_vote" | "finalization"
) {
  return workflow?.phaseMachine.phases.find((phase) => phase.kind === kind) ?? null;
}

export function hasWorkflowPhase(
  workflow: NormalizedDebateWorkflow | null,
  kind: "analysis" | "deliberation" | "finalization_vote" | "finalization"
) {
  return Boolean(getWorkflowPhaseByKind(workflow, kind));
}

export function usesWorkflowFinalizationVotePhase(workflow: NormalizedDebateWorkflow | null) {
  if (!workflow?.enabled) return false;
  return hasWorkflowPhase(workflow, "finalization_vote");
}

export function usesWorkflowFinalizationPhase(workflow: NormalizedDebateWorkflow | null) {
  if (!workflow?.enabled) return false;
  return hasWorkflowPhase(workflow, "finalization");
}

export function getWorkflowPhaseMinRounds(
  workflow: NormalizedDebateWorkflow | null,
  kind: "analysis" | "deliberation" | "finalization_vote" | "finalization",
  fallback = 0
) {
  const minRounds = getWorkflowPhaseByKind(workflow, kind)?.minRounds;
  return typeof minRounds === "number" && Number.isFinite(minRounds) && minRounds >= 0 ? Math.floor(minRounds) : fallback;
}

export function getWorkflowMinimumAnalysisRounds(workflow: NormalizedDebateWorkflow | null) {
  if (!workflow?.enabled) return 0;
  return getWorkflowPhaseMinRounds(workflow, "analysis", 0);
}

export function getWorkflowEarliestDeliberationRound(workflow: NormalizedDebateWorkflow | null) {
  if (!workflow?.enabled) return 1;
  return Math.max(1, getWorkflowMinimumAnalysisRounds(workflow) + 1);
}

export function getWorkflowEarliestFinalizationVoteRound(workflow: NormalizedDebateWorkflow | null) {
  if (!workflow?.enabled) return 1;
  if (!usesWorkflowFinalizationVotePhase(workflow)) {
    return getWorkflowEarliestDeliberationRound(workflow);
  }
  const minimumDiscussionRounds = Math.max(1, getWorkflowPhaseMinRounds(workflow, "deliberation", 0));
  return getWorkflowEarliestDeliberationRound(workflow) + minimumDiscussionRounds;
}

export function getWorkflowEarliestFinalizationRound(workflow: NormalizedDebateWorkflow | null) {
  if (!workflow?.enabled) return 1;
  if (!usesWorkflowFinalizationPhase(workflow)) {
    return getWorkflowEarliestFinalizationVoteRound(workflow);
  }
  return getWorkflowEarliestFinalizationVoteRound(workflow) + Math.max(0, getWorkflowPhaseMinRounds(workflow, "finalization_vote", 1));
}

export async function listClosedOfficialVoteRounds(userId: string, debateId: string) {
  try {
    const db = await ensureDb();
    const result = await db
      .selectFrom("debate_files as f")
      .innerJoin("debates as d", "d.id", "f.debate_id")
      .select("f.path")
      .where("f.debate_id", "=", debateId)
      .where("d.user_id", "=", userId)
      .where("f.path", "like", "votes/round-%")
      .execute();
    const rounds = new Set<number>();
    for (const row of result) {
      const match = String(row.path ?? "").replace(/\\/g, "/").match(/^votes\/round-([0-9]{1,6})\.json$/);
      if (!match) continue;
      const round = Number(match[1]);
      if (Number.isFinite(round) && round > 0) rounds.add(Math.floor(round));
    }
    return [...rounds].sort((a, b) => a - b);
  } catch (error) {
    if (getPgErrorCode(error) === "42P01") return [];
    throw error;
  }
}

export function mapSpeechRoundIndexToActualRound(speechRoundIndex: number, closedVoteRounds: number[]) {
  if (!Number.isFinite(speechRoundIndex) || speechRoundIndex <= 0) return 1;
  const voteRounds = new Set(
    closedVoteRounds
      .filter((round) => Number.isFinite(round) && round > 0)
      .map((round) => Math.floor(round))
  );
  let actualRound = 0;
  let spokenRounds = 0;
  while (spokenRounds < speechRoundIndex) {
    actualRound += 1;
    if (voteRounds.has(actualRound)) continue;
    spokenRounds += 1;
  }
  return actualRound;
}

export function mapActualRoundToSpeechRoundIndex(actualRound: number, closedVoteRounds: number[]) {
  if (!Number.isFinite(actualRound) || actualRound <= 0) return null;
  const normalizedActualRound = Math.floor(actualRound);
  const voteRounds = new Set(
    closedVoteRounds
      .filter((round) => Number.isFinite(round) && round > 0)
      .map((round) => Math.floor(round))
  );
  if (voteRounds.has(normalizedActualRound)) return null;
  let speechRoundIndex = 0;
  for (let round = 1; round <= normalizedActualRound; round += 1) {
    if (voteRounds.has(round)) continue;
    speechRoundIndex += 1;
  }
  return speechRoundIndex > 0 ? speechRoundIndex : null;
}

export function resolveCurrentRoundNumberForWorkflow(input: {
  currentTurn: number;
  participantCount: number;
  openVote: OfficialVote | null;
  closedVoteRounds: number[];
}) {
  if (input.openVote?.status === "open") {
    return Math.max(1, Math.floor(Number(input.openVote.roundNumber) || 1));
  }
  const speechRoundIndex = Math.floor(Math.max(0, input.currentTurn) / Math.max(1, input.participantCount)) + 1;
  return mapSpeechRoundIndexToActualRound(speechRoundIndex, input.closedVoteRounds);
}

export function getWorkflowEarliestCompletionRound(workflow: NormalizedDebateWorkflow | null) {
  if (!workflow?.enabled) return 1;
  if (getWorkflowCompletionMode(workflow) !== "workflow_gate") {
    return Math.max(1, getWorkflowEarliestDeliberationRound(workflow));
  }
  return getWorkflowEarliestFinalizationRound(workflow) + Math.max(0, getWorkflowPhaseMinRounds(workflow, "finalization", 0) - 1);
}

export function getWorkflowCompletionMode(workflow: NormalizedDebateWorkflow | null) {
  if (!workflow?.enabled) return "consensus_only" as const;
  return workflow.completion.mode;
}

export function requiresWorkflowOutputsForCompletion(workflow: NormalizedDebateWorkflow | null) {
  const mode = getWorkflowCompletionMode(workflow);
  return mode === "consensus_plus_outputs" || mode === "workflow_gate";
}

export function requiresWorkflowFinalizationPhaseForCompletion(workflow: NormalizedDebateWorkflow | null) {
  if (!workflow?.enabled) return false;
  if (getWorkflowCompletionMode(workflow) !== "workflow_gate") return false;
  return workflow.phaseMachine.transitionRules.finalization.requirePhaseForCompletion;
}

export function getWorkflowOutputMaxTokens(
  workflow: NormalizedDebateWorkflow | null,
  phaseKind: "analysis" | "deliberation" | "finalization_vote" | "finalization" | null,
  agentMaxOutputTokens: number | null
) {
  const discussionBudget = workflow?.promptPolicies.outputBudget.discussionMaxTokens;
  const writingBudget = workflow?.promptPolicies.outputBudget.writingMaxTokens;
  const phaseBudget =
    phaseKind === "finalization"
      ? writingBudget === undefined
        ? 3600
        : writingBudget
      : discussionBudget === undefined
        ? 1800
        : discussionBudget;

  if (typeof agentMaxOutputTokens === "number" && Number.isFinite(agentMaxOutputTokens) && agentMaxOutputTokens > 0) {
    return typeof phaseBudget === "number" && Number.isFinite(phaseBudget) && phaseBudget > 0
      ? Math.min(Math.floor(phaseBudget), Math.floor(agentMaxOutputTokens))
      : Math.floor(agentMaxOutputTokens);
  }

  return phaseBudget;
}

export function resolveRequestedMaxTokens(maxTokens: number | null) {
  if (typeof maxTokens === "number" && Number.isFinite(maxTokens) && maxTokens > 0) {
    return Math.floor(maxTokens);
  }
  return 65_535;
}

export function withOptionalMaxTokens<T extends Record<string, unknown>>(body: T, maxTokens: number | null) {
  return { ...body, max_tokens: resolveRequestedMaxTokens(maxTokens) };
}

export function hasEnteredWorkflowFinalization(input: {
  workflow: NormalizedDebateWorkflow | null;
  roundNumber: number;
  persistedPhaseKind: DebateRecord["workflowPhaseKind"] | null | undefined;
}) {
  if (!input.workflow?.enabled) return false;
  if (getWorkflowCompletionMode(input.workflow) !== "workflow_gate") return false;
  if (input.roundNumber < getWorkflowEarliestFinalizationRound(input.workflow)) return false;
  return input.persistedPhaseKind === "finalization";
}

export async function listMissingRequiredDeliverables(input: {
  userId: string;
  debateId: string;
  workflow: NormalizedDebateWorkflow | null;
}) {
  const requiredFiles = input.workflow?.deliverables.requiredFiles ?? [];
  if (requiredFiles.length <= 0) return [];
  try {
    const requiredPaths = requiredFiles.map((file) => file.path);
    const db = await ensureDb();
    const result = await db
      .selectFrom("debate_files as f")
      .innerJoin("debates as d", "d.id", "f.debate_id")
      .select([
        "f.path",
        sql<string>`coalesce(f.content, '')`.as("content"),
        sql<number>`length(trim(coalesce(f.content, '')))::int`.as("content_length")
      ])
      .where("f.debate_id", "=", input.debateId)
      .where("d.user_id", "=", input.userId)
      .where("f.path", "in", requiredPaths)
      .execute();
    const contentByPath = new Map(
      result.map((row) => [
        String(row.path),
        {
          content: String(row.content ?? ""),
          contentLength: Number(row.content_length ?? 0)
        }
      ] as const)
    );
    return requiredFiles.filter((file) => {
      const payload = contentByPath.get(file.path) ?? { content: "", contentLength: 0 };
      const normalizedContent = payload.content.toLowerCase();
      if (payload.contentLength <= 0) return true;
      if (file.minChars && payload.contentLength < file.minChars) return true;
      if (file.minMarkdownHeadings) {
        const headingCount = payload.content
          .split(/\r?\n/)
          .filter((line) => /^\s{0,3}#{1,6}\s+\S/.test(line))
          .length;
        if (headingCount < file.minMarkdownHeadings) return true;
      }
      if (file.requiredSnippets.length > 0) {
        const missingSnippet = file.requiredSnippets.some((snippet) => !normalizedContent.includes(snippet.toLowerCase()));
        if (missingSnippet) return true;
      }
      if (file.qualityChecks.requiredTerms.length > 0) {
        const missingTerm = file.qualityChecks.requiredTerms.some((term) => !normalizedContent.includes(term.toLowerCase()));
        if (missingTerm) return true;
      }
      if (file.qualityChecks.requiredSections.length > 0) {
        const normalizedHeadings = payload.content
          .split(/\r?\n/)
          .filter((line) => /^\s{0,3}#{1,6}\s+\S/.test(line))
          .map((line) => line.replace(/^\s{0,3}#{1,6}\s+/, "").trim().toLowerCase());
        const missingSection = file.qualityChecks.requiredSections.some(
          (section) => !normalizedHeadings.some((heading) => heading.includes(section.toLowerCase()))
        );
        if (missingSection) return true;
      }
      if (file.qualityChecks.minBulletItems) {
        const bulletCount = payload.content
          .split(/\r?\n/)
          .filter((line) => /^\s*([-*+]|\d+\.)\s+\S/.test(line))
          .length;
        if (bulletCount < file.qualityChecks.minBulletItems) return true;
      }
      if (file.qualityChecks.counters.length > 0) {
        for (const counter of file.qualityChecks.counters) {
          const count = counter.patterns.reduce((sum, pattern) => {
            if (!pattern) return sum;
            const matches = normalizedContent.match(new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"));
            return sum + (matches?.length ?? 0);
          }, 0);
          if (count < counter.minCount) return true;
        }
      }
      return false;
    });
  } catch (error) {
    if (getPgErrorCode(error) === "42P01") return requiredFiles;
    throw error;
  }
}

export function resolveCurrentWorkflowPhase(input: {
  workflow: NormalizedDebateWorkflow | null;
  roundNumber: number;
  openVote: OfficialVote | null;
  latestVote?: OfficialVote | null;
  persistedPhaseKind?: DebateRecord["workflowPhaseKind"] | null;
}) {
  const phases = input.workflow?.phaseMachine.phases ?? [];
  const byKind = new Map(phases.map((phase) => [phase.kind, phase] as const));
  if (!input.workflow?.enabled) return null;
  if (input.openVote?.kind === "finalization") {
    return byKind.get("finalization_vote") ?? byKind.get("deliberation") ?? byKind.get("finalization") ?? null;
  }
  if (
    hasEnteredWorkflowFinalization({
      workflow: input.workflow,
      roundNumber: input.roundNumber,
      persistedPhaseKind: input.persistedPhaseKind
    })
  ) {
    return byKind.get("finalization") ?? byKind.get("deliberation") ?? null;
  }
  if (input.roundNumber < getWorkflowEarliestDeliberationRound(input.workflow)) {
    return byKind.get("analysis") ?? null;
  }
  return byKind.get("deliberation") ?? null;
}
