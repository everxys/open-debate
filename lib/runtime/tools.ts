import { query } from "@/lib/db";
import { AppError } from "@/lib/http";
import {
  DELIVERABLE_REPLACE_SHRINK_MIN_CHARS,
  DELIVERABLE_REPLACE_SHRINK_RATIO,
  QUESTION_LATEST_DIFF_PATH,
  VOTE_ANNOUNCEMENT_PATH,
  VOTE_DECISION_JSON_PATH,
  VOTE_DECISION_PATH,
  VOTE_OPEN_PATH,
  VOTE_RESULT_PREFIX
} from "@/lib/runtime/constants";
import { readDebateFile, upsertDebateFile } from "@/lib/runtime/file-store";
import {
  buildFinalizationVoteOptions,
  FINALIZATION_VOTE_APPROVE,
  FINALIZATION_VOTE_REJECT,
  getWorkflowEarliestFinalizationVoteRound,
  isFinalizationApproveChoice,
  isFinalizationRejectChoice,
  loadDebateWorkflow,
  OfficialVote,
  OpenOfficialVote,
  resolveCurrentWorkflowPhase,
  safeJsonParse
} from "@/lib/runtime/workflow-phase";
import type { DebateRecord } from "@/lib/types";

export async function loadDebatePhaseState(input: { userId: string; debateId: string }) {
  const result = await query<{
    current_turn: number;
    consensus_reached: boolean;
    status: string;
    workflow_phase_kind: DebateRecord["workflowPhaseKind"] | null;
  }>(
    `
      select current_turn, consensus_reached, status, workflow_phase_kind
        from debates
       where id = $1
         and user_id = $2
       limit 1
    `,
    [input.debateId, input.userId]
  );
  if ((result.rowCount ?? 0) !== 1) {
    throw new AppError("NOT_FOUND", 404, "Debate not found");
  }
  return {
    currentTurn: Number(result.rows[0].current_turn ?? 0),
    consensusReached: Boolean(result.rows[0].consensus_reached),
    status: String(result.rows[0].status ?? ""),
    workflowPhaseKind: (result.rows[0].workflow_phase_kind as DebateRecord["workflowPhaseKind"] | null) ?? null
  };
}

export async function loadOpenVote(userId: string, debateId: string) {
  const rawVote = await readDebateFile(userId, debateId, VOTE_OPEN_PATH);
  if (!rawVote) return null;
  const parsedVote = safeJsonParse<OfficialVote>(rawVote);
  if (!parsedVote || parsedVote.status !== "open") return null;
  return parsedVote;
}

export async function loadLatestVote(userId: string, debateId: string) {
  const rawVote = await readDebateFile(userId, debateId, VOTE_OPEN_PATH);
  if (!rawVote) return null;
  return safeJsonParse<OfficialVote>(rawVote);
}

export async function loadOpenVoteInline(userId: string, debateId: string, seed?: string) {
  const openVote = await loadOpenVote(userId, debateId);
  if (!openVote) return null;

  function hashSeedToUint32(value: string) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  function shuffleWithSeed<T>(items: T[], seedValue: string) {
    if (!seedValue) return items.slice();
    const shuffled = items.slice();
    let state = hashSeedToUint32(seedValue) || 1;
    const nextRandom = () => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return (state >>> 0) / 0xffffffff;
    };
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(nextRandom() * (index + 1));
      const current = shuffled[index];
      shuffled[index] = shuffled[swapIndex];
      shuffled[swapIndex] = current;
    }
    return shuffled;
  }

  const optionsList = shuffleWithSeed(openVote.options, String(seed ?? ""));
  const options = optionsList.map((option) => `- ${option}`).join("\n");
  if (openVote.kind === "finalization") {
    return [
      "OFFICIAL VOTE (OPEN): Consolidation Entry",
      `- Title: ${openVote.title}`,
      `- Round: ${openVote.roundNumber}`,
      `- Prompt: ${openVote.prompt}`,
      "- Rule: every seat must choose the approval option before the debate can enter the consolidation phase.",
      `- Options:\n${options}`,
      "- How to vote: call tool debate_vote_cast with { choice: '...', reason?: '...' }",
      "- After all seats voted, call tool debate_vote_close to publish the official result."
    ].join("\n");
  }
  return [
    "OFFICIAL VOTE (OPEN): Custom",
    `- Title: ${openVote.title}`,
    `- Round: ${openVote.roundNumber}`,
    ...(openVote.meta?.tieRound ? [`- Tie round: ${openVote.meta.tieRound}`] : []),
    `- Prompt: ${openVote.prompt}`,
    `- Options:\n${options}`,
    "- How to vote: call tool debate_vote_cast with { choice: '...', reason?: '...' }",
    "- After all seats voted, call tool debate_vote_close to publish the official result."
  ].join("\n");
}

