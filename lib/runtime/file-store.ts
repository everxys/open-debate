import { ensureDb } from "@/lib/db";

function getPgErrorCode(error: unknown) {
  if (typeof error !== "object" || error === null) return null;
  const anyError = error as { code?: unknown };
  return typeof anyError.code === "string" ? anyError.code : null;
}

async function readOwnedContentFile(
  executor: () => Promise<{ content: string } | undefined>
) {
  try {
    const row = await executor();
    if (!row) return null;
    return String(row.content ?? "");
  } catch (error) {
    if (getPgErrorCode(error) === "42P01") return null;
    return null;
  }
}

export async function readDebateAgentFile(userId: string, debateAgentId: string, path: string) {
  return readOwnedContentFile(async () => {
    const db = await ensureDb();
    return await db
      .selectFrom("debate_agent_files as f")
      .innerJoin("debate_agents as da", "da.id", "f.debate_agent_id")
      .innerJoin("debates as d", "d.id", "da.debate_id")
      .select("f.content")
      .where("f.debate_agent_id", "=", debateAgentId)
      .where("d.user_id", "=", userId)
      .where("f.path", "=", path)
      .executeTakeFirst();
  });
}

export async function upsertDebateAgentFile(
  debateAgentId: string,
  path: string,
  content: string,
  now: string
) {
  try {
    const db = await ensureDb();
    await db
      .insertInto("debate_agent_files")
      .values({
        debate_agent_id: debateAgentId,
        path,
        content,
        created_at: now,
        updated_at: now
      })
      .onConflict((oc) =>
        oc.columns(["debate_agent_id", "path"]).doUpdateSet({
          content,
          updated_at: now
        })
      )
      .execute();
  } catch (error) {
    if (getPgErrorCode(error) === "42P01") return;
    throw error;
  }
}

export async function readDebateFile(userId: string, debateId: string, path: string) {
  return readOwnedContentFile(async () => {
    const db = await ensureDb();
    return await db
      .selectFrom("debate_files as f")
      .innerJoin("debates as d", "d.id", "f.debate_id")
      .select("f.content")
      .where("f.debate_id", "=", debateId)
      .where("d.user_id", "=", userId)
      .where("f.path", "=", path)
      .executeTakeFirst();
  });
}

export async function upsertDebateFile(debateId: string, path: string, content: string, now: string) {
  try {
    const db = await ensureDb();
    await db
      .insertInto("debate_files")
      .values({
        debate_id: debateId,
        path,
        content,
        created_at: now,
        updated_at: now
      })
      .onConflict((oc) =>
        oc.columns(["debate_id", "path"]).doUpdateSet({
          content,
          updated_at: now
        })
      )
      .execute();
  } catch (error) {
    if (getPgErrorCode(error) === "42P01") return;
    throw error;
  }
}
