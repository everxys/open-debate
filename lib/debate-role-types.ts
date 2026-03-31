import { query } from "@/lib/db";

export type DebateParticipantRoleType = "Host" | "Supervisor" | "Specialist";

type SuccessfulElectionAssignments = {
  byDebateAgentId: Map<string, DebateParticipantRoleType>;
  roundNumber: number | null;
};

function parseVoteRoundNumber(path: string) {
  const match = String(path ?? "")
    .replace(/\\/g, "/")
    .match(/^votes\/round-([0-9]{1,6})\.json$/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

function parseSuccessfulElectionAssignments(
  content: string,
  seatToDebateAgentId: Map<string, string>
): SuccessfulElectionAssignments | null {
  if (!content.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (obj.status !== "closed" || obj.kind !== "election") return null;
  const result = obj.result && typeof obj.result === "object" ? (obj.result as Record<string, unknown>) : null;
  if (!result || result.passed !== true) return null;
  const winners = result.winners && typeof result.winners === "object" ? (result.winners as Record<string, unknown>) : null;
  if (!winners) return null;

  const byDebateAgentId = new Map<string, DebateParticipantRoleType>();
  const hostSeat = typeof winners.Host === "string" ? String(winners.Host) : null;
  const supervisorSeat = typeof winners.Supervisor === "string" ? String(winners.Supervisor) : null;
  const hostDebateAgentId = hostSeat ? seatToDebateAgentId.get(hostSeat) ?? null : null;
  const supervisorDebateAgentId = supervisorSeat ? seatToDebateAgentId.get(supervisorSeat) ?? null : null;
  if (hostDebateAgentId) byDebateAgentId.set(hostDebateAgentId, "Host");
  if (supervisorDebateAgentId) byDebateAgentId.set(supervisorDebateAgentId, "Supervisor");

  const roundNumber = typeof obj.roundNumber === "number" ? Math.floor(obj.roundNumber) : null;
  return { byDebateAgentId, roundNumber };
}

export async function loadDebateParticipantRoleTypes(
  userId: string,
  debateId: string
): Promise<SuccessfulElectionAssignments> {
  const participants = await query<{ debate_agent_id: string; turn_order: number }>(
    `
      select da.id as debate_agent_id,
             da.turn_order
        from debate_agents da
        join debates d on d.id = da.debate_id
       where da.debate_id = $1
         and d.user_id = $2
    `,
    [debateId, userId]
  );
  const seatToDebateAgentId = new Map<string, string>();
  for (const row of participants.rows) {
    const turnOrder = Number(row.turn_order ?? 0);
    if (Number.isFinite(turnOrder) && turnOrder > 0) {
      seatToDebateAgentId.set(`Seat-${Math.floor(turnOrder)}`, String(row.debate_agent_id));
    }
  }

  const roundFiles = await query<{ path: string; content: string }>(
    `
      select f.path, coalesce(f.content, '') as content
        from debate_files f
        join debates d on d.id = f.debate_id
       where f.debate_id = $1
         and d.user_id = $2
         and f.path like 'votes/round-%.json'
    `,
    [debateId, userId]
  );

  const candidates = roundFiles.rows
    .map((row) => ({
      path: String(row.path ?? ""),
      content: String(row.content ?? ""),
      roundNumber: parseVoteRoundNumber(String(row.path ?? "")) ?? 0
    }))
    .filter((row) => row.roundNumber > 0)
    .sort((a, b) => b.roundNumber - a.roundNumber);

  for (const item of candidates) {
    const parsed = parseSuccessfulElectionAssignments(item.content, seatToDebateAgentId);
    if (parsed) return parsed;
  }

  return {
    byDebateAgentId: new Map<string, DebateParticipantRoleType>(),
    roundNumber: null
  };
}

export function getDebateParticipantRoleType(
  assignments: SuccessfulElectionAssignments,
  debateAgentId: string
): DebateParticipantRoleType {
  return assignments.byDebateAgentId.get(debateAgentId) ?? "Specialist";
}