export async function loadOfficialDecisionInline(userId: string, debateId: string) {
  const decisionContent = await readDebateFile(userId, debateId, VOTE_DECISION_PATH);
  if (!decisionContent) return null;
  return `Official decision (read-only; follow it):\n${decisionContent.trim()}`;
}

export async function loadVoteAnnouncementInline(userId: string, debateId: string) {
  const announcementContent = await readDebateFile(userId, debateId, VOTE_ANNOUNCEMENT_PATH);
  if (!announcementContent) return null;
  return `Latest vote announcement (read-only; follow it):\n${announcementContent.trim()}`;
}

export async function loadQuestionDiffInline(userId: string, debateId: string) {
  return readDebateFile(userId, debateId, QUESTION_LATEST_DIFF_PATH);
}

export function normalizeSeatLabel(input: string, participantCount: number) {
  const trimmed = input.trim();
  const seatMatch = trimmed.match(/seat[-\s_]*([0-9]{1,3})/i);
  const seatNumber = seatMatch ? Number(seatMatch[1]) : Number.NaN;
  if (Number.isFinite(seatNumber) && seatNumber >= 1 && seatNumber <= participantCount) return `Seat-${seatNumber}`;
  const numberOnly = trimmed.match(/^([0-9]{1,3})$/);
  if (numberOnly) {
    const numericSeat = Number(numberOnly[1]);
    if (Number.isFinite(numericSeat) && numericSeat >= 1 && numericSeat <= participantCount) return `Seat-${numericSeat}`;
  }
  return trimmed;
}

