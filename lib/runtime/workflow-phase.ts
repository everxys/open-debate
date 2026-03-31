import { query } from "@/lib/db";
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
      kind: "election";
      roundNumber: number;
      title: string;
      roles: string[];
      candidates: Array<{ seat: string; name: string }>;
      ballots: Array<{
        debateAgentId: string;
        voter: string;
        voterSeat?: string;
        selections: Record<string, string>;
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
      status: "open";
      kind: "finalization";
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
      status: "open";
      kind: "custom";
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
      kind: "election";
      roundNumber: number;
      title: string;
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
  | {
      status: "closed";
      kind: "finalization";
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
  | {
      status: "closed";
      kind: "custom";
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
    };

export type OpenOfficialVote = Extract<OfficialVote, { status: "open" }>;
export type ClosedOfficialVote = Extract<OfficialVote, { status: "closed" }>;

export const FINALIZATION_VOTE_APPROVE = "同意进入 Phase 3";
export const FINALIZATION_VOTE_REJECT = "不同意，继续 Phase 2";

export function buildFinalizationVoteOptions() {
  return [FINALIZATION_VOTE_APPROVE, FINALIZATION_VOTE_REJECT];
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
  return roundNumber >= getWorkflowElectionStartRound(workflow);
}

export function getWorkflowElectionStartRound(workflow: NormalizedDebateWorkflow | null) {
  if (!workflow?.enabled) return 1;
  return workflow.phaseMachine.transitionRules.election.startRound;
}

export function getWorkflowPhaseByKind(
  workflow: NormalizedDebateWorkflow | null,
  kind: "analysis" | "election" | "deliberation" | "finalization_vote" | "finalization"
) {
  return workflow?.phaseMachine.phases.find((phase) => phase.kind === kind) ?? null;
}

export function getWorkflowPhaseMinRounds(
  workflow: NormalizedDebateWorkflow | null,
  kind: "analysis" | "election" | "deliberation" | "finalization_vote" | "finalization",
  fallback = 0
) {
  const minRounds = getWorkflowPhaseByKind(workflow, kind)?.minRounds;
  return typeof minRounds === "number" && Number.isFinite(minRounds) && minRounds >= 0 ? Math.floor(minRounds) : fallback;
}

export function getWorkflowMinimumAnalysisRounds(workflow: NormalizedDebateWorkflow | null) {
  if (!workflow?.enabled) return 0;
  return Math.max(getWorkflowElectionStartRound(workflow) - 1, getWorkflowPhaseMinRounds(workflow, "analysis", 0));
}

export function getWorkflowEarliestDeliberationRound(workflow: NormalizedDebateWorkflow | null) {
  if (!workflow?.enabled) return 1;
  return getWorkflowMinimumAnalysisRounds(workflow) + getWorkflowPhaseMinRounds(workflow, "election", 1) + 1;
}

export function getWorkflowEarliestFinalizationVoteRound(workflow: NormalizedDebateWorkflow | null) {
  if (!workflow?.enabled) return 1;
  const minimumDiscussionRounds = Math.max(1, getWorkflowPhaseMinRounds(workflow, "deliberation", 0));
  return getWorkflowEarliestDeliberationRound(workflow) + minimumDiscussionRounds;
}

export function getWorkflowEarliestFinalizationRound(workflow: NormalizedDebateWorkflow | null) {
  if (!workflow?.enabled) return 1;
  return getWorkflowEarliestFinalizationVoteRound(workflow) + Math.max(0, getWorkflowPhaseMinRounds(workflow, "finalization_vote", 1));
}

export async function listClosedOfficialVoteRounds(userId: string, debateId: string) {
  try {
    const result = await query<{ path: string }>(
      `
        select f.path
          from debate_files f
          join debates d on d.id = f.debate_id
         where f.debate_id = $1
           and d.user_id = $2
           and f.path like 'votes/round-%'
      `,
      [debateId, userId]
    );
    const rounds = new Set<number>();
    for (const row of result.rows) {
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
  return getWorkflowEarliestFinalizationRound(workflow) + Math.max(0, getWorkflowPhaseMinRounds(workflow, "finalization", 0) - 1);
}

export function getWorkflowOutputMaxTokens(
  workflow: NormalizedDebateWorkflow | null,
  phaseKind: "analysis" | "election" | "deliberation" | "finalization_vote" | "finalization" | null,
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
  if (input.roundNumber < getWorkflowElectionStartRound(input.workflow)) return false;
  if (input.roundNumber < getWorkflowEarliestFinalizationRound(input.workflow)) return false;
  return input.persistedPhaseKind === "finalization";
}

export function shouldAutoOpenWorkflowElectionAtBoundary(
  workflow: NormalizedDebateWorkflow | null,
  endedRound: number
) {
  if (!workflow?.enabled) return false;
  const electionRules = workflow.phaseMachine.transitionRules.election;
  return electionRules.autoOpen && endedRound === electionRules.startRound - 1;
}

export function isClosedElectionVotePassed(vote: OfficialVote | null | undefined) {
  if (!vote || vote.status !== "closed" || vote.kind !== "election") return false;
  const explicitPassed =
    typeof (vote.result as { passed?: unknown }).passed === "boolean"
      ? Boolean((vote.result as { passed?: boolean }).passed)
      : null;
  if (explicitPassed !== null) return explicitPassed;
  const roles = Array.isArray((vote.result as { roles?: unknown }).roles)
    ? (((vote.result as { roles?: unknown }).roles ?? []) as string[])
    : Object.keys((((vote.result as { winners?: unknown }).winners ?? {}) as Record<string, unknown>) ?? {});
  const winners = (((vote.result as { winners?: unknown }).winners ?? {}) as Record<string, unknown>) ?? {};
  return roles.length > 0 && roles.every((role) => typeof winners[role] === "string" && Boolean(String(winners[role])));
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
    const result = await query<{ path: string; content: string; content_length: number }>(
      `
        select f.path,
               coalesce(f.content, '') as content,
               length(trim(coalesce(f.content, '')))::int as content_length
          from debate_files f
          join debates d on d.id = f.debate_id
         where f.debate_id = $1
           and d.user_id = $2
           and f.path = any($3::text[])
      `,
      [input.debateId, input.userId, requiredPaths]
    );
    const contentByPath = new Map(
      result.rows.map((row) => [
        String(row.path),
        {
          content: String(row.content ?? ""),
          contentLength: Number(row.content_length ?? 0)
        }
      ] as const)
    );
    return requiredFiles.filter((file) => {
      const payload = contentByPath.get(file.path) ?? { content: "", contentLength: 0 };
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
        const normalizedContent = payload.content.toLowerCase();
        const missingSnippet = file.requiredSnippets.some((snippet) => !normalizedContent.includes(snippet.toLowerCase()));
        if (missingSnippet) return true;
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
  if (input.openVote?.kind === "election") return byKind.get("election") ?? null;
  if (input.openVote?.kind === "finalization") return byKind.get("finalization_vote") ?? null;
  const electionPassed =
    isClosedElectionVotePassed(input.latestVote) ||
    (input.persistedPhaseKind !== null &&
      input.persistedPhaseKind !== undefined &&
      input.persistedPhaseKind !== "analysis" &&
      input.persistedPhaseKind !== "election");
  if (
    hasEnteredWorkflowFinalization({
      workflow: input.workflow,
      roundNumber: input.roundNumber,
      persistedPhaseKind: input.persistedPhaseKind
    })
  ) {
    return byKind.get("finalization") ?? null;
  }
  if (input.roundNumber < getWorkflowElectionStartRound(input.workflow) || !electionPassed) {
    return byKind.get("analysis") ?? null;
  }
  return byKind.get("deliberation") ?? null;
}
