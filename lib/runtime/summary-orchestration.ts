import { clearDebateSummaryJob, setDebateSummaryJob } from "@/lib/debate-live";
import { isQuotaDelayError } from "@/lib/quota-control";
import {
  describeRuntimeError,
  logRuntimeEvent
} from "@/lib/runtime/provider-shared";
import { isNonRetryableSummaryJobError } from "@/lib/runtime/runtime-state";
import { truncateErrorMessage } from "@/lib/runtime/runtime-utils";
import {
  completeDebateSummaryJob,
  deferDebateSummaryJobUntil,
  enqueueDebateSummaryJob,
  failDebateSummaryJob,
  FACTS_BOARD_DEBOUNCE_MS,
  FACTS_BOARD_JOB_KEY,
  markBlockedDebateSummaryJob,
  scheduleDebateSummaryJobRetry,
  toDebateSummaryJobLiveView,
  type DebateSummaryJobKind,
  type DebateSummaryJobRecord
} from "@/lib/summary-jobs";
import {
  listClosedOfficialVoteRounds,
  loadDebateWorkflow,
  mapActualRoundToSpeechRoundIndex
} from "@/lib/runtime/workflow-phase";
import type { NormalizedDebateWorkflow } from "@/lib/workflow";

function getWorkflowSummarizerConfig(workflow: NormalizedDebateWorkflow | null) {
  if (!workflow?.enabled || !workflow.summarizer.enabled) return null;
  const aiAgentId = workflow.summarizer.aiAgentId?.trim() || "";
  if (!aiAgentId) return null;
  return workflow.summarizer;
}

async function syncSummaryJobToLive(job: DebateSummaryJobRecord, message?: string | null, blockedReason?: string | null) {
  const liveJob = toDebateSummaryJobLiveView(job, message, blockedReason);
  setDebateSummaryJob(job.debateId, liveJob);
}

export async function updateSummaryJob(
  debateId: string,
  job: {
    key: string;
    kind: DebateSummaryJobKind;
    label: string;
    turnNumber?: number | null;
    roundNumber?: number | null;
    status: DebateSummaryJobRecord["status"];
    message: string | null;
    errorReason?: string | null;
    retryAt?: string | null;
    attemptCount?: number | null;
    blockedReason?: string | null;
  }
) {
  setDebateSummaryJob(debateId, {
    key: job.key,
    kind: job.kind,
    label: job.label,
    turnNumber: job.turnNumber ?? null,
    roundNumber: job.roundNumber ?? null,
    status: job.status,
    message: job.message,
    errorReason: job.errorReason ?? null,
    retryAt: job.retryAt ?? null,
    attemptCount: job.attemptCount ?? null,
    blockedReason: job.blockedReason ?? null,
    leaseState: job.status === "running" ? "active" : null,
    deadLetter: job.status === "dead_letter"
  });
  if (job.status === "completed") {
    clearDebateSummaryJob(debateId, job.key);
  }
}

async function resolveActualRoundTurnRange(input: {
  userId: string;
  debateId: string;
  roundNumber: number;
  participantCount: number;
}) {
  const safeParticipantCount = Math.max(1, input.participantCount);
  const closedVoteRounds = await listClosedOfficialVoteRounds(input.userId, input.debateId);
  const speechRoundIndex = mapActualRoundToSpeechRoundIndex(input.roundNumber, closedVoteRounds);
  if (!speechRoundIndex) return null;
  return {
    speechRoundIndex,
    startTurn: (speechRoundIndex - 1) * safeParticipantCount + 1,
    endTurn: speechRoundIndex * safeParticipantCount
  };
}

