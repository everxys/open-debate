import { randomUUID } from "node:crypto";
import { sql } from "kysely";

import { getDebateParticipantRoleType, loadDebateParticipantRoleTypes, type DebateParticipantRoleType } from "@/lib/debate-role-types";
import { ensureDb } from "@/lib/db";
import {
  clearDebateLiveProgress,
  emitDebateLiveEvent,
  setDebateLiveProgress
} from "@/lib/debate-live";
import { AppError } from "@/lib/http";
import { pauseDebateForQuotaWait } from "@/lib/debate-resume-jobs";
import { isQuotaDelayError } from "@/lib/quota-control";
import { indexDebateContextChunk, splitTextIntoRetrievalChunks } from "@/lib/retrieval";
import {
  ANSWERS_DIR,
  DELIVERABLE_REPLACE_SHRINK_MIN_CHARS,
  DELIVERABLE_REPLACE_SHRINK_RATIO,
  ENABLE_DEBATE_MEMORY
} from "@/lib/runtime/constants";
import {
  getPhaseSnapshot,
  getPromptHardMaxChars
} from "@/lib/runtime/context-inline";
import {
  appendContextUsageLogAndUpdateTotals,
  appendGenerationDiagnostics,
  buildMemorySummaryMarkdown,
  bumpUsageSessionForDebateAgent,
  loadUsageBaselineByDebateAgentId,
  persistMemoryAfterTurn,
  refreshParticipantMemorySummary,
  updateContextUsageFile
} from "@/lib/runtime/memory";
import {
  readDebateFile,
  upsertDebateFile
} from "@/lib/runtime/file-store";
import {
  loadLatestVote,
  loadOpenVote
} from "@/lib/runtime/tools";
import {
  describeRuntimeError,
  logRuntimeEvent
} from "@/lib/runtime/provider-shared";
import {
  appendWithTrim,
  getPgErrorCode,
  safeParseJsonLine,
  sleep,
  splitJsonLines,
  trimToChars,
  truncateErrorMessage
} from "@/lib/runtime/runtime-utils";
import {
  aggregateConsensusByLastRound,
  normalizeAgentRow,
  normalizeDebateRow,
  normalizeDebateTurnRow,
  parseResponse
} from "@/lib/runtime/runtime-parsing";
import {
  autoRecoverFailedDebateOnce,
  finishDebate,
  isRecoverableRuntimeInterruption,
  pauseDebateAfterRuntimeInterruption,
  persistDebatePhaseSnapshot,
  setDebateRuntimeNotice
} from "@/lib/runtime/runtime-state";
import {
  startAutoSegmentAtBoundary,
  startAutoSegmentForDebateAgentAtBoundary
} from "@/lib/runtime/boundary-segments";
import {
  markRuntimeTurnMutationsCommitted,
  reconcileRuntimeTurnMutationState,
  rollbackRuntimeTurnMutationsByIds
} from "@/lib/runtime/runtime-action-harness";
import {
  buildFallbackVoteAnnouncement,
  maybeAutoCloseOpenVoteAtBoundary,
  maybeAutoOpenVoteAtBoundaryUsingWorkflow
} from "@/lib/runtime/boundary-votes";
import {
  loadDebateAgentSystemPrompt,
  loadDebateParticipantsInline
} from "@/lib/runtime/runtime-inline-loaders";
import {
  enqueueRoundSummaryJob,
  enqueueTurnSummaryJob
} from "@/lib/runtime/summary-orchestration";
import { maybeGenerateVoteAnnouncementWithSeat1 } from "@/lib/runtime/vote-announcement";
import {
  getDebateRunSnapshot,
  releaseDebateRun,
  touchDebateRun,
  tryAcquireDebateRun
} from "@/lib/runtime/run-registry";
import { appendServerLog } from "@/lib/server-log";
import type { AgentRecord, DebateRecord, DebateTurnRecord } from "@/lib/types";
import {
  type NormalizedDebateWorkflow,
  type NormalizedWorkflowRequiredFile,
  type NormalizedWorkflowContextAccessRule,
  type WorkflowContextAccessScope,
  type WorkflowPhaseKind
} from "@/lib/workflow";
import {
  buildFinalizationVoteOptions,
  ClosedOfficialVote,
  FINALIZATION_VOTE_APPROVE,
  FINALIZATION_VOTE_REJECT,
  getWorkflowEarliestCompletionRound,
  getWorkflowEarliestDeliberationRound,
  getWorkflowEarliestFinalizationRound,
  getWorkflowEarliestFinalizationVoteRound,
  getWorkflowCompletionMode,
  getWorkflowMinimumAnalysisRounds,
  getWorkflowOutputMaxTokens,
  hasWorkflowPhase,
  getWorkflowPhaseMinRounds,
  getWorkflowPhaseByKind,
  isOfficialVotingAllowed,
  listClosedOfficialVoteRounds,
  listMissingRequiredDeliverables,
  loadDebateWorkflow,
  mapActualRoundToSpeechRoundIndex,
  mapSpeechRoundIndexToActualRound,
  OpenOfficialVote,
  resolveCurrentRoundNumberForWorkflow,
  resolveCurrentWorkflowPhase,
  resolveRequestedMaxTokens,
  requiresWorkflowFinalizationPhaseForCompletion,
  requiresWorkflowOutputsForCompletion,
  safeJsonParse,
  withOptionalMaxTokens
} from "@/lib/runtime/workflow-phase";