export async function toolVoteOpen(input: {
  userId: string;
  debateId: string;
  participantCount: number;
  roundNumber: number;
  title: string;
  kind: "finalization" | "custom";
  prompt?: string;
  options?: string[];
  allowWithoutWorkflow?: boolean;
  bypassStartRound?: boolean;
  meta?: {
    forcedOpen?: boolean;
    reason?: string;
    tieRound?: number;
    reopenedBecause?: string;
    attempt?: number;
    previousFailedRound?: number;
  };
}) {
  const now = new Date().toISOString();
  const workflow = await loadDebateWorkflow(input.userId, input.debateId);
  const debatePhaseState = await loadDebatePhaseState({ userId: input.userId, debateId: input.debateId });
  const workflowEnabled = Boolean(workflow?.enabled);
  const allowWithoutWorkflow = Boolean(input.allowWithoutWorkflow) && input.kind === "custom";
  if (!workflowEnabled && !allowWithoutWorkflow) {
    return { ok: false, error: "Official voting is disabled (missing workflow.json or enabled=false)." };
  }
  const existingOpenVote = await loadOpenVote(input.userId, input.debateId);
  if (existingOpenVote) {
    return { ok: false, error: "A vote is already open.", open: existingOpenVote };
  }
  const latestVote = await loadLatestVote(input.userId, input.debateId);
  const currentPhase = resolveCurrentWorkflowPhase({
    workflow,
    roundNumber: input.roundNumber,
    openVote: null,
    latestVote,
    persistedPhaseKind: debatePhaseState.workflowPhaseKind
  });

  if (input.kind === "finalization") {
    if (!workflow?.enabled) {
      return { ok: false, error: "Finalization entry vote requires workflow.json (enabled=true)." };
    }
    if (currentPhase?.kind === "finalization") {
      return { ok: false, error: "The debate is already in the consolidation phase; no new entry vote is needed." };
    }
    if (input.roundNumber < getWorkflowEarliestFinalizationVoteRound(workflow)) {
      return {
        ok: false,
        error: `Consolidation entry vote can only start from Round ${getWorkflowEarliestFinalizationVoteRound(workflow)}. Current round is ${input.roundNumber}.`
      };
    }
    const prompt =
      (typeof input.prompt === "string" && input.prompt.trim()) ||
      "请判断本场辩论是否已经完成充分讨论、所有关键争议是否已收束、是否可以正式进入收束阶段完成最终整合与交付。只有全员同意，才允许进入收束阶段。";
    const attempt = Math.max(1, Math.floor(Number(input.meta?.attempt) || 1));
    const openVote: OfficialVote = {
      status: "open",
      kind: "finalization",
      roundNumber: input.roundNumber,
      title: input.title || `第 ${input.roundNumber} 轮 · 收束阶段入场表决`,
      prompt: prompt.trim(),
      options: buildFinalizationVoteOptions(),
      ballots: [],
      meta: {
        ...(input.meta ?? {}),
        attempt
      },
      createdAt: now
    };
    await upsertDebateFile(input.debateId, VOTE_OPEN_PATH, JSON.stringify(openVote, null, 2), now);
    return { ok: true, vote: openVote };
  }

  const options = Array.isArray(input.options) ? input.options.map((option) => String(option).trim()).filter(Boolean) : [];
  if (currentPhase?.kind !== "finalization") {
    return {
      ok: false,
      error: `Custom/final vote is only allowed in the consolidation phase. Current phase: ${currentPhase?.title ?? "unknown"}.`
    };
  }
  if (!input.prompt || !input.prompt.trim()) {
    return { ok: false, error: "Custom vote requires prompt." };
  }
  if (options.length < 2) {
    return { ok: false, error: "Custom vote requires at least 2 options." };
  }
  const openVote: OfficialVote = {
    status: "open",
    kind: "custom",
    roundNumber: input.roundNumber,
    title: input.title,
    prompt: input.prompt.trim(),
    options,
    ballots: [],
    ...(input.meta ? { meta: input.meta } : {}),
    createdAt: now
  };
  await upsertDebateFile(input.debateId, VOTE_OPEN_PATH, JSON.stringify(openVote, null, 2), now);
  return { ok: true, vote: openVote };
}

export async function toolVoteCast(input: {
  userId: string;
  debateId: string;
  participantCount: number;
  debateAgentId: string;
  voterName: string;
  choice?: string;
  reason?: string;
}) {
  const now = new Date().toISOString();
  const openVote = await loadOpenVote(input.userId, input.debateId);
  if (!openVote) return { ok: false, error: "No open vote." };
  const currentOpenVote = openVote as OpenOfficialVote;
  const workflow = await loadDebateWorkflow(input.userId, input.debateId);
  const workflowEnabled = Boolean(workflow?.enabled);
  const forcedOpen = Boolean(currentOpenVote.meta?.forcedOpen);
  if (!workflowEnabled && currentOpenVote.kind !== "custom") {
    return { ok: false, error: "Official voting is disabled (missing workflow.json or enabled=false)." };
  }

  let voterSeat: string | null = null;
  try {
    const seatRow = await query<{ turn_order: number }>(
      `
        select da.turn_order
          from debate_agents da
          join debates d on d.id = da.debate_id
         where da.id = $1
           and da.debate_id = $2
           and d.user_id = $3
         limit 1
      `,
      [input.debateAgentId, input.debateId, input.userId]
    );
    if ((seatRow.rowCount ?? 0) === 1) {
      const seatOrder = Number(seatRow.rows[0].turn_order);
      if (Number.isFinite(seatOrder) && seatOrder > 0) voterSeat = `Seat-${Math.floor(seatOrder)}`;
    }
  } catch {
    // ignore
  }

  const choice = String(input.choice ?? "").trim();
  if (!choice) return { ok: false, error: "Custom vote requires choice." };
  const nextBallot = {
    debateAgentId: input.debateAgentId,
    voter: input.voterName,
    ...(voterSeat ? { voterSeat } : {}),
    choice,
    ...(input.reason ? { reason: String(input.reason).trim() } : {}),
    at: now
  };
  const ballots = (openVote.ballots ?? []).filter((ballot) => ballot.debateAgentId !== input.debateAgentId);
  ballots.push(nextBallot);
  const nextOpenVote: OfficialVote = { ...openVote, ballots };
  await upsertDebateFile(input.debateId, VOTE_OPEN_PATH, JSON.stringify(nextOpenVote, null, 2), now);
  return { ok: true, vote: nextOpenVote, ballot: nextBallot };
}