export async function enqueueTurnSummaryJob(input: {
  userId: string;
  debateId: string;
  debateAgentId: string;
  debateQuestion: string;
  workflow: NormalizedDebateWorkflow | null;
  roundNumber: number;
  turnNumber: number;
  agentName: string;
  content: string;
  refreshFactsBoard: boolean;
}) {
  const summarizer = getWorkflowSummarizerConfig(input.workflow);
  if (!summarizer || !summarizer.perTurn) return null;
  const record = await enqueueDebateSummaryJob({
    debateId: input.debateId,
    kind: "turn_summary",
    jobKey: `turn:${input.turnNumber}`,
    turnNumber: input.turnNumber,
    roundNumber: input.roundNumber,
    payload: {
      userId: input.userId,
      debateId: input.debateId,
      debateAgentId: input.debateAgentId,
      debateQuestion: input.debateQuestion,
      roundNumber: input.roundNumber,
      turnNumber: input.turnNumber,
      agentName: input.agentName,
      content: input.content,
      refreshFactsBoard: input.refreshFactsBoard
    }
  });
  await syncSummaryJobToLive(record, "AI 总结排队中...");
  return record;
}

export async function enqueueRoundSummaryJob(input: {
  userId: string;
  debateId: string;
  debateAgentId: string;
  debateQuestion: string;
  workflow: NormalizedDebateWorkflow | null;
  participantCount: number;
  roundNumber: number;
  refreshFactsBoard: boolean;
}) {
  const summarizer = getWorkflowSummarizerConfig(input.workflow);
  if (!summarizer || !summarizer.perRound) return null;
  const roundTurnRange = await resolveActualRoundTurnRange({
    userId: input.userId,
    debateId: input.debateId,
    roundNumber: input.roundNumber,
    participantCount: input.participantCount
  });
  if (!roundTurnRange) return null;
  const dependsOnKeys = Array.from({ length: Math.max(0, input.participantCount) }, (_, index) => {
    const turnNumber = roundTurnRange.startTurn + index;
    return `turn:${turnNumber}`;
  });
  const blocked = dependsOnKeys.length > 0;
  const record = await enqueueDebateSummaryJob({
    debateId: input.debateId,
    kind: "round_summary",
    jobKey: `round:${input.roundNumber}`,
    roundNumber: input.roundNumber,
    dependsOnKeys,
    status: blocked ? "blocked" : "queued",
    payload: {
      userId: input.userId,
      debateId: input.debateId,
      debateAgentId: input.debateAgentId,
      debateQuestion: input.debateQuestion,
      endedRound: input.roundNumber,
      participantCount: input.participantCount,
      refreshFactsBoard: input.refreshFactsBoard
    }
  });
  await syncSummaryJobToLive(
    record,
    blocked ? "等待本轮回摘要完成" : "AI 总结排队中...",
    blocked ? "missing_turn_summaries" : null
  );
  return record;
}

async function enqueueFactsBoardJob(input: {
  debateId: string;
  sourceKey: string;
  turnNumber?: number | null;
  roundNumber?: number | null;
  payload: Record<string, unknown>;
}) {
  const sourceIsRound = input.sourceKey.startsWith("round:");
  const runAfter = new Date(Date.now() + (sourceIsRound ? 0 : FACTS_BOARD_DEBOUNCE_MS)).toISOString();
  const record = await enqueueDebateSummaryJob({
    debateId: input.debateId,
    kind: "facts_board",
    jobKey: FACTS_BOARD_JOB_KEY,
    turnNumber: input.turnNumber ?? null,
    roundNumber: input.roundNumber ?? null,
    payload: {
      ...input.payload,
      sourceKey: input.sourceKey,
      sourcePriority: sourceIsRound ? "round" : "turn",
      sourceUpdatedAt: new Date().toISOString()
    },
    priority: sourceIsRound ? 30 : 40,
    runAfter
  });
  await syncSummaryJobToLive(record, sourceIsRound ? "事实板排队中..." : "事实板短暂合并等待中...");
  return record;
}

async function updateDbSummaryJobLive(job: DebateSummaryJobRecord, message?: string | null, blockedReason?: string | null) {
  await syncSummaryJobToLive(job, message, blockedReason);
}

