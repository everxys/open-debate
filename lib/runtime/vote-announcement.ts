import { sql } from "kysely";

import { decryptSecret } from "@/lib/crypto";
import { ensureDb } from "@/lib/db";
import { AppError } from "@/lib/http";
import { ensureQuotaReservationOrDelay, isQuotaDelayError, type QuotaReservationInput } from "@/lib/quota-control";
import {
  VOTE_ANNOUNCEMENT_PATH,
  VOTE_ANNOUNCEMENT_PREFIX,
  VOTE_DECISION_JSON_PATH
} from "@/lib/runtime/constants";
import {
  readDebateFile,
  upsertDebateFile
} from "@/lib/runtime/file-store";
import {
  openAiChatOnce,
  resolveChatUrl
} from "@/lib/runtime/provider-openai";
import {
  buildBaseSystemPrompt,
  describeRuntimeError,
  logRuntimeEvent,
  summarizeOptionText
} from "@/lib/runtime/provider-shared";
import { normalizeAgentRow } from "@/lib/runtime/runtime-parsing";
import { buildFallbackVoteAnnouncement } from "@/lib/runtime/boundary-votes";
import {
  loadDebateAgentSystemPrompt,
  loadDebateParticipantsInline
} from "@/lib/runtime/runtime-inline-loaders";
import {
  loadDebateWorkflow,
  safeJsonParse,
  type OfficialVote
} from "@/lib/runtime/workflow-phase";
import type { DebateRecord } from "@/lib/types";