export async function toolVoteClose(input: { userId: string; debateId: string; participantCount: number }) {
  const now = new Date().toISOString();
  const openVote = await loadOpenVote(input.userId, input.debateId);
  if (!openVote) return { ok: false, error: "No open vote." };
  const currentOpenVote = openVote as OpenOfficialVote;
  const workflow = await loadDebateWorkflow(input.userId, input.debateId);
  const workflowEnabled = Boolean(workflow?.enabled);
  const forcedOpen = Boolean(currentOpenVote.meta?.forcedOpen);
  if (!workflowEnabled && currentOpenVote.kind !== "custom") {
    return { ok: false, error: "Official voting is disabled (missing workflow.json or enabled=false)." };
  }
  const voteGovernance = workflow?.voting.governance ?? {
    tieBreaker: "revote" as const,
    maxTieRounds: 2,
    fallbackMode: "逻辑审核员" as string | null
  };
  const currentTieRound = Math.max(0, Math.floor(Number(currentOpenVote.meta?.tieRound) || 0));

  function buildTieReopenMeta(reason: string) {
    return {
      ...(currentOpenVote.meta ?? {}),
      tieRound: currentTieRound + 1,
      reopenedBecause: reason
    };
  }

  if (openVote.kind === "finalization") {
    const counts = new Map<string, number>();
    for (const ballot of openVote.ballots ?? []) {
      counts.set(ballot.choice, (counts.get(ballot.choice) ?? 0) + 1);
    }
    const agreeCount = (openVote.ballots ?? []).filter((ballot) => isFinalizationApproveChoice(String(ballot.choice ?? ""))).length;
    const disagreeCount = (openVote.ballots ?? []).filter((ballot) => isFinalizationRejectChoice(String(ballot.choice ?? ""))).length;
    const totalBallots = (openVote.ballots ?? []).length;
    const missingVotes = Math.max(0, input.participantCount - totalBallots);
    const requireUnanimous = workflow?.phaseMachine.transitionRules.finalization.requireUnanimousVote ?? true;
    const attempt = Math.max(1, Math.floor(Number(openVote.meta?.attempt) || 1));
    const passed = requireUnanimous
      ? agreeCount === input.participantCount && totalBallots === input.participantCount
      : agreeCount > disagreeCount;

    const decisionJson = {
      kind: "finalization",
      at: now,
      roundNumber: openVote.roundNumber,
      title: openVote.title,
      prompt: openVote.prompt,
      attempt,
      passed,
      requireUnanimousVote: requireUnanimous,
      requiredSeats: input.participantCount,
      agreeCount,
      disagreeCount,
      missingVotes,
      counts: Object.fromEntries(counts),
      ballots: openVote.ballots ?? [],
      ...(openVote.meta ? { meta: openVote.meta } : {})
    };
    await upsertDebateFile(input.debateId, VOTE_DECISION_JSON_PATH, JSON.stringify(decisionJson, null, 2), now);

    const decision = passed
      ? [
          "# 官方结论：收束阶段入场表决通过",
          "",
          `- 标题：${openVote.title}`,
          `- 轮次：${openVote.roundNumber}`,
          `- 尝试次数：第 ${attempt} 次`,
          `- 结果：全员同意（${agreeCount}/${input.participantCount}）`,
          "",
          "要求：下一轮开始正式进入收束阶段，所有席位必须转入最终收束、总整合和交付写作。"
        ].join("\n")
      : [
          "# 官方结论：暂不进入收束阶段",
          "",
          `- 标题：${openVote.title}`,
          `- 轮次：${openVote.roundNumber}`,
          `- 尝试次数：第 ${attempt} 次`,
          `- 同意：${agreeCount}`,
          `- 不同意：${disagreeCount}`,
          `- 未投票：${missingVotes}`,
          "",
          "要求：当前继续留在收束投票前阶段，先进行至少一轮全员补充发言，把争议点、证据链和交付缺口补清楚；之后系统会按 workflow 配置再次发起收束阶段入场表决。"
        ].join("\n");
    await upsertDebateFile(input.debateId, VOTE_DECISION_PATH, decision, now);

    const summaryMarkdown = [
      "# 官方投票结果",
      "",
      `- 标题：${openVote.title}`,
      `- 轮次：${openVote.roundNumber}`,
      `- 类型：收束阶段入场表决`,
      `- 尝试次数：第 ${attempt} 次`,
      passed ? `- 结果：通过（${agreeCount}/${input.participantCount} 全员同意）` : "- 结果：未通过",
      "",
      "## 票数",
      `- ${FINALIZATION_VOTE_APPROVE}: ${agreeCount}`,
      `- ${FINALIZATION_VOTE_REJECT}: ${disagreeCount}`,
      `- 未投票: ${missingVotes}`,
      "",
      "## 逐票明细",
      ...(openVote.ballots ?? []).map((ballot) => {
        const reason = ballot.reason ? ` · ${ballot.reason}` : "";
        const voter = ballot.voterSeat ? `${ballot.voterSeat} · ${ballot.voter}` : ballot.voter;
        return `- ${voter}: ${ballot.choice}${reason}`;
      })
    ].join("\n");
    await upsertDebateFile(input.debateId, `${VOTE_RESULT_PREFIX}${openVote.roundNumber}.md`, summaryMarkdown, now);

    const closedVote: OfficialVote = {
      status: "closed",
      kind: "finalization",
      roundNumber: openVote.roundNumber,
      title: openVote.title,
      prompt: openVote.prompt,
      result: {
        ballots: openVote.ballots ?? [],
        counts: Object.fromEntries(counts),
        attempt,
        passed,
        agreeCount,
        disagreeCount,
        missingVotes,
        requiredSeats: input.participantCount
      },
      ...(openVote.meta ? { meta: openVote.meta } : {}),
      closedAt: now,
      createdAt: openVote.createdAt
    };
    await upsertDebateFile(
      input.debateId,
      `${VOTE_RESULT_PREFIX}${openVote.roundNumber}.json`,
      JSON.stringify(closedVote, null, 2),
      now
    );
    await upsertDebateFile(input.debateId, VOTE_OPEN_PATH, JSON.stringify(closedVote, null, 2), now);
    return { ok: true, closed: closedVote, decision };
  }

  const counts = new Map<string, number>();
  for (const ballot of currentOpenVote.ballots ?? []) {
    counts.set(ballot.choice, (counts.get(ballot.choice) ?? 0) + 1);
  }
  const ranked = Array.from(counts.entries()).sort((left, right) => right[1] - left[1]);
  const topCount = ranked[0]?.[1] ?? null;
  const tiedOptions = topCount === null ? [] : ranked.filter((item) => item[1] === topCount).map((item) => item[0]);
  const winner =
    voteGovernance.tieBreaker === "seat_order"
      ? ranked[0]?.[0] ?? null
      : tiedOptions.length === 1
        ? tiedOptions[0]
        : null;

  if (tiedOptions.length > 1 && voteGovernance.tieBreaker === "revote") {
    if (currentTieRound >= voteGovernance.maxTieRounds) {
      return {
        ok: false,
        error: `Custom vote tied after ${currentTieRound} revote(s). Suggested fallback mode: ${voteGovernance.fallbackMode ?? "manual review"}.`,
        tied: true,
        options: tiedOptions
      };
    }

    const reopenedVote: OfficialVote = {
      status: "open",
      kind: "custom",
      roundNumber: currentOpenVote.roundNumber,
      title: currentOpenVote.title,
      prompt: currentOpenVote.prompt,
      options: currentOpenVote.options,
      ballots: [],
      meta: buildTieReopenMeta("custom_tie"),
      createdAt: now
    };
    const decision = [
      "# 官方结论：本轮投票平票",
      "",
      `出现平票：${tiedOptions.join(" / ")}`,
      "",
      `要求：所有席位先补充新的观点/证据/取舍，再重新投票。${voteGovernance.fallbackMode ? `建议先切换到“${voteGovernance.fallbackMode}”模式补信息。` : ""}`
    ].join("\n");
    await upsertDebateFile(input.debateId, VOTE_DECISION_PATH, decision, now);
    await upsertDebateFile(input.debateId, VOTE_OPEN_PATH, JSON.stringify(reopenedVote, null, 2), now);
    return { ok: true, reopened: true, tied: true, vote: reopenedVote, decision };
  }

  const summaryMarkdown = [
    "# 官方投票结果",
    "",
    `- 标题：${currentOpenVote.title}`,
    `- 轮次：${currentOpenVote.roundNumber}`,
    winner ? `- 结果：${winner}` : "- 结果：未能选出",
    "",
    "计票与宣布：下一轮首位发言席位必须先用 3-7 条要点总结本次投票结果，并引用 `votes/round-<round>.json`/`votes/round-<round>.md`（如存在）。",
    "",
    "## 票数",
    ...Array.from(counts.entries())
      .sort((left, right) => right[1] - left[1])
      .map(([choice, count]) => `- ${choice}: ${count}`)
  ].join("\n");
  await upsertDebateFile(input.debateId, `${VOTE_RESULT_PREFIX}${currentOpenVote.roundNumber}.md`, summaryMarkdown, now);

  const decisionJson = {
    kind: "custom",
    at: now,
    roundNumber: currentOpenVote.roundNumber,
    title: currentOpenVote.title,
    prompt: currentOpenVote.prompt,
    options: currentOpenVote.options,
    winner,
    counts: Object.fromEntries(counts),
    ballots: currentOpenVote.ballots ?? [],
    ...(currentOpenVote.meta ? { meta: currentOpenVote.meta } : {})
  };
  await upsertDebateFile(input.debateId, VOTE_DECISION_JSON_PATH, JSON.stringify(decisionJson, null, 2), now);

  const decision = [
    "# 官方结论：投票结果",
    "",
    `- 标题：${currentOpenVote.title}`,
    `- 轮次：${currentOpenVote.roundNumber}`,
    winner ? `- 结果：${winner}` : "- 结果：未能选出",
    "",
    "要求：所有席位后续发言必须以该投票结果为准（如有争议，请在下一轮提出并发起新一轮投票）。",
    "计票与宣布：下一轮首位发言席位必须先用 3-7 条要点总结本次投票结果，并引用 `votes/round-<round>.json`/`votes/round-<round>.md`（如存在）。"
  ].join("\n");
  await upsertDebateFile(input.debateId, VOTE_DECISION_PATH, decision, now);

  const closedVote: OfficialVote = {
    status: "closed",
    kind: "custom",
    roundNumber: currentOpenVote.roundNumber,
    title: currentOpenVote.title,
    prompt: currentOpenVote.prompt,
    result: {
      ballots: currentOpenVote.ballots ?? [],
      counts: Object.fromEntries(counts),
      winner
    },
    ...(currentOpenVote.meta ? { meta: currentOpenVote.meta } : {}),
    closedAt: now,
    createdAt: currentOpenVote.createdAt
  };
  await upsertDebateFile(
    input.debateId,
    `${VOTE_RESULT_PREFIX}${openVote.roundNumber}.json`,
    JSON.stringify(closedVote, null, 2),
    now
  );
  await upsertDebateFile(input.debateId, VOTE_OPEN_PATH, JSON.stringify(closedVote, null, 2), now);
  return { ok: true, closed: closedVote, summary: summaryMarkdown };
}