async function failOrRetrySummaryJob(
  job: DebateSummaryJobRecord,
  error: unknown,
  labels: {
    failedMessage: string;
    retryWaitingMessage: string;
    deadLetterMessage: string;
  }
) {
  const details = describeRuntimeError(error);
  const errorMessage = truncateErrorMessage(String(details.message ?? "summary_job_failed"));
  if (isNonRetryableSummaryJobError(details)) {
    const failed = await failDebateSummaryJob(job.id, errorMessage);
    await updateDbSummaryJobLive(failed, labels.failedMessage, errorMessage);
    return failed;
  }
  const retried = await scheduleDebateSummaryJobRetry({
    id: job.id,
    attemptCount: job.attemptCount,
    errorMessage
  });
  await updateDbSummaryJobLive(
    retried,
    retried.status === "dead_letter" ? labels.deadLetterMessage : labels.retryWaitingMessage
  );
  return retried;
}

export async function runSummaryJobByRecord(job: DebateSummaryJobRecord) {
  const payload = job.payload;
  const workflow = await loadDebateWorkflow(String(payload.userId ?? ""), job.debateId);
  const summarizer = getWorkflowSummarizerConfig(workflow);
  if (!summarizer?.enabled) {
    const failed = await failDebateSummaryJob(job.id, "summarizer_disabled");
    await updateDbSummaryJobLive(failed, "总结器未启用");
    return failed;
  }
  if (!summarizer.aiAgentId) {
    const failed = await failDebateSummaryJob(job.id, "summarizer_ai_missing");
    await updateDbSummaryJobLive(failed, "总结器配置失效");
    return failed;
  }

  await updateDbSummaryJobLive(job, "AI 总结中...");

  // Delay the generation dependency so summary orchestration stays decoupled from the runtime facade.
  const {
    generateRoundSummary,
    generateTurnSummary,
    refreshFactsBoardFromSummaries
  } = await import("@/lib/runtime/summary-generation");

  try {
    if (job.kind === "turn_summary") {
      const result = await generateTurnSummary({
        userId: String(payload.userId),
        debateId: job.debateId,
        debateAgentId: String(payload.debateAgentId),
        debateQuestion: String(payload.debateQuestion),
        workflow,
        roundNumber: Number(payload.roundNumber),
        turnNumber: Number(payload.turnNumber),
        agentName: String(payload.agentName),
        content: String(payload.content ?? ""),
        now: new Date().toISOString(),
        refreshFactsBoard: Boolean(payload.refreshFactsBoard)
      });
      if (!result.ok) {
        return await failOrRetrySummaryJob(job, result.error ?? "turn_summary_failed", {
          failedMessage: "回摘要失败，请更新总结器凭证",
          retryWaitingMessage: "回摘要待重试",
          deadLetterMessage: "回摘要进入死信"
        });
      }
      const completed = await completeDebateSummaryJob(job.id);
      await updateDbSummaryJobLive(completed, "回摘要已完成");
      if (Boolean(payload.refreshFactsBoard) && result.content) {
        await enqueueFactsBoardJob({
          debateId: job.debateId,
          sourceKey: `turn:${Number(payload.turnNumber)}`,
          turnNumber: Number(payload.turnNumber),
          roundNumber: Number(payload.roundNumber),
          payload: {
            userId: String(payload.userId),
            debateId: job.debateId,
            debateAgentId: String(payload.debateAgentId),
            debateQuestion: String(payload.debateQuestion),
            sourceLabel: `turn-${Number(payload.turnNumber)}`,
            sourceSummary: result.content,
            turnNumber: Number(payload.turnNumber),
            roundNumber: Number(payload.roundNumber)
          }
        });
      }
      return completed;
    }

    if (job.kind === "round_summary") {
      const result = await generateRoundSummary({
        userId: String(payload.userId),
        debate: { id: job.debateId, question: String(payload.debateQuestion) },
        debateAgentId: String(payload.debateAgentId),
        workflow,
        participantCount: Number(payload.participantCount),
        endedRound: Number(payload.endedRound),
        now: new Date().toISOString(),
        refreshFactsBoard: Boolean(payload.refreshFactsBoard)
      });
      if (!result.ok) {
        const message =
          typeof result.error === "string" && result.error === "missing_turn_summaries"
            ? "missing_turn_summaries"
            : truncateErrorMessage(String(result.error ?? "round_summary_failed"));
        if (message === "missing_turn_summaries") {
          const blocked = await markBlockedDebateSummaryJob(job.id, message);
          await updateDbSummaryJobLive(blocked, "等待本轮回摘要完成", message);
          return blocked;
        }
        return await failOrRetrySummaryJob(job, result.error ?? message, {
          failedMessage: "轮摘要失败，请更新总结器凭证",
          retryWaitingMessage: "轮摘要待重试",
          deadLetterMessage: "轮摘要进入死信"
        });
      }
      const completed = await completeDebateSummaryJob(job.id);
      await updateDbSummaryJobLive(completed, "轮摘要已完成");
      if (Boolean(payload.refreshFactsBoard) && result.content) {
        await enqueueFactsBoardJob({
          debateId: job.debateId,
          sourceKey: `round:${Number(payload.endedRound)}`,
          roundNumber: Number(payload.endedRound),
          payload: {
            userId: String(payload.userId),
            debateId: job.debateId,
            debateAgentId: String(payload.debateAgentId),
            debateQuestion: String(payload.debateQuestion),
            sourceLabel: `round-${Number(payload.endedRound)}`,
            sourceSummary: result.content,
            turnNumber: null,
            roundNumber: Number(payload.endedRound)
          }
        });
      }
      return completed;
    }

    const result = await refreshFactsBoardFromSummaries({
      userId: String(payload.userId),
      debateId: job.debateId,
      debateAgentId: String(payload.debateAgentId),
      debateQuestion: String(payload.debateQuestion),
      workflow,
      sourceLabel: String(payload.sourceLabel),
      sourceSummary: String(payload.sourceSummary ?? ""),
      turnNumber: payload.turnNumber === null || payload.turnNumber === undefined ? null : Number(payload.turnNumber),
      roundNumber: payload.roundNumber === null || payload.roundNumber === undefined ? null : Number(payload.roundNumber),
      now: new Date().toISOString()
    });
    if (!result.ok) {
      return await failOrRetrySummaryJob(job, result.error ?? "facts_board_failed", {
        failedMessage: "事实板失败，请更新总结器凭证",
        retryWaitingMessage: "事实板待重试",
        deadLetterMessage: "事实板进入死信"
      });
    }
    const completed = await completeDebateSummaryJob(job.id);
    await updateDbSummaryJobLive(completed, completed.status === "completed" ? "事实板已完成" : "事实板待整理最新变更");
    return completed;
  } catch (error) {
    if (isQuotaDelayError(error)) {
      const deferred = await deferDebateSummaryJobUntil({
        id: job.id,
        runAfter: error.wait.nextAvailableAt,
        reason: error.wait.reason ?? "quota_wait"
      });
      await updateDbSummaryJobLive(
        deferred,
        `受 Coding Plan 限额控制，已延后到 ${new Date(error.wait.nextAvailableAt).toLocaleString("zh-CN", {
          hour12: false,
          timeZone: error.wait.profile.resetTimezone
        })}`,
        error.wait.reason ?? "quota_wait"
      );
      await logRuntimeEvent("warn", "quota.defer_summary_job", {
        debateId: job.debateId,
        jobKey: job.jobKey,
        kind: job.kind,
        profileId: error.wait.profile.id,
        profileName: error.wait.profile.name,
        used5h: error.wait.summary.used5h,
        usedWeek: error.wait.summary.usedWeek,
        usedMonth: error.wait.summary.usedMonth,
        nextAvailableAt: error.wait.nextAvailableAt,
        reason: error.wait.reason
      });
      return deferred;
    }
    const retried = await failOrRetrySummaryJob(job, error, {
      failedMessage: "总结任务失败，请更新总结器凭证",
      retryWaitingMessage: "总结任务待重试",
      deadLetterMessage: "总结任务进入死信"
    });
    await logRuntimeEvent("warn", "summary job execution failed", {
      debateId: job.debateId,
      jobKey: job.jobKey,
      kind: job.kind,
      error: describeRuntimeError(error)
    });
    return retried;
  }
}