export async function maybeGenerateVoteAnnouncementWithSeat1(input: {
  userId: string;
  debate: DebateRecord;
  participantCount: number;
  closed: OfficialVote;
}) {
  if (!input.closed || input.closed.status !== "closed") return { ok: true, generated: false };

  const roundNumber = input.closed.roundNumber;
  const roundPath = `${VOTE_ANNOUNCEMENT_PREFIX}${roundNumber}.md`;
  const existing = await readDebateFile(input.userId, input.debate.id, roundPath);
  if (existing && existing.trim()) return { ok: true, generated: false, reason: "already_exists" };

  const workflow = await loadDebateWorkflow(input.userId, input.debate.id);
  const participantsInline = await loadDebateParticipantsInline(input.userId, input.debate.id);
  const decisionJsonRaw = await readDebateFile(input.userId, input.debate.id, VOTE_DECISION_JSON_PATH);
  const decisionJson = decisionJsonRaw ? (safeJsonParse<Record<string, unknown>>(decisionJsonRaw) ?? null) : null;

  let announcerSeatNumber = 1;
  const announcerRoleLabel = "Host";
  const fallbackAnnouncerSeatNumber = 1;

  const db = await ensureDb();
  const announcer = await db
    .selectFrom("debate_agents as da")
    .innerJoin("ai_agents as a", "a.id", "da.ai_agent_id")
    .innerJoin("debates as d", "d.id", "da.debate_id")
    .selectAll("a")
    .select("da.id as debate_agent_id")
    .where("da.debate_id", "=", input.debate.id)
    .where("d.user_id", "=", input.userId)
    .where("da.turn_order", "=", announcerSeatNumber)
    .limit(1)
    .executeTakeFirst();

  let announcerRow: Record<string, unknown> | null = announcer ? (announcer as Record<string, unknown>) : null;
  if (!announcerRow) {
    const fallbackSeat = await db
      .selectFrom("debate_agents as da")
      .innerJoin("ai_agents as a", "a.id", "da.ai_agent_id")
      .innerJoin("debates as d", "d.id", "da.debate_id")
      .selectAll("a")
      .select("da.id as debate_agent_id")
      .where("da.debate_id", "=", input.debate.id)
      .where("d.user_id", "=", input.userId)
      .where("da.turn_order", "=", fallbackAnnouncerSeatNumber)
      .limit(1)
      .executeTakeFirst();
    if (!fallbackSeat) {
      return { ok: false, generated: false, error: `Seat-${fallbackAnnouncerSeatNumber} agent not found.` };
    }
    announcerSeatNumber = fallbackAnnouncerSeatNumber;
    announcerRow = fallbackSeat as Record<string, unknown>;
  }

  const announcerDebateAgentId = String(announcerRow.debate_agent_id);
  const agent = normalizeAgentRow(announcerRow);
  const overrideSystemPrompt = await loadDebateAgentSystemPrompt(input.userId, announcerDebateAgentId);
  const apiKey = decryptSecret(agent.apiKeyEncrypted);
  const url = resolveChatUrl(agent);

  const proposalRound = Math.max(1, Math.floor(roundNumber) - 1);
  const proposalStart = 1;
  const proposalEnd = proposalRound * input.participantCount;
  const proposalTurns = await db
    .selectFrom("debate_turns as t")
    .innerJoin("ai_agents as a", "a.id", "t.ai_agent_id")
    .leftJoin("debate_agents as da", "da.id", "t.debate_agent_id")
    .innerJoin("debates as d", "d.id", "t.debate_id")
    .select([
      "t.turn_number",
      "t.seat_number",
      "t.content",
      sql<string>`coalesce(da.display_name, a.name)`.as("speaker_name")
    ])
    .where("t.debate_id", "=", input.debate.id)
    .where("d.user_id", "=", input.userId)
    .where("t.turn_number", ">=", proposalStart)
    .where("t.turn_number", "<=", proposalEnd)
    .orderBy("t.turn_number", "asc")
    .limit(200)
    .execute();
  const proposalInline =
    proposalTurns.length > 0
      ? [
          `Rounds 1-${proposalRound} (read-only; for vote context):`,
          ...proposalTurns.map((r) => {
            const tn = Number(r.turn_number);
            const seatNumber =
              r.seat_number === null ? ((tn - 1) % input.participantCount) + 1 : Number(r.seat_number);
            const seat = `Seat-${seatNumber}`;
            const name = String(r.speaker_name ?? "Unknown");
            const body = summarizeOptionText(String(r.content ?? ""), 260);
            return `- ${seat} · ${name}: ${body}`;
          })
        ].join("\n")
      : null;

  const system = [
    buildBaseSystemPrompt(agent, overrideSystemPrompt),
    `SYSTEM TASK: You are Seat-${announcerSeatNumber}${announcerRoleLabel ? ` (${announcerRoleLabel})` : ""} acting as the official vote announcer.`,
    "Output only Markdown for humans; no tool calls."
  ].join("\n\n");

  const userPrompt = [
    `Debate question:\n${input.debate.question}`,
    participantsInline ? `\n\n${participantsInline}` : "",
    proposalInline ? `\n\n${proposalInline}` : "",
    `\n\nOfficial vote closed (JSON):\n\`\`\`json\n${JSON.stringify(input.closed, null, 2)}\n\`\`\``,
    decisionJson ? `\n\nOfficial decision data (JSON):\n\`\`\`json\n${JSON.stringify(decisionJson, null, 2)}\n\`\`\`` : "",
    "\n\nWrite a concise announcement that all seats must follow:",
    "- Title line with round number",
    "- 3-7 bullet points: winner, turnout, and next step",
    "- End with one short decision sentence starting with: OFFICIAL DECISION:"
  ]
    .join("")
    .trim();

  let content = "";
  const quotaRequest: QuotaReservationInput = {
    userId: input.userId,
    usageControlMode: agent.usageControlMode,
    quotaProfileId: agent.quotaProfileId,
    requestKind: "vote_announcement",
    agentId: agent.id,
    agentName: agent.name,
    debateId: input.debate.id,
    debateAgentId: announcerDebateAgentId
  };
  try {
    if (agent.provider === "openai") {
      const res = await openAiChatOnce({
        url,
        apiKey,
        quotaRequest,
        body: { model: agent.model, messages: [{ role: "system", content: system }, { role: "user", content: userPrompt }] }
      });
      content = String(res.content ?? "").trim();
    } else {
      await ensureQuotaReservationOrDelay(quotaRequest);
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
          model: agent.model,
          max_tokens: 900,
          system,
          messages: [{ role: "user", content: userPrompt }]
        })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new AppError("AI_API_ERROR", 502, JSON.stringify(payload).slice(0, 400));
      }
      const blocks = (payload.content ?? []) as Array<Record<string, unknown>>;
      const texts = blocks
        .filter((b) => b.type === "text")
        .map((b) => String((b as { text?: unknown }).text ?? ""))
        .filter(Boolean);
      content = texts.join("\n").trim();
    }
  } catch (error) {
    if (isQuotaDelayError(error)) throw error;
    await logRuntimeEvent("warn", "vote announcement generation failed", { error: describeRuntimeError(error) });
  }

  const now = new Date().toISOString();
  const finalContent =
    content ||
    buildFallbackVoteAnnouncement({
      debateQuestion: input.debate.question,
      participantsInline,
      closed: input.closed,
      decisionJson
    });

  await upsertDebateFile(input.debate.id, roundPath, finalContent.trim() + "\n", now);
  await upsertDebateFile(input.debate.id, VOTE_ANNOUNCEMENT_PATH, finalContent.trim() + "\n", now);
  return { ok: true, generated: true, path: roundPath };
}