export type DebateFileWriteMode = "replace" | "append" | "section_merge";

export function normalizeDebateOutputPath(rawPath: string, allowedPrefixes?: string[]) {
  const normalizedPath = rawPath.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalizedPath) return null;
  if (normalizedPath.includes("..")) return null;
  const allowedPathPrefixes =
    Array.isArray(allowedPrefixes) && allowedPrefixes.length > 0 ? allowedPrefixes : ["final/", "outputs/"];
  if (allowedPathPrefixes.some((prefix) => normalizedPath.startsWith(prefix))) return normalizedPath;
  return null;
}

export function isFinalDebateOutputPath(path: string) {
  return path.startsWith("final/");
}

export function normalizeDebateFileWriteMode(path: string, mode?: string | null): DebateFileWriteMode | null {
  if (mode === "replace" || mode === "append" || mode === "section_merge") return mode;
  return isFinalDebateOutputPath(path) ? null : "replace";
}

export function normalizeMarkdownLineEndings(value: string) {
  return value.replace(/\r\n/g, "\n");
}

export function trimMarkdownHeadingText(value: string) {
  return value.replace(/\s+#+\s*$/, "").trim().toLowerCase();
}

export function findHeadingLineMatch(line: string) {
  const match = line.match(/^(#{1,6})\s+(.+?)\s*$/);
  if (!match) return null;
  return { level: match[1].length, text: trimMarkdownHeadingText(match[2]) };
}

export function mergeMarkdownSectionByHeading(existing: string, targetHeading: string, replacement: string) {
  const normalizedExisting = normalizeMarkdownLineEndings(existing);
  const normalizedReplacement = normalizeMarkdownLineEndings(replacement).trim();
  if (!normalizedReplacement) {
    return { error: "section_merge requires non-empty content." };
  }

  const replacementLines = normalizedReplacement.split("\n");
  const replacementHeading = replacementLines.map((line) => line.trim()).find((line) => line.length > 0) ?? "";
  const replacementMatch = findHeadingLineMatch(replacementHeading);
  if (!replacementMatch || replacementMatch.text !== trimMarkdownHeadingText(targetHeading)) {
    return { error: `section_merge content must start with a Markdown heading matching "${targetHeading}".` };
  }

  const existingLines = normalizedExisting.split("\n");
  let targetStartIndex = -1;
  let targetHeadingLevel = 0;
  let inCodeFence = false;

  for (let index = 0; index < existingLines.length; index += 1) {
    const line = existingLines[index];
    if (/^```/.test(line.trim())) inCodeFence = !inCodeFence;
    if (inCodeFence) continue;
    const headingMatch = findHeadingLineMatch(line.trim());
    if (!headingMatch) continue;
    if (headingMatch.text === trimMarkdownHeadingText(targetHeading)) {
      targetStartIndex = index;
      targetHeadingLevel = headingMatch.level;
      break;
    }
  }

  if (targetStartIndex < 0) {
    return { error: `TARGET_HEADING_NOT_FOUND: ${targetHeading}. Read the file first and retry with an existing heading.` };
  }

  let targetEndIndex = existingLines.length;
  inCodeFence = false;
  for (let index = targetStartIndex + 1; index < existingLines.length; index += 1) {
    const line = existingLines[index];
    if (/^```/.test(line.trim())) inCodeFence = !inCodeFence;
    if (inCodeFence) continue;
    const headingMatch = findHeadingLineMatch(line.trim());
    if (headingMatch && headingMatch.level <= targetHeadingLevel) {
      targetEndIndex = index;
      break;
    }
  }

  const mergedLines = [
    ...existingLines.slice(0, targetStartIndex),
    ...replacementLines,
    ...existingLines.slice(targetEndIndex)
  ];
  return { content: mergedLines.join("\n") };
}

export function appendDebateFileContent(existing: string, appended: string) {
  const current = normalizeMarkdownLineEndings(existing).replace(/\s+$/, "");
  const next = normalizeMarkdownLineEndings(appended).replace(/^\s+/, "").trimEnd();
  if (!current) return next;
  if (!next) return current;
  return `${current}\n\n${next}`;
}

export function describeLegacyFinalWriteError(path: string) {
  return `Explicit write mode required for ${path}. Read the file first, then call debate_files_write with mode="section_merge", mode="append", or mode="replace" (replace also requires baseVersion/baseUpdatedAt).`;
}

export function shouldRejectDeliverableShrink(previousContent: string, nextContent: string, allowShrink: boolean) {
  if (allowShrink) return false;
  const previousLength = previousContent.length;
  if (previousLength < DELIVERABLE_REPLACE_SHRINK_MIN_CHARS) return false;
  return nextContent.length < Math.floor(previousLength * DELIVERABLE_REPLACE_SHRINK_RATIO);
}
