import { ensureDb } from "@/lib/db";

export type DebateParticipantRoleType = string;

type DebateParticipantRoleAssignments = {
  byDebateAgentId: Map<string, DebateParticipantRoleType>;
};

const BASE_ROLE_PATH = "context/base_role.json";

function parseBaseRole(content: string) {
  if (!content.trim()) return null;
  try {
    const parsed = JSON.parse(content) as { role?: unknown; baseRole?: unknown };
    const role =
      typeof parsed.baseRole === "string"
        ? parsed.baseRole.trim()
        : typeof parsed.role === "string"
          ? parsed.role.trim()
          : "";
    return role || null;
  } catch {
    return null;
  }
}

export async function loadDebateParticipantRoleTypes(
  userId: string,
  debateId: string
): Promise<DebateParticipantRoleAssignments> {
  const db = await ensureDb();
  const result = await db
    .selectFrom("debate_agents as da")
    .innerJoin("debates as d", "d.id", "da.debate_id")
    .leftJoin("debate_agent_files as f", (join) =>
      join.onRef("f.debate_agent_id", "=", "da.id").on("f.path", "=", BASE_ROLE_PATH)
    )
    .select(["da.id as debate_agent_id", "f.content as content"])
    .where("da.debate_id", "=", debateId)
    .where("d.user_id", "=", userId)
    .execute();

  const byDebateAgentId = new Map<string, DebateParticipantRoleType>();
  for (const row of result) {
    const baseRole = parseBaseRole(String(row.content ?? ""));
    byDebateAgentId.set(String(row.debate_agent_id), baseRole ?? "Participant");
  }

  return { byDebateAgentId };
}

export function getDebateParticipantRoleType(
  assignments: DebateParticipantRoleAssignments,
  debateAgentId: string
): DebateParticipantRoleType {
  return assignments.byDebateAgentId.get(debateAgentId) ?? "Participant";
}
