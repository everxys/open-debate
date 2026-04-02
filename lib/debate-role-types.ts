import { query } from "@/lib/db";

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
  const result = await query<{ debate_agent_id: string; content: string | null }>(
    `
      select da.id as debate_agent_id,
             f.content as content
        from debate_agents da
        join debates d on d.id = da.debate_id
        left join debate_agent_files f
          on f.debate_agent_id = da.id
         and f.path = $3
       where da.debate_id = $1
         and d.user_id = $2
    `,
    [debateId, userId, BASE_ROLE_PATH]
  );

  const byDebateAgentId = new Map<string, DebateParticipantRoleType>();
  for (const row of result.rows) {
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
