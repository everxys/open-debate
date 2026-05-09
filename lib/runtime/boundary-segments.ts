import { ensureDb } from "@/lib/db";
import {
  CONTEXT_SEGMENT_PATH,
  CONTEXT_WINDOW_PATH,
  VOTE_DECISION_PATH,
  WORKFLOW_PATH
} from "@/lib/runtime/constants";
import {
  readDebateFile,
  upsertDebateAgentFile,
  upsertDebateFile
} from "@/lib/runtime/file-store";
import { getPgErrorCode } from "@/lib/runtime/runtime-utils";
import { appendWorkflowSummaryLines } from "@/lib/runtime/workflow-summary";
import { safeParseWorkflowJson } from "@/lib/workflow";

function padSegmentIndex(index: number) {
  return String(index).padStart(4, "0");
}

async function loadSegmentParticipantRows(userId: string, debateId: string) {
  const db = await ensureDb();
  return db
    .selectFrom("debate_agents as da")
    .innerJoin("ai_agents as a", "a.id", "da.ai_agent_id")
    .innerJoin("debates as d", "d.id", "da.debate_id")
    .select(["da.turn_order", "a.name as agent_name"])
    .where("da.debate_id", "=", debateId)
    .where("d.user_id", "=", userId)
    .orderBy("da.turn_order", "asc")
    .execute();
}

async function buildSegmentCheckpointContent(input: {
  userId: string;
  debateId: string;
  participantCount: number;
  currentTurn: number;
  question: string;
  reason: string;
  now: string;
  seg: string;
  seatOnly: boolean;
}) {
  const participants = await loadSegmentParticipantRows(input.userId, input.debateId);
  const completedRounds = Math.floor(input.currentTurn / Math.max(1, input.participantCount));
  const minTurnNumber = input.currentTurn + 1;

  const workflowRaw = await readDebateFile(input.userId, input.debateId, WORKFLOW_PATH);
  const workflow = safeParseWorkflowJson(workflowRaw);
  const officialDecision = (await readDebateFile(input.userId, input.debateId, VOTE_DECISION_PATH)) ?? "";

  const lines: string[] = [];
  lines.push(`# Segment Checkpoint · ${input.seg}`);
  lines.push("");
  lines.push(`- At: ${input.now}`);
  lines.push(`- Completed rounds: ${completedRounds}`);
  lines.push(`- Current turn: ${input.currentTurn}`);
  lines.push(
    input.seatOnly
      ? `- Context window reset (this seat only): next model calls will inject recent turns from Turn >= ${minTurnNumber}.`
      : `- Context window reset: next model calls will inject recent turns from Turn >= ${minTurnNumber}.`
  );
  if (input.reason) lines.push(`- Reason: ${input.reason}`);
  lines.push("");
  lines.push("## Question");
  lines.push(input.question ? input.question : "(empty)");
  lines.push("");
  lines.push("## Seats (current order)");
  for (const row of participants) {
    lines.push(`- Seat-${Number(row.turn_order)}: ${String(row.agent_name ?? "Unknown")}`);
  }

  lines.push("");
  appendWorkflowSummaryLines(lines, workflow);

  if (officialDecision.trim()) {
    lines.push("");
    lines.push("## Latest official decision");
    lines.push(officialDecision.trim());
  }

  lines.push("");
  lines.push("## Notes");
  lines.push(
    input.seatOnly
      ? "- This checkpoint is injected only to this seat."
      : "- This checkpoint is injected to all seats as a shared segment context."
  );
  lines.push("- Long-term memory (per seat) and shared facts (if enabled) are still used.");

  return {
    checkpointContent: lines.join("\n").trim() + "\n",
    minTurnNumber
  };
}

export async function startAutoSegmentAtBoundary(input: {
  userId: string;
  debateId: string;
  participantCount: number;
  currentTurn: number;
  question: string;
  reason: string;
  now: string;
}) {
  const checkpointPrefix = "context/checkpoints/seg-";

  const db = await ensureDb();
  const existing = await db
    .selectFrom("debate_files")
    .select("path")
    .where("debate_id", "=", input.debateId)
    .where("path", "like", `${checkpointPrefix}%`)
    .orderBy("path", "asc")
    .limit(200)
    .execute();

  const nextIndex = existing.length + 1;
  const seg = `seg-${padSegmentIndex(nextIndex)}`;
  const checkpointPath = `${checkpointPrefix}${padSegmentIndex(nextIndex)}.md`;
  const { checkpointContent, minTurnNumber } = await buildSegmentCheckpointContent({
    ...input,
    seg,
    seatOnly: false
  });

  await upsertDebateFile(
    input.debateId,
    CONTEXT_WINDOW_PATH,
    JSON.stringify({ enabled: true, minTurnNumber, at: input.now, seg, reason: input.reason }, null, 2),
    input.now
  );
  await upsertDebateFile(input.debateId, CONTEXT_SEGMENT_PATH, checkpointContent, input.now);
  await upsertDebateFile(input.debateId, checkpointPath, checkpointContent, input.now);
}

export async function startAutoSegmentForDebateAgentAtBoundary(input: {
  userId: string;
  debateId: string;
  debateAgentId: string;
  participantCount: number;
  currentTurn: number;
  question: string;
  reason: string;
  now: string;
}) {
  const checkpointPrefix = "context/checkpoints/seg-";

  const db = await ensureDb();
  let existingCount = 0;
  try {
    const existing = await db
      .selectFrom("debate_agent_files as f")
      .select("f.path")
      .where("f.debate_agent_id", "=", input.debateAgentId)
      .where("f.path", "like", `${checkpointPrefix}%`)
      .orderBy("f.path", "asc")
      .limit(200)
      .execute();
    existingCount = existing.length;
  } catch (error) {
    if (getPgErrorCode(error) !== "42P01") throw error;
    existingCount = 0;
  }

  const nextIndex = existingCount + 1;
  const seg = `seg-${padSegmentIndex(nextIndex)}`;
  const checkpointPath = `${checkpointPrefix}${padSegmentIndex(nextIndex)}.md`;
  const { checkpointContent, minTurnNumber } = await buildSegmentCheckpointContent({
    ...input,
    seg,
    seatOnly: true
  });

  await upsertDebateAgentFile(
    input.debateAgentId,
    CONTEXT_WINDOW_PATH,
    JSON.stringify({ enabled: true, minTurnNumber, at: input.now, seg, reason: input.reason }, null, 2),
    input.now
  );
  await upsertDebateAgentFile(input.debateAgentId, CONTEXT_SEGMENT_PATH, checkpointContent, input.now);
  await upsertDebateAgentFile(input.debateAgentId, checkpointPath, checkpointContent, input.now);
}