export {
  buildAnthropicTools,
  buildBaseSystemPrompt,
  buildFileToolInstructions,
  buildOpenAiTools,
  buildResponseFormatInstructions,
  clipMessagesToInputLimit,
  describeRuntimeError,
  emitChunks,
  estimatePromptTokensFromChars,
  logRuntimeEvent,
  looksLikeToolsUnsupported,
  summarizeOptionText
} from "@/lib/runtime/provider-shared";
export {
  appendContextUsageLogAndUpdateTotals,
  appendGenerationDiagnostics,
  buildMemorySummaryMarkdown,
  bumpUsageSessionForDebateAgent,
  loadUsageBaselineByDebateAgentId,
  persistMemoryAfterTurn,
  refreshParticipantMemorySummary,
  updateContextUsageFile
} from "@/lib/runtime/memory";
export {
  appendWithTrim,
  getPgErrorCode,
  safeParseJsonLine,
  sleep,
  splitJsonLines,
  trimToChars,
  truncateErrorMessage
} from "@/lib/runtime/runtime-utils";
export {
  aggregateConsensusByLastRound,
  normalizeAgentRow,
  normalizeDebateRow,
  parseResponse
} from "@/lib/runtime/runtime-parsing";
export {
  finishDebate,
  isNonRetryableSummaryJobError,
  isRecoverableRuntimeInterruption,
  pauseDebateAfterRuntimeInterruption,
  persistDebatePhaseSnapshot,
  setDebateRuntimeNotice
} from "@/lib/runtime/runtime-state";
export {
  startAutoSegmentAtBoundary,
  startAutoSegmentForDebateAgentAtBoundary
} from "@/lib/runtime/boundary-segments";
export {
  buildFallbackVoteAnnouncement,
  maybeAutoCloseOpenVoteAtBoundary,
  maybeAutoOpenVoteAtBoundaryUsingWorkflow
} from "@/lib/runtime/boundary-votes";
export {
  getDebateFileMeta,
  insertDebateFileVersionRecord,
  isMissingTableError,
  recordDebateFileActivity,
  recordImplicitFileReads,
  toolDebateFilesStat,
  toolDebateFilesWrite,
  toolListFiles,
  toolListFilesFromAgent,
  toolReadDebateFile,
  toolReadFile,
  toolReadFileFromAgent,
  toolSearchFiles,
  toolSearchFilesFromAgent,
  writeDebateFileWithMode
} from "@/lib/runtime/debate-file-access";
export {
  buildWorkflowPhaseInline,
  formatRecentTurnsInline,
  listSeatContextFilesForRule,
  listSharedContextFilesForRule,
  loadAgentFilesInline,
  loadContextAccessAutoReadInline,
  loadContextWindowMinTurnNumber,
  loadContextWindowMinTurnNumberForDebateAgent,
  loadDebateAgentFilesInline,
  loadDebateAgentMemoryInline,
  loadDebateAgentSegmentInline,
  loadDebateAgentSystemPrompt,
  loadDebateParticipantsInline,
  loadDebateSeatInline,
  loadDebateSegmentInline,
  loadRecentTurnRows,
  loadSharedFactsBoardInline,
  loadWorkflowIdeaBankInline,
  resolveDebateIdeaBankPaths
} from "@/lib/runtime/runtime-inline-loaders";
export type { RecentTurnRow } from "@/lib/runtime/runtime-inline-loaders";
export {
  generateRoundSummary,
  generateTurnSummary,
  getFactsBoardPath,
  getRoundSummaryPath,
  getTurnSummaryPath,
  refreshFactsBoardFromSummaries
} from "@/lib/runtime/summary-generation";
export { runSummaryJobByRecord } from "@/lib/runtime/summary-orchestration";
export { maybeGenerateVoteAnnouncementWithSeat1 } from "@/lib/runtime/vote-announcement";
export { appendWorkflowSummaryLines } from "@/lib/runtime/workflow-summary";
export type { DebateFileWriteMode } from "@/lib/runtime/tools";
export type { DebateFileActivityAction, DebateFileActivityAudit } from "@/lib/runtime/debate-file-access";

export async function persistAnswerAfterTurn(input: {
  userId: string;
  debateId: string;
  roundNumber: number;
  turnNumber: number;
  agentName: string;
  content: string;
  now: string;
}) {
  const answersPath = `${ANSWERS_DIR}round-${input.roundNumber}/turn-${input.turnNumber}.md`;
  const lines: string[] = [];
  lines.push(`# Turn ${input.turnNumber} · Round ${input.roundNumber}`);
  lines.push("");
  lines.push(`- Speaker: ${input.agentName}`);
  lines.push(`- Timestamp: ${input.now}`);
  lines.push("");
  lines.push(input.content.trim());
  lines.push("");
  await upsertDebateFile(input.debateId, answersPath, lines.join("\n"), input.now);
}

