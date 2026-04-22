import { query } from "@/lib/db";
import { toErrorResponse, AppError } from "@/lib/http";
import { readSession } from "@/lib/session";
import {
  enqueueDebateSummaryJob,
  FACTS_BOARD_JOB_KEY,
  listDebateSummaryJobs,
  retryFailedDebateSummaryJobs
} from "@/lib/summary-jobs";
import { getRoundSummaryPath, getTurnSummaryPath } from "@/lib/runtime-main";
import { listClosedOfficialVoteRounds, loadDebateWorkflow, mapActualRoundToSpeechRoundIndex } from "@/lib/runtime/workflow-phase";
import { readDebateFile } from "@/lib/runtime/file-store";

async function requireDebateOwnership(debateId: string, userId: string) {
  const result = await query<{ user_id: string; is_shared: boolean }>(
    "select user_id, is_shared from debates where id = $1",
    [debateId]
  );
  if ((result.rowCount ?? 0) !== 1) throw new AppError("NOT_FOUND", 404, "Debate not found");
  const row = result.rows[0];
  if (String(row.user_id) !== userId && !Boolean(row.is_shared)) {
    throw new AppError("NOT_FOUND", 404, "Debate not found");
  }
}

async function resolveRoundSummaryDependsOnKeys(input: {
  userId: string;
  debateId: string;
  roundNumber: number;
  participantCount: number;
}) {
  const closedVoteRounds = await listClosedOfficialVoteRounds(input.userId, input.debateId);
  const speechRoundIndex = mapActualRoundToSpeechRoundIndex(input.roundNumber, closedVoteRounds);
  if (!speechRoundIndex) {
    throw new AppError("VALIDATION_ERROR", 400, "This round does not have a speech summary");
  }
  const startTurn = (speechRoundIndex - 1) * input.participantCount + 1;
  return Array.from({ length: input.participantCount }, (_, index) => `turn:${startTurn + index}`);
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const session = await readSession();
    if (!session) throw new AppError("AUTH_REQUIRED", 401, "Unauthorized");
    const { id } = await context.params;
    await requireDebateOwnership(id, session.userId);
    const jobs = await listDebateSummaryJobs(id);
    return new Response(JSON.stringify({ success: true, data: jobs }), {
      headers: { "Content-Type": "application/json" }
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const session = await readSession();
    if (!session) throw new AppError("AUTH_REQUIRED", 401, "Unauthorized");
    const { id } = await context.params;
    await requireDebateOwnership(id, session.userId);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const action = String(body.action ?? "");

    if (action === "retry_failed") {
      const jobs = await retryFailedDebateSummaryJobs(id);
      return new Response(JSON.stringify({ success: true, data: jobs }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    const debateResult = await query<{ question: string }>("select question from debates where id = $1", [id]);
    const debateQuestion = String(debateResult.rows[0]?.question ?? "");
    const workflow = await loadDebateWorkflow(session.userId, id);
    const fallbackDebateAgentResult = await query<{ id: string }>(
      "select id from debate_agents where debate_id = $1 order by turn_order asc limit 1",
      [id]
    );
    const fallbackDebateAgentId = String(fallbackDebateAgentResult.rows[0]?.id ?? "");

    if (action === "rebuild_turn") {
      const turnNumber = Number(body.turnNumber);
      if (!Number.isFinite(turnNumber) || turnNumber <= 0) {
        throw new AppError("VALIDATION_ERROR", 400, "turnNumber is required");
      }
      const turnResult = await query<{
        debate_agent_id: string;
        turn_number: number;
        content: string;
        seat_number: number | null;
        display_name: string | null;
      }>(
        `
          select t.debate_agent_id, t.turn_number, t.content, t.seat_number, da.display_name
            from debate_turns t
            join debate_agents da on da.id = t.debate_agent_id
           where t.debate_id = $1 and t.turn_number = $2
           limit 1
        `,
        [id, turnNumber]
      );
      if ((turnResult.rowCount ?? 0) !== 1) throw new AppError("NOT_FOUND", 404, "Turn not found");
      const row = turnResult.rows[0];
      const agentCountResult = await query<{ count: string }>("select count(*)::text as count from debate_agents where debate_id = $1", [id]);
      const agentCount = Math.max(1, Number(agentCountResult.rows[0]?.count ?? 1));
      const roundNumber = Math.floor((turnNumber - 1) / agentCount) + 1;
      const job = await enqueueDebateSummaryJob({
        debateId: id,
        kind: "turn_summary",
        jobKey: `turn:${turnNumber}`,
        turnNumber,
        roundNumber,
        payload: {
          userId: session.userId,
          debateId: id,
          debateAgentId: String(row.debate_agent_id),
          debateQuestion,
          roundNumber,
          turnNumber,
          agentName: String(row.display_name ?? `Seat-${row.seat_number ?? "?"}`),
          content: String(row.content ?? ""),
          refreshFactsBoard: true
        },
        force: true
      });
      return new Response(JSON.stringify({ success: true, data: job }), { headers: { "Content-Type": "application/json" } });
    }

    if (action === "rebuild_round") {
      const roundNumber = Number(body.roundNumber);
      if (!Number.isFinite(roundNumber) || roundNumber <= 0) {
        throw new AppError("VALIDATION_ERROR", 400, "roundNumber is required");
      }
      const agentCountResult = await query<{ count: string }>("select count(*)::text as count from debate_agents where debate_id = $1", [id]);
      const participantCount = Math.max(1, Number(agentCountResult.rows[0]?.count ?? 1));
      const dependsOnKeys = await resolveRoundSummaryDependsOnKeys({
        userId: session.userId,
        debateId: id,
        roundNumber,
        participantCount
      });
      const turnSummaryContents = await Promise.all(
        dependsOnKeys.map(async (key) => {
          const turnNumber = Number(key.replace(/^turn:/, ""));
          return readDebateFile(session.userId, id, getTurnSummaryPath(workflow, roundNumber, turnNumber));
        })
      );
      const allTurnSummariesReady = turnSummaryContents.every((content) => Boolean(content?.trim()));
      const job = await enqueueDebateSummaryJob({
        debateId: id,
        kind: "round_summary",
        jobKey: `round:${roundNumber}`,
        roundNumber,
        dependsOnKeys,
        status: allTurnSummariesReady ? "queued" : "blocked",
        payload: {
          userId: session.userId,
          debateId: id,
          debateAgentId: body.debateAgentId ? String(body.debateAgentId) : fallbackDebateAgentId,
          debateQuestion,
          endedRound: roundNumber,
          participantCount,
          refreshFactsBoard: true
        },
        force: true
      });
      return new Response(JSON.stringify({ success: true, data: job }), { headers: { "Content-Type": "application/json" } });
    }

    if (action === "rebuild_facts") {
      const jobs = await listDebateSummaryJobs(id);
      const latestRound = jobs
        .filter((job) => job.kind === "round_summary" && job.completedAt)
        .sort((a, b) => (b.roundNumber ?? 0) - (a.roundNumber ?? 0))[0];
      let sourceLabel = "manual";
      let sourceSummary = "";
      let turnNumber: number | null = null;
      let roundNumber: number | null = null;
      if (latestRound?.roundNumber) {
        roundNumber = latestRound.roundNumber;
        sourceLabel = `round-${roundNumber}`;
        sourceSummary = (await readDebateFile(session.userId, id, getRoundSummaryPath(workflow, roundNumber)))?.trim() ?? "";
      }
      if (!sourceSummary) {
        const latestTurn = jobs
          .filter((job) => job.kind === "turn_summary" && job.completedAt)
          .sort((a, b) => (b.turnNumber ?? 0) - (a.turnNumber ?? 0))[0];
        if (latestTurn?.turnNumber && latestTurn.roundNumber) {
          turnNumber = latestTurn.turnNumber;
          roundNumber = latestTurn.roundNumber;
          sourceLabel = `turn-${turnNumber}`;
          sourceSummary =
            (await readDebateFile(session.userId, id, getTurnSummaryPath(workflow, roundNumber, turnNumber)))?.trim() ?? "";
        }
      }
      const job = await enqueueDebateSummaryJob({
        debateId: id,
        kind: "facts_board",
        jobKey: FACTS_BOARD_JOB_KEY,
        turnNumber,
        roundNumber,
        payload: {
          userId: session.userId,
          debateId: id,
          debateAgentId: body.debateAgentId ? String(body.debateAgentId) : fallbackDebateAgentId,
          debateQuestion,
          sourceLabel,
          sourceSummary,
          turnNumber,
          roundNumber,
          sourceKey: "manual",
          sourcePriority: latestRound?.roundNumber ? "round" : "turn",
          sourceUpdatedAt: new Date().toISOString()
        },
        priority: 20,
        runAfter: new Date().toISOString(),
        force: true
      });
      return new Response(JSON.stringify({ success: true, data: job }), { headers: { "Content-Type": "application/json" } });
    }

    throw new AppError("VALIDATION_ERROR", 400, "Unsupported action");
  } catch (error) {
    return toErrorResponse(error);
  }
}
