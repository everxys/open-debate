import { loadDebatePhaseState, loadLatestVote, loadOpenVote, toolVoteClose, toolVoteOpen } from "@/lib/runtime/tools";
import {
  ClosedOfficialVote,
  getWorkflowEarliestFinalizationVoteRound,
  getWorkflowPhaseByKind,
  loadDebateWorkflow
} from "@/lib/runtime/workflow-phase";

export async function maybeAutoCloseOpenVoteAtBoundary(input: {
  userId: string;
  debateId: string;
  participantCount: number;
  endedRound: number;
}) {
  const open = await loadOpenVote(input.userId, input.debateId);
  if (!open || open.status !== "open") return { ok: true, closed: false };

  const forcedOpen = Boolean(open.meta?.forcedOpen);

  // Default policy:
  // - If vote opened at Round N (possibly mid-round), close at end of Round >= N+1.
  // Forced policy (auto-open at boundary):
  // - Close at end of Round >= N (i.e., one full round to vote).
  if (!forcedOpen && input.endedRound <= open.roundNumber) return { ok: true, closed: false };
  if (forcedOpen && input.endedRound < open.roundNumber) return { ok: true, closed: false };

  const result = await toolVoteClose({
    userId: input.userId,
    debateId: input.debateId,
    participantCount: input.participantCount
  });
  const reopened = Boolean((result as { reopened?: unknown }).reopened);
  const closed = Boolean((result as { closed?: unknown }).closed);
  return { ok: true, closed, reopened, result };
}

export async function maybeAutoOpenVoteAtBoundaryUsingWorkflow(input: {
  userId: string;
  debateId: string;
  participantCount: number;
  endedRound: number;
  skipFinalizationAutoOpen?: boolean;
}) {
  if (input.participantCount <= 0) return { ok: true, opened: false };

  const latestVote = await loadLatestVote(input.userId, input.debateId);
  if (latestVote?.status === "open") return { ok: true, opened: false, open: latestVote };

  const workflow = await loadDebateWorkflow(input.userId, input.debateId);
  const workflowEnabled = Boolean(workflow?.enabled);
  if (!workflowEnabled) return { ok: true, opened: false };

  const nextRoundNumber = input.endedRound + 1;
  const finalizationRules = workflow?.phaseMachine.transitionRules.finalization;
  const finalizationEntryRound = getWorkflowEarliestFinalizationVoteRound(workflow);
  const finalizationVoteTitle = getWorkflowPhaseByKind(workflow, "finalization_vote")?.title ?? "Consolidation vote";
  if (
    workflowEnabled &&
    !input.skipFinalizationAutoOpen &&
    finalizationRules?.autoOpenVote &&
    nextRoundNumber === finalizationEntryRound
  ) {
    const debateState = await loadDebatePhaseState({ userId: input.userId, debateId: input.debateId });
    if (debateState.workflowPhaseKind !== "finalization") {
      const result = await toolVoteOpen({
        userId: input.userId,
        debateId: input.debateId,
        participantCount: input.participantCount,
        roundNumber: nextRoundNumber,
        title: `Round ${nextRoundNumber} · ${finalizationVoteTitle}`,
        kind: "finalization",
        bypassStartRound: false,
        meta: { forcedOpen: true, reason: `after_round_${input.endedRound}` }
      });
      return { ok: true, opened: Boolean((result as { ok?: unknown }).ok), result };
    }
  }

  if (
    workflowEnabled &&
    !input.skipFinalizationAutoOpen &&
    finalizationRules?.autoOpenVote &&
    finalizationRules?.reopenUntilPassed &&
    latestVote?.status === "closed" &&
    latestVote.kind === "finalization" &&
    !Boolean((latestVote.result as any)?.passed)
  ) {
    const discussionRoundsBetweenVotes = Math.max(1, Math.floor(Number(finalizationRules.discussionRoundsBetweenVotes) || 1));
    const targetVoteRound = latestVote.roundNumber + discussionRoundsBetweenVotes + 1;
    if (nextRoundNumber === targetVoteRound) {
      const attempt = Math.max(1, Math.floor(Number(latestVote.meta?.attempt) || 1)) + 1;
      const result = await toolVoteOpen({
        userId: input.userId,
        debateId: input.debateId,
        participantCount: input.participantCount,
        roundNumber: nextRoundNumber,
        title: `Round ${nextRoundNumber} · ${finalizationVoteTitle} retry`,
        kind: "finalization",
        bypassStartRound: false,
        meta: {
          forcedOpen: true,
          reason: `retry_after_round_${input.endedRound}`,
          attempt,
          previousFailedRound: latestVote.roundNumber
        }
      });
      return { ok: true, opened: Boolean((result as { ok?: unknown }).ok), result };
    }
  }

  return { ok: true, opened: false };
}

export function buildFallbackVoteAnnouncement(input: {
  debateQuestion: string;
  participantsInline: string | null;
  closed: ClosedOfficialVote;
  decisionJson: Record<string, unknown> | null;
}) {
  const kind = input.closed.kind;
  const result = input.closed.result ?? {};
  const winner = typeof (result as any)?.winner === "string" ? String((result as any).winner) : null;
  const passed = Boolean((result as any)?.passed);
  return [
    `# 第 ${input.closed.roundNumber} 轮 · 投票结果公告`,
    "",
    `- 标题：${input.closed.title}`,
    `- 类型：${kind}`,
    "",
    "## 结果",
    kind === "finalization"
      ? passed
        ? "- Consolidation vote passed"
        : "- Consolidation vote not passed"
      : kind === "custom"
        ? winner
          ? `- Winner：${winner}`
          : "- Winner：未能选出"
        : "- 结果：未提供",
    "",
    ...(input.participantsInline ? [input.participantsInline, ""] : []),
    ...(input.decisionJson ? ["## 结论数据（JSON）", "```json", JSON.stringify(input.decisionJson, null, 2), "```", ""] : []),
    "请各席位在下一轮以官方投票结果为准继续推进。"
  ].join("\n").trim();
}
