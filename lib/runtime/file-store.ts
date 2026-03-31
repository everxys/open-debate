import { query } from "@/lib/db";

function getPgErrorCode(error: unknown) {
  if (typeof error !== "object" || error === null) return null;
  const anyError = error as { code?: unknown };
  return typeof anyError.code === "string" ? anyError.code : null;
}

async function readOwnedContentFile(sql: string, params: unknown[]) {
  try {
    const result = await query<{ content: string }>(sql, params);
    if ((result.rowCount ?? 0) !== 1) return null;
    return String(result.rows[0].content ?? "");
  } catch (error) {
    if (getPgErrorCode(error) === "42P01") return null;
    return null;
  }
}

export async function readDebateAgentFile(userId: string, debateAgentId: string, path: string) {
  return readOwnedContentFile(
    `
      select f.content
        from debate_agent_files f
        join debate_agents da on da.id = f.debate_agent_id
        join debates d on d.id = da.debate_id
       where f.debate_agent_id = $1
         and d.user_id = $2
         and f.path = $3
       limit 1
    `,
    [debateAgentId, userId, path]
  );
}

export async function upsertDebateAgentFile(
  debateAgentId: string,
  path: string,
  content: string,
  now: string
) {
  try {
    await query(
      `
        insert into debate_agent_files (debate_agent_id, path, content, created_at, updated_at)
        values ($1, $2, $3, $4, $4)
        on conflict (debate_agent_id, path)
        do update set content = excluded.content, updated_at = excluded.updated_at
      `,
      [debateAgentId, path, content, now]
    );
  } catch (error) {
    if (getPgErrorCode(error) === "42P01") return;
    throw error;
  }
}

export async function readDebateFile(userId: string, debateId: string, path: string) {
  return readOwnedContentFile(
    `
      select f.content
        from debate_files f
        join debates d on d.id = f.debate_id
       where f.debate_id = $1
         and d.user_id = $2
         and f.path = $3
       limit 1
    `,
    [debateId, userId, path]
  );
}

export async function upsertDebateFile(debateId: string, path: string, content: string, now: string) {
  try {
    await query(
      `
        insert into debate_files (debate_id, path, content, created_at, updated_at)
        values ($1, $2, $3, $4, $4)
        on conflict (debate_id, path)
        do update set content = excluded.content, updated_at = excluded.updated_at
      `,
      [debateId, path, content, now]
    );
  } catch (error) {
    if (getPgErrorCode(error) === "42P01") return;
    throw error;
  }
}