async function reconcileDebateProgressFromPersistedTurns(input: {
  db: Awaited<ReturnType<typeof ensureDb>>;
  userId: string;
  debate: DebateRecord;
  participantCount: number;
}) {
  const turnRows = await input.db
    .selectFrom("debate_turns")
    .selectAll()
    .where("debate_id", "=", input.debate.id)
    .orderBy("turn_number", "asc")
    .orderBy("created_at", "asc")
    .execute();
  if (turnRows.length <= 0) return input.debate;

  const turns = turnRows.map((row) => normalizeDebateTurnRow(row as Record<string, unknown>));
  const persistedCurrentTurn = turns.reduce((max, turn) => Math.max(max, turn.turnNumber), 0);
  if (persistedCurrentTurn <= input.debate.currentTurn) return input.debate;

  const workflow = await loadDebateWorkflow(input.userId, input.debate.id);
  const closedVoteRounds = await listClosedOfficialVoteRounds(input.userId, input.debate.id);
  const openVote = await loadOpenVote(input.userId, input.debate.id);
  const latestVote = await loadLatestVote(input.userId, input.debate.id);
  const consensus = aggregateConsensusByLastRound(turns, input.participantCount, workflow?.consensus ?? null);
  const totalTokenUsed = turns.reduce((sum, turn) => sum + Math.max(0, turn.tokenUsed), 0);
  const mustKeepRunningForVote = Boolean(openVote);
  const currentSpeechRoundIndexAfterTurn =
    Math.floor(Math.max(0, persistedCurrentTurn - 1) / Math.max(1, input.participantCount)) + 1;
  const currentRoundNumberAfterTurn = mapSpeechRoundIndexToActualRound(currentSpeechRoundIndexAfterTurn, closedVoteRounds);
  const finalizationPhase = resolveCurrentWorkflowPhase({
    workflow,
    roundNumber: currentRoundNumberAfterTurn,
    openVote,
    latestVote,
    persistedPhaseKind: input.debate.workflowPhaseKind
  });
  const requiresFinalizationPhase = requiresWorkflowFinalizationPhaseForCompletion(workflow);
  const requiresOutputs = requiresWorkflowOutputsForCompletion(workflow);
  const canCompleteByPhase =
    requiresFinalizationPhase
      ? finalizationPhase?.kind === "finalization" && currentRoundNumberAfterTurn >= getWorkflowEarliestCompletionRound(workflow)
      : currentRoundNumberAfterTurn >= getWorkflowEarliestCompletionRound(workflow);
  const missingDeliverables = requiresOutputs
    ? await listMissingRequiredDeliverables({
        userId: input.userId,
        debateId: input.debate.id,
        workflow
      })
    : [];
  const canCompleteByDeliverables = missingDeliverables.length === 0;
  const consensusRequired = workflow?.consensus.enabled !== false;
  const canCompleteByConsensus = !consensusRequired || consensus.reached;
  const consensusReachedForDb = mustKeepRunningForVote ? false : consensus.reached;
  const reconciledStatus =
    input.debate.status === "running" && !mustKeepRunningForVote && canCompleteByConsensus && canCompleteByPhase && canCompleteByDeliverables
      ? "completed"
      : input.debate.status;
  const phaseSnapshot = getPhaseSnapshot(finalizationPhase, currentRoundNumberAfterTurn);
  const reconciledAt = turns[turns.length - 1]?.createdAt ?? new Date().toISOString();

  const updated = await input.db
    .updateTable("debates")
    .set({
      current_turn: persistedCurrentTurn,
      token_used: totalTokenUsed,
      consensus_summary: consensus.leadingSolution
        ? JSON.stringify({
            leadingSolution: consensus.leadingSolution,
            score: consensus.score
          })
        : null,
      consensus_reached: consensusReachedForDb,
      workflow_phase_kind: phaseSnapshot.workflowPhaseKind,
      workflow_phase_title: phaseSnapshot.workflowPhaseTitle,
      workflow_phase_round: phaseSnapshot.workflowPhaseRound,
      status: reconciledStatus,
      finished_at: reconciledStatus === "completed" ? reconciledAt : input.debate.finishedAt,
      updated_at: reconciledAt
    })
    .where("id", "=", input.debate.id)
    .returningAll()
    .executeTakeFirst();

  await logRuntimeEvent("warn", "debate progress reconciled from persisted turns", {
    debateId: input.debate.id,
    previousCurrentTurn: input.debate.currentTurn,
    persistedCurrentTurn,
    totalTokenUsed,
    reconciledStatus
  });

  return updated ? normalizeDebateRow(updated as Record<string, unknown>) : input.debate;
}

export function rotateOrder<T>(items: T[], offset: number) {
  const n = items.length;
  if (n <= 1) return items.slice();
  const k = ((offset % n) + n) % n;
  if (k === 0) return items.slice();
  return [...items.slice(k), ...items.slice(0, k)];
}

export async function callProvider(
  debate: DebateRecord,
  agent: AgentRecord,
  messageNumber: number,
  roundNumber: number,
  participantCount: number,
  userId: string,
  debateAgentId: string,
  eventAgentName: string,
  baseRoleName: string
) {
  // NOTE: keep provider orchestration lazily loaded until shared runtime helpers
  // are fully extracted from this file; this avoids a runtime import cycle.
  const { callProvider: callProviderFromProviderOrchestration } = await import("@/lib/runtime/provider-orchestration");
  return callProviderFromProviderOrchestration(
    debate,
    agent,
    messageNumber,
    roundNumber,
    participantCount,
    userId,
    debateAgentId,
    eventAgentName,
    baseRoleName
  );
}

export async function runDebate(id: string, userId: string) {
  const acquired = tryAcquireDebateRun(id, userId);
  if (!acquired.acquired) {
    const existing = getDebateRunSnapshot(id);
    await logRuntimeEvent("warn", "debate runtime skipped because another run is active", {
      debateId: id,
      userId,
      activeSince: existing ? new Date(existing.startedAt).toISOString() : null,
      lastHeartbeatAt: existing ? new Date(existing.heartbeatAt).toISOString() : null,
      activeRunUserId: existing?.userId ?? null,
      activeDurationMs: existing ? Math.max(0, Date.now() - existing.startedAt) : null
    });
    return;
  }

  const { runToken } = acquired.snapshot;
  let lastKnownPhase: Pick<DebateRecord, "workflowPhaseKind" | "workflowPhaseTitle" | "workflowPhaseRound"> | null = null;
  let shouldAutoRestartAfterFailure = false;

  try {
    const pendingAutoSegmentByDebateAgentId = new Map<string, { reason: string }>();
    while (true) {
      touchDebateRun(id, runToken);
      const db = await ensureDb();
      const debateResult = await db
        .selectFrom("debates")
        .selectAll()
        .where("id", "=", id)
        .where("user_id", "=", userId)
        .executeTakeFirst();
      if (!debateResult) {
        break;
      }

      let debate = normalizeDebateRow(debateResult as Record<string, unknown>);
      if (debate.status !== "running") {
        break;
      }
      if (debate.runtimeNoticeKind === "recovering") {
        const recoveredAt = new Date().toISOString();
        await setDebateRuntimeNotice(id, {
          runtimeNoticeKind: "recovered",
          runtimeNoticeMessage: "进程中断后已自动恢复，当前辩论已重新接管并继续运行",
          runtimeNoticeAt: recoveredAt
        });
        emitDebateLiveEvent(id, {
          type: "status",
          debateId: id,
          message: "检测到进程中断，已自动恢复并继续运行",
          at: recoveredAt
        });
      }
      let participantRows = await db
        .selectFrom("debate_agents")
        .selectAll()
        .where("debate_id", "=", id)
        .orderBy("turn_order", "asc")
        .execute();
      const participantCount = participantRows.length;
      const roleAssignments = await loadDebateParticipantRoleTypes(userId, id);
      if (participantCount < 2) {
        throw new AppError("VALIDATION_ERROR", 400, "Debate requires at least 2 agents");
      }
      debate = await reconcileDebateProgressFromPersistedTurns({
        db,
        userId,
        debate,
        participantCount
      });
      if (debate.status !== "running") {
        break;
      }

      const workflowBeforeTurn = await loadDebateWorkflow(userId, id);
      const openVoteBeforeTurn = await loadOpenVote(userId, id);
      const latestVoteBeforeTurn = await loadLatestVote(userId, id);
      const closedVoteRoundsBeforeTurn = await listClosedOfficialVoteRounds(userId, id);
      const completedSpeakingRounds = Math.floor(debate.currentTurn / participantCount);
      const currentRoundNumberBeforeTurn = resolveCurrentRoundNumberForWorkflow({
        currentTurn: debate.currentTurn,
        participantCount,
        openVote: openVoteBeforeTurn,
        closedVoteRounds: closedVoteRoundsBeforeTurn
      });
      const phaseBeforeTurn = resolveCurrentWorkflowPhase({
        workflow: workflowBeforeTurn,
        roundNumber: currentRoundNumberBeforeTurn,
        openVote: openVoteBeforeTurn,
        latestVote: latestVoteBeforeTurn,
        persistedPhaseKind: debate.workflowPhaseKind
      });
      const phaseSnapshotBeforeTurn = getPhaseSnapshot(phaseBeforeTurn, currentRoundNumberBeforeTurn);
      const shouldPersistPhaseSnapshot =
        lastKnownPhase?.workflowPhaseKind !== phaseSnapshotBeforeTurn.workflowPhaseKind ||
        lastKnownPhase?.workflowPhaseTitle !== phaseSnapshotBeforeTurn.workflowPhaseTitle ||
        lastKnownPhase?.workflowPhaseRound !== phaseSnapshotBeforeTurn.workflowPhaseRound;
      if (shouldPersistPhaseSnapshot) {
        await persistDebatePhaseSnapshot(id, phaseSnapshotBeforeTurn);
        lastKnownPhase = phaseSnapshotBeforeTurn;
      }
      if (debate.maxTurns > 0 && completedSpeakingRounds >= debate.maxTurns) {
        const consensusRequiredBeforeTurn = workflowBeforeTurn?.consensus.enabled !== false;
        const consensusReachedBeforeTurn = !consensusRequiredBeforeTurn || Boolean(debate.consensusReached);
        const requiresFinalizationPhase = requiresWorkflowFinalizationPhaseForCompletion(workflowBeforeTurn);
        const requiresOutputs = requiresWorkflowOutputsForCompletion(workflowBeforeTurn);
        const earliestCompletionRound = getWorkflowEarliestCompletionRound(workflowBeforeTurn);
        const missingDeliverables = requiresOutputs
          ? await listMissingRequiredDeliverables({
              userId,
              debateId: id,
              workflow: workflowBeforeTurn
            })
          : [];
        if (
          consensusReachedBeforeTurn &&
          (!requiresFinalizationPhase || phaseBeforeTurn?.kind === "finalization") &&
          currentRoundNumberBeforeTurn >= earliestCompletionRound &&
          missingDeliverables.length === 0
        ) {
          await finishDebate(id, "completed", undefined, { phase: lastKnownPhase });
        } else if (missingDeliverables.length > 0) {
          await finishDebate(
            id,
            "stopped",
            `max turns reached before required deliverables were written: ${missingDeliverables.map((file) => file.path).join(", ")}`,
            { phase: lastKnownPhase }
          );
        } else if (currentRoundNumberBeforeTurn < earliestCompletionRound) {
          await finishDebate(id, "stopped", `max turns reached before workflow minimum completion round ${earliestCompletionRound}`, {
            phase: lastKnownPhase
          });
        } else if (!consensusReachedBeforeTurn) {
          await finishDebate(id, "stopped", "max turns reached before consensus was reached", { phase: lastKnownPhase });
        } else {
          await finishDebate(id, "stopped", "max turns reached before consolidation phase", { phase: lastKnownPhase });
        }
        break;
      }

      const currentIndex = debate.currentTurn % participantCount;
      const currentParticipant = participantRows[currentIndex];
      const agentResult = await db
        .selectFrom("ai_agents")
        .selectAll()
        .where("id", "=", String((currentParticipant as { ai_agent_id?: unknown }).ai_agent_id))
        .where("user_id", "=", userId)
        .executeTakeFirst();
      if (!agentResult) {
        throw new AppError("NOT_FOUND", 404, "Agent not found for debate");
      }

      const agent = normalizeAgentRow(agentResult as Record<string, unknown>);
      const seatNumberForEvent =
        typeof (currentParticipant as any).turn_order === "number"
          ? Number((currentParticipant as any).turn_order)
          : typeof (currentParticipant as any).turnOrder === "number"
            ? Number((currentParticipant as any).turnOrder)
            : currentIndex + 1;
      const displayNameForEvent =
        typeof (currentParticipant as any).display_name === "string"
          ? String((currentParticipant as any).display_name)
          : typeof (currentParticipant as any).displayName === "string"
            ? String((currentParticipant as any).displayName)
            : "";
      const baseRoleNameForEvent = getDebateParticipantRoleType(roleAssignments, String(currentParticipant.id));
      const eventAgentName = `Seat-${seatNumberForEvent}${displayNameForEvent ? ` · ${displayNameForEvent}` : ""}`;
      const currentSpeechRoundIndex = Math.floor(Math.max(0, debate.currentTurn) / Math.max(1, participantCount)) + 1;
      const actualRoundNumber = mapSpeechRoundIndexToActualRound(currentSpeechRoundIndex, closedVoteRoundsBeforeTurn);
      const messageNumber = debate.currentTurn + 1;
      const roundNumber = actualRoundNumber;
      await reconcileRuntimeTurnMutationState({
        debateId: id,
        currentTurnNumber: messageNumber,
        now: new Date().toISOString()
      });
      setDebateLiveProgress({
        debateId: id,
        roundNumber: actualRoundNumber,
        messageNumber,
        debateAgentId: String(currentParticipant.id),
        aiAgentId: String(currentParticipant.ai_agent_id),
        agentName: eventAgentName,
        baseRoleName: baseRoleNameForEvent,
        stage: "calling_model"
      });
      const startedAt = Date.now();
      let raw = "";
      let usage: { promptTokens: number | null; completionTokens: number | null; totalTokens: number | null } | null = null;
      let estimatedPromptTokens: number | null = null;
      let promptChars: number | null = null;
      let generationDiagnostics:
        | {
            provider: string;
            model: string;
            requestedMaxTokens: number;
            finishReason: string | null;
            toolCallsCount: number;
          }
        | null = null;
      let mutationJournalIds: string[] = [];
      let retryCount = 0;

      while (retryCount <= 2) {
        try {
          const result = await callProvider(
            debate,
            agent,
            messageNumber,
            roundNumber,
            participantCount,
            userId,
            String(currentParticipant.id),
            eventAgentName,
            baseRoleNameForEvent
          );
          raw = result.raw;
          usage = result.usage;
          estimatedPromptTokens =
            typeof (result as { estimatedPromptTokens?: unknown }).estimatedPromptTokens === "number"
              ? Number((result as { estimatedPromptTokens: number }).estimatedPromptTokens)
              : null;
          promptChars =
            typeof (result as { promptChars?: unknown }).promptChars === "number"
              ? Number((result as { promptChars: number }).promptChars)
              : null;
          mutationJournalIds = Array.isArray((result as { mutationJournalIds?: unknown }).mutationJournalIds)
            ? ((result as { mutationJournalIds: unknown[] }).mutationJournalIds).map((item) => String(item))
            : [];
          generationDiagnostics =
            result && typeof result === "object" && "diagnostics" in result
              ? ((result as {
                  diagnostics?: {
                    provider: string;
                    model: string;
                    requestedMaxTokens: number;
                    finishReason: string | null;
                    toolCallsCount: number;
                  };
                }).diagnostics ?? null)
              : null;
          break;
        } catch (error) {
          if (isQuotaDelayError(error)) {
            throw error;
          }
          const details = describeRuntimeError(error);
          retryCount += 1;
          emitDebateLiveEvent(id, {
            type: "status",
            debateId: id,
            message:
              retryCount > 2
                ? `当前席位生成失败，未写入本回合内容：${details.message}`
                : `第 ${retryCount} 次请求失败，正在重试：${details.message}`,
            at: new Date().toISOString()
          });
          if (retryCount > 2) {
            try {
              await appendGenerationDiagnostics({
                userId,
                debateId: id,
                now: new Date().toISOString(),
                entry: {
                  at: new Date().toISOString(),
                  turnNumber: debate.currentTurn + 1,
                  roundNumber,
                  debateAgentId: String(currentParticipant.id),
                  seatNumber:
                    typeof (currentParticipant as any).turn_order === "number"
                      ? Number((currentParticipant as any).turn_order)
                      : typeof (currentParticipant as any).turnOrder === "number"
                        ? Number((currentParticipant as any).turnOrder)
                        : currentIndex + 1,
                  agentName: eventAgentName,
                  provider: agent.provider,
                  model: agent.model,
                  requestedMaxTokens: resolveRequestedMaxTokens(
                    getWorkflowOutputMaxTokens(workflowBeforeTurn, phaseBeforeTurn?.kind ?? null, agent.maxOutputTokens),
                    agent.provider
                  ),
                  finishReason: null,
                  toolCallsCount: 0,
                  rawChars: 0,
                  persistedChars: 0,
                  parseStatus: null,
                  structuredOutput: false,
                  voteOnlyOverride: false,
                  persisted: false,
                  errorCode: details.code ?? "RUNTIME_ERROR",
                  errorMessage: details.message,
                  attemptCount: retryCount
                }
              });
            } catch (diagnosticError) {
              await logRuntimeEvent("warn", "generation diagnostics persistence failed after provider error", {
                debateId: id,
                error: describeRuntimeError(diagnosticError)
              });
            }
            throw error;
          }
          await sleep(500);
        }
      }

      setDebateLiveProgress({
        debateId: id,
        roundNumber,
        messageNumber,
        debateAgentId: String(currentParticipant.id),
        aiAgentId: String(currentParticipant.ai_agent_id),
        agentName: eventAgentName,
        baseRoleName: baseRoleNameForEvent,
        stage: "parsing"
      });
      const parsed = parseResponse(raw);
      const persistedResponse = parsed;
      emitDebateLiveEvent(id, {
        type: "status",
        debateId: id,
        message: "解析与保存中...",
        at: new Date().toISOString()
      });
      const tokenUsed = Math.max(80, Math.ceil(raw.length / 3));
      const responseTimeMs = Date.now() - startedAt;
      const createdAt = new Date().toISOString();

      setDebateLiveProgress({
        debateId: id,
        roundNumber,
        messageNumber,
        debateAgentId: String(currentParticipant.id),
        aiAgentId: String(currentParticipant.ai_agent_id),
        agentName: eventAgentName,
        baseRoleName: baseRoleNameForEvent,
        stage: "saving",
        updatedAt: createdAt
      });
      const turnPersisted = await db.transaction().execute(async (trx) => {
        await trx.executeQuery(sql`select pg_advisory_xact_lock(hashtextextended(${id}, 0))`.compile(trx));
        const existing = await trx
          .selectFrom("debate_turns")
          .select(["id"])
          .where("debate_id", "=", id)
          .where("turn_number", "=", messageNumber)
          .executeTakeFirst();
        if (existing) return false;

        await trx.executeQuery(sql`
          insert into debate_turns (
            id, debate_id, ai_agent_id, debate_agent_id, seat_number, turn_number, content, structured_output,
            parse_status, token_used, response_time_ms, retry_count, error_code, created_at
          ) values (
            ${randomUUID()},
            ${id},
            ${String((currentParticipant as { ai_agent_id?: unknown }).ai_agent_id)},
            ${String((currentParticipant as { id?: unknown }).id)},
            ${typeof (currentParticipant as any).turn_order === "number"
              ? Number((currentParticipant as any).turn_order)
              : typeof (currentParticipant as any).turnOrder === "number"
                ? Number((currentParticipant as any).turnOrder)
                : currentIndex + 1},
            ${messageNumber},
            ${persistedResponse.content},
            ${persistedResponse.structuredOutput ? JSON.stringify(persistedResponse.structuredOutput) : null},
            ${persistedResponse.parseStatus},
            ${tokenUsed},
            ${responseTimeMs},
            ${retryCount},
            ${null},
            ${createdAt}
          )
        `.compile(trx));
        return true;
      });

      if (!turnPersisted) {
        await rollbackRuntimeTurnMutationsByIds(mutationJournalIds, createdAt).catch(() => null);
        await logRuntimeEvent("warn", "skip duplicate turn persistence", {
          debateId: id,
          turnNumber: messageNumber,
          debateAgentId: String(currentParticipant.id)
        });
        continue;
      }
      await markRuntimeTurnMutationsCommitted(mutationJournalIds, createdAt).catch(() => null);

      try {
        const turnChunks = splitTextIntoRetrievalChunks(persistedResponse.content, 1_200, 180);
        for (let chunkIndex = 0; chunkIndex < turnChunks.length; chunkIndex += 1) {
          // eslint-disable-next-line no-await-in-loop
          await indexDebateContextChunk({
            userId,
            debateId: id,
            debateAgentId: String(currentParticipant.id),
            chunkKey: `turn:${messageNumber}:chunk:${chunkIndex + 1}`,
            sourceType: "turn",
            turnNumberStart: messageNumber,
            turnNumberEnd: messageNumber,
            roundNumber,
            content: turnChunks[chunkIndex],
            now: createdAt
          });
        }
      } catch (error) {
        await logRuntimeEvent("warn", "turn retrieval indexing failed", {
          debateId: id,
          error: describeRuntimeError(error)
        });
      }

      try {
        await appendGenerationDiagnostics({
          userId,
          debateId: id,
          now: createdAt,
          entry: {
            at: createdAt,
            turnNumber: messageNumber,
            roundNumber,
            debateAgentId: String(currentParticipant.id),
            seatNumber:
              typeof (currentParticipant as any).turn_order === "number"
                ? Number((currentParticipant as any).turn_order)
                : typeof (currentParticipant as any).turnOrder === "number"
                  ? Number((currentParticipant as any).turnOrder)
                  : currentIndex + 1,
            agentName: eventAgentName,
            provider: generationDiagnostics?.provider ?? agent.provider,
            model: generationDiagnostics?.model ?? agent.model,
            requestedMaxTokens: generationDiagnostics?.requestedMaxTokens ?? null,
            finishReason: generationDiagnostics?.finishReason ?? null,
            toolCallsCount: generationDiagnostics?.toolCallsCount ?? 0,
            rawChars: raw.length,
            persistedChars: persistedResponse.content.length,
            parseStatus: persistedResponse.parseStatus,
            structuredOutput: Boolean(persistedResponse.structuredOutput),
            voteOnlyOverride: false
          }
        });
      } catch (error) {
        await logRuntimeEvent("warn", "generation diagnostics persistence failed", {
          debateId: id,
          error: describeRuntimeError(error)
        });
      }

      await db.executeQuery(sql`
        update debate_agents set turn_count = turn_count + 1 where id = ${String(currentParticipant.id)}
      `.compile(db));

      try {
        const apiPromptTokens =
          usage?.promptTokens && typeof usage.promptTokens === "number" && usage.promptTokens > 0
            ? Math.floor(usage.promptTokens)
            : null;
        const fallbackPromptTokens =
          estimatedPromptTokens !== null && Number.isFinite(estimatedPromptTokens) && estimatedPromptTokens > 0
            ? Math.floor(estimatedPromptTokens)
            : null;
        const usedPromptTokens = apiPromptTokens ?? fallbackPromptTokens;
        const completionTokens = usage?.completionTokens ?? null;

        if (usedPromptTokens !== null) {
          const seat = `Seat-${Number((currentParticipant as any).turn_order ?? (currentParticipant as any).turnOrder ?? currentIndex + 1)}`;
          const source = apiPromptTokens !== null ? "api" : "estimate";
          const totals = await appendContextUsageLogAndUpdateTotals({
            userId,
            debateId: id,
            debateAgentId: String(currentParticipant.id),
            seat,
            agent,
            contextLength: agent.contextLength,
            apiPromptTokens,
            estimatedPromptTokens: fallbackPromptTokens,
            usedPromptTokens,
            multiplier: 1,
            source,
            turnNumber: messageNumber,
            roundNumber,
            now: createdAt
          });
          if (totals.ratio !== null && Number.isFinite(totals.ratio) && totals.ratio >= 0.75) {
            pendingAutoSegmentByDebateAgentId.set(String(currentParticipant.id), {
              reason: `auto: session_prompt_tokens=${totals.sessionPromptTokens}; context_length=${totals.contextLength}; ratio=${totals.ratio.toFixed(4)}; agent=${agent.name}`
            });
          }
        }

        const promptCharRatio =
          promptChars !== null && promptChars > 0
            ? promptChars / getPromptHardMaxChars(agent)
            : null;
        if (promptCharRatio !== null && Number.isFinite(promptCharRatio) && promptCharRatio >= 0.82) {
          pendingAutoSegmentByDebateAgentId.set(String(currentParticipant.id), {
            reason: `auto: prompt_chars=${promptChars}; hard_cap=${getPromptHardMaxChars(agent)}; ratio=${promptCharRatio.toFixed(4)}; agent=${agent.name}`
          });
        }

        await updateContextUsageFile({
          userId,
          debateId: id,
          debateAgentId: String(currentParticipant.id),
          agent,
          usage: {
            promptTokens: usedPromptTokens,
            completionTokens,
            totalTokens:
              usage?.totalTokens ??
              (usedPromptTokens !== null && completionTokens !== null ? usedPromptTokens + completionTokens : null)
          },
          source: apiPromptTokens !== null ? "api" : "estimate",
          turnNumber: messageNumber,
          now: createdAt
        });
      } catch (error) {
        await logRuntimeEvent("warn", "context usage persistence failed", { debateId: id, error: describeRuntimeError(error) });
      }

       emitDebateLiveEvent(id, {
         type: "turn_end",
         debateId: id,
         turnNumber: messageNumber,
         agentName: eventAgentName,
         at: createdAt
       });

      try {
        await Promise.all([
          persistMemoryAfterTurn({
            userId,
            debateId: id,
            debateAgentId: String(currentParticipant.id),
            agentName: eventAgentName,
            debateQuestion: debate.question,
            turnNumber: messageNumber,
            content: persistedResponse.content,
            structuredOutput: persistedResponse.structuredOutput,
            now: createdAt
          }),
          persistAnswerAfterTurn({
            userId,
            debateId: id,
            roundNumber,
            turnNumber: messageNumber,
            agentName: eventAgentName,
            content: persistedResponse.content,
            now: createdAt
          })
        ]);
      } catch (error) {
        await logRuntimeEvent("warn", "memory persistence failed", { debateId: id, error: describeRuntimeError(error) });
      }

      const workflow = await loadDebateWorkflow(userId, id);
      try {
        await enqueueTurnSummaryJob({
          userId,
          debateId: id,
          debateAgentId: String(currentParticipant.id),
          debateQuestion: debate.question,
          workflow,
          roundNumber,
          turnNumber: messageNumber,
          agentName: eventAgentName,
          content: persistedResponse.content,
          refreshFactsBoard: debate.enableSharedFacts
        });
      } catch (error) {
        await logRuntimeEvent("warn", "turn summary enqueue failed", {
          debateId: id,
          error: describeRuntimeError(error)
        });
      }

      const turnRows = await db
        .selectFrom("debate_turns")
        .selectAll()
        .where("debate_id", "=", id)
        .orderBy("turn_number", "asc")
        .execute();
      const turns: DebateTurnRecord[] = turnRows.map((row) => normalizeDebateTurnRow(row as Record<string, unknown>));

      const consensus = aggregateConsensusByLastRound(turns, participantCount, workflow?.consensus ?? null);
      const nextTurn = debate.currentTurn + 1;
      const isBoundary = participantCount > 0 ? nextTurn % participantCount === 0 : false;
      const endedSpeechRoundIndex = participantCount > 0 ? Math.floor(nextTurn / participantCount) : 0;
      const endedRound = mapSpeechRoundIndexToActualRound(endedSpeechRoundIndex, closedVoteRoundsBeforeTurn);
      const openVoteBeforeUpdate = await loadOpenVote(userId, id);
      const latestVoteBeforeUpdate = await loadLatestVote(userId, id);
      const mustKeepRunningForVote = Boolean(openVoteBeforeUpdate);
      const finalizationPhase = resolveCurrentWorkflowPhase({
        workflow,
        roundNumber: endedRound + 1,
        openVote: openVoteBeforeUpdate,
        latestVote: latestVoteBeforeUpdate,
        persistedPhaseKind: debate.workflowPhaseKind
      });
      const requiresFinalizationPhase = requiresWorkflowFinalizationPhaseForCompletion(workflow);
      const requiresOutputs = requiresWorkflowOutputsForCompletion(workflow);
      const currentSpeechRoundIndexAfterTurn = Math.floor(Math.max(0, nextTurn - 1) / Math.max(1, participantCount)) + 1;
      const currentRoundNumberAfterTurn = mapSpeechRoundIndexToActualRound(
        currentSpeechRoundIndexAfterTurn,
        closedVoteRoundsBeforeTurn
      );
      const canCompleteByPhase =
        requiresFinalizationPhase
          ? finalizationPhase?.kind === "finalization" && currentRoundNumberAfterTurn >= getWorkflowEarliestCompletionRound(workflow)
          : currentRoundNumberAfterTurn >= getWorkflowEarliestCompletionRound(workflow);
      const missingDeliverables = requiresOutputs
        ? await listMissingRequiredDeliverables({
            userId,
            debateId: id,
            workflow
          })
        : [];
      const canCompleteByDeliverables = missingDeliverables.length === 0;
      const consensusRequired = workflow?.consensus.enabled !== false;
      const canCompleteByConsensus = !consensusRequired || consensus.reached;
      const consensusReachedForDb = mustKeepRunningForVote ? false : consensus.reached;
      const nextStatusForDb =
        !mustKeepRunningForVote && canCompleteByConsensus && canCompleteByPhase && canCompleteByDeliverables
          ? "completed"
          : "running";
      const phaseSnapshotAfterTurn = getPhaseSnapshot(finalizationPhase, currentRoundNumberAfterTurn);
      lastKnownPhase = phaseSnapshotAfterTurn;
      await db.executeQuery(sql`
        update debates
            set current_turn = ${nextTurn},
                token_used = ${debate.tokenUsed + tokenUsed},
                consensus_summary = ${consensus.leadingSolution
                  ? JSON.stringify({
                      leadingSolution: consensus.leadingSolution,
                      score: consensus.score
                    })
                  : null},
                consensus_reached = ${consensusReachedForDb},
                workflow_phase_kind = ${phaseSnapshotAfterTurn.workflowPhaseKind},
                workflow_phase_title = ${phaseSnapshotAfterTurn.workflowPhaseTitle},
                workflow_phase_round = ${phaseSnapshotAfterTurn.workflowPhaseRound},
                status = case
                  when status in ('paused', 'stopped') then status
                  else ${nextStatusForDb}
                end,
                finished_at = case
                  when ${nextStatusForDb} = 'completed' then ${createdAt}
                  else finished_at
                end,
                updated_at = ${createdAt}
          where id = ${id}
      `.compile(db));

      if (isBoundary && pendingAutoSegmentByDebateAgentId.size > 0 && !consensus.reached) {
        try {
          const pending = [...pendingAutoSegmentByDebateAgentId.entries()];
          pendingAutoSegmentByDebateAgentId.clear();
          for (const [debateAgentId, item] of pending) {
            emitDebateLiveEvent(id, {
              type: "status",
              debateId: id,
              message: `上下文接近上限：自动开始新会话（仅该席位；轮次边界）...`,
              at: new Date().toISOString()
            });
            // eslint-disable-next-line no-await-in-loop
            await startAutoSegmentForDebateAgentAtBoundary({
              userId,
              debateId: id,
              debateAgentId,
              participantCount,
              currentTurn: nextTurn,
              question: debate.question,
              reason: item.reason,
              now: createdAt
            });
            // eslint-disable-next-line no-await-in-loop
            await bumpUsageSessionForDebateAgent({
              userId,
              debateId: id,
              debateAgentId,
              now: createdAt,
              reason: "auto_75pct_threshold"
            });
          }
        } catch (error) {
          await logRuntimeEvent("warn", "auto segment failed", { debateId: id, error: describeRuntimeError(error) });
        }
      }

      if (isBoundary) {
        if (endedRound > 0) {
          let finalizationEnteredAtBoundary = false;
          try {
            emitDebateLiveEvent(id, {
              type: "status",
              debateId: id,
              message: `第 ${endedRound} 轮总结已入队，后台处理中...`,
              at: new Date().toISOString()
            });
            await enqueueRoundSummaryJob({
              userId,
              debateId: debate.id,
              debateAgentId: String(currentParticipant.id),
              debateQuestion: debate.question,
              workflow,
              participantCount,
              roundNumber: endedRound,
              refreshFactsBoard: debate.enableSharedFacts
            });
          } catch (error) {
            await logRuntimeEvent("warn", "round summary enqueue failed", { debateId: id, error: describeRuntimeError(error) });
          }

          try {
            const closed = await maybeAutoCloseOpenVoteAtBoundary({
              userId,
              debateId: id,
              participantCount,
              endedRound
            });
            if (closed.closed) {
              emitDebateLiveEvent(id, {
                type: "status",
                debateId: id,
                message: "官方投票已在轮次边界自动封票（结果来自投票）；下一轮首位席位将统计并公布",
                at: new Date().toISOString()
              });
              const closedVote =
                closed.result && typeof closed.result === "object" && (closed.result as any).closed
                  ? ((closed.result as any).closed as ClosedOfficialVote)
                  : null;
              if (closedVote) {
                if (closedVote.kind === "finalization" && Boolean((closedVote.result as any)?.passed)) {
                  const workflowPhase = getWorkflowPhaseByKind(workflow, "finalization");
                  const phaseSnapshot = {
                    workflowPhaseKind: "finalization" as const,
                    workflowPhaseTitle: workflowPhase?.title ?? "Consolidation · Final alignment and outputs",
                    workflowPhaseRound: endedRound + 1
                  };
                  await persistDebatePhaseSnapshot(id, phaseSnapshot);
                  lastKnownPhase = phaseSnapshot;
                  finalizationEnteredAtBoundary = true;
                  emitDebateLiveEvent(id, {
                    type: "status",
                    debateId: id,
                    message: `Consolidation vote passed. From round ${endedRound + 1}, the debate enters the consolidation phase.`,
                    at: new Date().toISOString()
                  });
                }
                try {
                  await maybeGenerateVoteAnnouncementWithSeat1({
                    userId,
                    debate,
                    participantCount,
                    closed: closedVote
                  });
                } catch (error) {
                  if (isQuotaDelayError(error)) {
                    throw error;
                  }
                  await logRuntimeEvent("warn", "auto vote announce failed", {
                    debateId: id,
                    error: describeRuntimeError(error)
                  });
                }
              }
            } else if (closed.reopened) {
              emitDebateLiveEvent(id, {
                type: "status",
                debateId: id,
                message: "官方投票平票：下一轮继续补充观点后重新投票，当前仍停留在投票阶段",
                at: new Date().toISOString()
              });
            }
          } catch (error) {
            await logRuntimeEvent("warn", "auto vote close failed", { debateId: id, error: describeRuntimeError(error) });
          }

          try {
            const opened = await maybeAutoOpenVoteAtBoundaryUsingWorkflow({
              userId,
              debateId: id,
              participantCount,
              endedRound,
              skipFinalizationAutoOpen: finalizationEnteredAtBoundary
            });
            if (opened.opened) {
              emitDebateLiveEvent(id, {
                type: "status",
                debateId: id,
                message: `已在第 ${endedRound} 轮结束后自动开票：请各席位使用官方工具完成投票`,
                at: new Date().toISOString()
              });
            }
          } catch (error) {
            await logRuntimeEvent("warn", "auto vote open failed", { debateId: id, error: describeRuntimeError(error) });
          }
        }
      }

      touchDebateRun(id, runToken);
      await sleep(1000);
    }
  } catch (error) {
    if (isQuotaDelayError(error)) {
      await pauseDebateForQuotaWait({
        debateId: id,
        profileId: error.wait.profile.id,
        profileName: error.wait.profile.name,
        resumeAt: error.wait.nextAvailableAt,
        timeZone: error.wait.profile.resetTimezone,
        phase: lastKnownPhase
      });
      await logRuntimeEvent("warn", "quota.pause_debate", {
        debateId: id,
        userId,
        profileId: error.wait.profile.id,
        profileName: error.wait.profile.name,
        used5h: error.wait.summary.used5h,
        usedWeek: error.wait.summary.usedWeek,
        usedMonth: error.wait.summary.usedMonth,
        nextAvailableAt: error.wait.nextAvailableAt,
        reason: error.wait.reason
      });
      emitDebateLiveEvent(id, {
        type: "status",
        debateId: id,
        message: `受 Coding Plan 限额控制，辩论已暂停，将于 ${new Date(error.wait.nextAvailableAt).toLocaleString("zh-CN", {
          hour12: false,
          timeZone: error.wait.profile.resetTimezone
        })} 自动恢复`,
        at: new Date().toISOString()
      });
      return;
    }
    const details = describeRuntimeError(error);
    await logRuntimeEvent("error", "debate runtime failed", {
      debateId: id,
      userId,
      code: details.code,
      message: details.message,
      stack: details.stack
    });
    if (isRecoverableRuntimeInterruption(details)) {
      await pauseDebateAfterRuntimeInterruption(id, "runtime interrupted", {
        phase: lastKnownPhase,
        lastErrorCode: details.code,
        lastErrorMessage: truncateErrorMessage(details.message)
      });
    } else {
      await finishDebate(id, "failed", "runtime error", {
        phase: lastKnownPhase,
        lastErrorCode: details.code,
        lastErrorMessage: truncateErrorMessage(details.message)
      });
      const recovered = await autoRecoverFailedDebateOnce({
        debateId: id,
        userId,
        phase: lastKnownPhase
      });
      shouldAutoRestartAfterFailure = Boolean(recovered);
    }
  } finally {
    releaseDebateRun(id, runToken);
    clearDebateLiveProgress(id);
    if (shouldAutoRestartAfterFailure) {
      void runDebate(id, userId);
    }
  }
}
