import { randomUUID } from "crypto";

import { query } from "@/lib/db";
import { AppError } from "@/lib/http";
import { runDebate } from "@/lib/runtime";
import { readSession } from "@/lib/session";
import type { DebateRecord } from "@/lib/types";
import { createDebateSchema, updateDebateQuestionSchema, updateDebateSharingSchema } from "@/lib/validation";
import { normalizeDebateWorkflow } from "@/lib/workflow";

function normalizeDebateRow(row: Record<string, unknown>): DebateRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    question: String(row.question),
    status: row.status as DebateRecord["status"],
    maxTurns: Number(row.max_turns),
    currentTurn: Number(row.current_turn),
    tokenUsed: Number(row.token_used),
    enableSharedFacts: row.enable_shared_facts === undefined ? true : Boolean(row.enable_shared_facts),
    isShared: row.is_shared === undefined ? false : Boolean(row.is_shared),
    consensusReached: Boolean(row.consensus_reached),
    consensusSummary: (row.consensus_summary as DebateRecord["consensusSummary"]) ?? null,
    lastErrorCode: (row.last_error_code as string | null) ?? null,
    lastErrorMessage: (row.last_error_message as string | null) ?? null,
    startedAt: (row.started_at as string | null) ?? null,
    finishedAt: (row.finished_at as string | null) ?? null,
    stoppedReason: (row.stopped_reason as string | null) ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function toListItem(debate: DebateRecord) {
  return {
    id: debate.id,
    question: debate.question,
    status: debate.status,
    currentTurn: debate.currentTurn,
    maxTurns: debate.maxTurns,
    tokenUsed: debate.tokenUsed,
    isShared: debate.isShared,
    consensusReached: debate.consensusReached,
    createdAt: debate.createdAt
  };
}

async function requireSessionUser() {
  const session = await readSession();
  if (!session) {
    throw new AppError("AUTH_REQUIRED", 401, "Authentication required");
  }
  return session;
}

function isMissingTableError(error: unknown, table: string) {
  if (typeof error !== "object" || error === null) return false;
  const anyError = error as { code?: unknown; message?: unknown };
  if (anyError.code !== "42P01") return false;
  const message = typeof anyError.message === "string" ? anyError.message : "";
  return message.toLowerCase().includes(table.toLowerCase());
}

function isMissingColumnError(error: unknown, column: string) {
  if (typeof error !== "object" || error === null) return false;
  const anyError = error as { code?: unknown; message?: unknown };
  if (anyError.code !== "42703") return false;
  const message = typeof anyError.message === "string" ? anyError.message : "";
  return message.toLowerCase().includes(column.toLowerCase());
}

async function getDebate(id: string) {
  const session = await requireSessionUser();
  const result = await query<Record<string, unknown>>(
    "select * from debates where id = $1 and user_id = $2",
    [id, session.userId]
  );
  if ((result.rowCount ?? 0) !== 1) {
    throw new AppError("NOT_FOUND", 404, "Debate not found");
  }
  return { session, debate: normalizeDebateRow(result.rows[0]) };
}

async function getDebateForView(id: string, userId: string) {
  try {
    const result = await query<Record<string, unknown>>(
      `
        select d.*,
               (d.user_id = $2) as is_owner
          from debates d
         where d.id = $1
           and (d.user_id = $2 or d.is_shared = true)
      `,
      [id, userId]
    );
    if ((result.rowCount ?? 0) !== 1) {
      throw new AppError("NOT_FOUND", 404, "Debate not found");
    }
    return {
      debate: normalizeDebateRow(result.rows[0]),
      isOwner: Boolean((result.rows[0] as { is_owner?: unknown }).is_owner)
    };
  } catch (error) {
    if (isMissingColumnError(error, "is_shared")) {
      throw new AppError("MIGRATION_REQUIRED", 500, "Missing debates.is_shared column");
    }
    throw error;
  }
}

export async function listDebates(scope: "mine" | "shared" = "mine") {
  const session = await requireSessionUser();
  if (scope === "shared") {
    try {
      const result = await query<Record<string, unknown>>(
        `
          select d.*,
                 (select count(*)::int from debate_agents da where da.debate_id = d.id) as agent_count
            from debates d
           where d.is_shared = true
           order by d.updated_at desc
           limit 200
        `
      );
      return result.rows.map((row: Record<string, unknown>) => ({
        ...toListItem(normalizeDebateRow(row)),
        agentCount: Number(row.agent_count ?? 0)
      }));
    } catch (error) {
      if (isMissingColumnError(error, "is_shared")) {
        throw new AppError("MIGRATION_REQUIRED", 500, "Missing debates.is_shared column");
      }
      throw error;
    }
  }

  const result = await query<Record<string, unknown>>(
    `
      select d.*,
             (select count(*)::int from debate_agents da where da.debate_id = d.id) as agent_count
        from debates d
       where d.user_id = $1
       order by d.created_at desc
    `,
    [session.userId]
  );
  return result.rows.map((row: Record<string, unknown>) => ({
    ...toListItem(normalizeDebateRow(row)),
    agentCount: Number(row.agent_count ?? 0)
  }));
}

export async function createDebate(input: unknown) {
  const data = createDebateSchema.parse(input);
  const session = await requireSessionUser();

  if ("agentIds" in data) {
    const agents = await query<{ id: string }>(
      "select id from ai_agents where user_id = $1 and deleted_at is null and id = any($2::uuid[])",
      [session.userId, data.agentIds]
    );

    if ((agents.rowCount ?? 0) !== data.agentIds.length) {
      throw new AppError("VALIDATION_ERROR", 400, "Selected agents are invalid");
    }

    const now = new Date().toISOString();
    const insertedDebate = await query<Record<string, unknown>>(
      `insert into debates (
        user_id, question, status, max_turns, current_turn, token_budget, token_used, enable_shared_facts,
        consensus_reached, consensus_summary, last_error_code, last_error_message,
        started_at, finished_at, stopped_reason, created_at, updated_at
      ) values ($1,$2,'pending',$3,0,null,0,$4,false,null,null,null,null,null,null,$5,$5)
      returning *`,
      [session.userId, data.question, data.maxTurns, data.enableSharedFacts, now]
    );

    const debate = normalizeDebateRow(insertedDebate.rows[0]);
    for (let index = 0; index < data.agentIds.length; index += 1) {
      await query(
        `insert into debate_agents (debate_id, ai_agent_id, turn_order, turn_count, created_at)
         values ($1,$2,$3,0,$4)`,
        [debate.id, data.agentIds[index], index + 1, now]
      );
    }

    return toListItem(debate);
  }

  const bindings = data.strategy.bindings;
  const roleIds = bindings.map((binding) => binding.roleId);
  const agentIds = bindings.map((binding) => binding.agentId);
  const uniqueAgentIds = Array.from(new Set(agentIds));

  let strategyVisible: { id: string } | null = null;
  try {
    const strategyResult = await query<{ id: string }>(
      "select id from strategies where id = $1 and (owner_user_id = $2 or is_shared = true)",
      [data.strategy.strategyId, session.userId]
    );
    strategyVisible = strategyResult.rows[0] ?? null;
  } catch (error) {
    if (isMissingTableError(error, "strategies")) {
      throw new AppError("MIGRATION_REQUIRED", 500, "Missing strategies tables");
    }
    throw error;
  }

  if (!strategyVisible) {
    throw new AppError("NOT_FOUND", 404, "Strategy not found");
  }

  const agents = await query<{ id: string }>(
    "select id from ai_agents where user_id = $1 and deleted_at is null and id = any($2::uuid[])",
    [session.userId, uniqueAgentIds]
  );
  if ((agents.rowCount ?? 0) !== uniqueAgentIds.length) {
    throw new AppError("VALIDATION_ERROR", 400, "Selected agents are invalid");
  }

  let rolesById = new Map<string, { id: string; systemPrompt: string | null }>();
  try {
    const roleResult = await query<Record<string, unknown>>(
      "select id, system_prompt from strategy_roles where strategy_id = $1 and id = any($2::uuid[])",
      [data.strategy.strategyId, roleIds]
    );
    rolesById = new Map(
      roleResult.rows.map((row) => [
        String(row.id),
        { id: String(row.id), systemPrompt: (row.system_prompt as string | null) ?? null }
      ])
    );
  } catch (error) {
    if (isMissingTableError(error, "strategy_roles")) {
      throw new AppError("MIGRATION_REQUIRED", 500, "Missing strategies tables");
    }
    throw error;
  }

  if (rolesById.size !== new Set(roleIds).size) {
    throw new AppError("VALIDATION_ERROR", 400, "Selected strategy roles are invalid");
  }

  const now = new Date().toISOString();
  const insertedDebate = await query<Record<string, unknown>>(
    `insert into debates (
      user_id, question, status, max_turns, current_turn, token_budget, token_used, enable_shared_facts,
      consensus_reached, consensus_summary, last_error_code, last_error_message,
      started_at, finished_at, stopped_reason, created_at, updated_at
    ) values ($1,$2,'pending',$3,0,null,0,$4,false,null,null,null,null,null,null,$5,$5)
    returning *`,
    [session.userId, data.question, data.maxTurns, data.enableSharedFacts, now]
  );

  const debate = normalizeDebateRow(insertedDebate.rows[0]);

  try {
    const uniqueRoleIds = Array.from(new Set(roleIds));
    const workflow = await query<{ content: string }>(
      `
        select content
          from strategy_role_files
         where strategy_role_id = any($1::uuid[])
           and lower(path) = 'debate/workflow.json'
         limit 1
      `,
      [uniqueRoleIds]
    );
    if ((workflow.rowCount ?? 0) >= 1) {
      const content = String(workflow.rows[0]?.content ?? "").trim();
      if (content) {
        await query(
          `
            insert into debate_files (debate_id, path, content, created_at, updated_at)
            values ($1, 'workflow.json', $2, $3, $3)
            on conflict (debate_id, path)
            do update set content = excluded.content, updated_at = excluded.updated_at
          `,
          [debate.id, content, now]
        );
      }
    }

    for (let index = 0; index < bindings.length; index += 1) {
      const binding = bindings[index];
      const insertParticipant = await query<{ id: string }>(
        `insert into debate_agents (debate_id, ai_agent_id, turn_order, turn_count, created_at)
         values ($1,$2,$3,0,$4)
         returning id`,
        [debate.id, binding.agentId, index + 1, now]
      );

      const debateAgentId = insertParticipant.rows[0]?.id;
      if (!debateAgentId) {
        throw new AppError("INTERNAL_ERROR", 500, "Failed to create debate agent");
      }

      const role = rolesById.get(binding.roleId);
      await query(
        `insert into debate_agent_overrides (debate_agent_id, system_prompt, created_at, updated_at)
         values ($1,$2,$3,$3)`,
        [debateAgentId, role?.systemPrompt ?? null, now]
      );

      const roleFiles = await query<{ path: string; content: string }>(
        "select path, content from strategy_role_files where strategy_role_id = $1 order by path asc",
        [binding.roleId]
      );

      for (const file of roleFiles.rows) {
        const path = String(file.path ?? "");
        const normalized = path.replace(/\\/g, "/").replace(/^\/+/, "").trim().toLowerCase();
        if (normalized.startsWith("memory/")) continue;
        if (normalized === "debate/workflow.json") continue;
        await query(
          `insert into debate_agent_files (id, debate_agent_id, path, content, created_at, updated_at)
           values ($1,$2,$3,$4,$5,$5)`,
          [randomUUID(), debateAgentId, path, file.content ?? "", now]
        );
      }
    }
  } catch (error) {
    if (
      isMissingTableError(error, "strategy_role_files") ||
      isMissingTableError(error, "debate_agent_overrides") ||
      isMissingTableError(error, "debate_agent_files") ||
      isMissingTableError(error, "debate_files")
    ) {
      throw new AppError("MIGRATION_REQUIRED", 500, "Missing strategies tables");
    }
    throw error;
  }

  return toListItem(debate);
}

export async function getDebateDetail(id: string) {
  const session = await requireSessionUser();
  const { debate, isOwner } = await getDebateForView(id, session.userId);
  const agentRows = await query<Record<string, unknown>>(
    `
      select da.id as debate_agent_id,
             da.ai_agent_id,
             da.turn_order,
             da.turn_count,
             a.name as agent_name,
             a.provider as agent_provider,
             a.context_length as context_length
        from debate_agents da
        join ai_agents a on a.id = da.ai_agent_id
       where da.debate_id = $1
       order by da.turn_order asc
    `,
    [debate.id]
  );

  const agents = agentRows.rows.map((item) => ({
    id: String(item.ai_agent_id),
    debateAgentId: String(item.debate_agent_id),
    name: item.agent_name ? String(item.agent_name) : "Unknown",
    provider: item.agent_provider ? String(item.agent_provider) : "openai",
    contextLength: item.context_length === null ? null : Number(item.context_length),
    turnOrder: Number(item.turn_order),
    turnCount: Number(item.turn_count)
  }));

  return {
    id: debate.id,
    question: debate.question,
    status: debate.status,
    currentTurn: debate.currentTurn,
    maxTurns: debate.maxTurns,
    tokenUsed: debate.tokenUsed,
    isShared: debate.isShared,
    isOwner,
    consensusReached: debate.consensusReached,
    consensusSummary: debate.consensusSummary,
    agents
  };
}

export async function updateDebateQuestion(id: string, input: unknown) {
  const session = await requireSessionUser();
  const data = updateDebateQuestionSchema.parse(input);
  const now = new Date().toISOString();

  const existing = await query<{ status: string; question: string }>(
    "select status, question from debates where id = $1 and user_id = $2",
    [id, session.userId]
  );
  if ((existing.rowCount ?? 0) !== 1) {
    throw new AppError("NOT_FOUND", 404, "Debate not found");
  }
  const status = String(existing.rows[0].status ?? "");
  const previousQuestion = String(existing.rows[0].question ?? "");
  if (status === "running") {
    throw new AppError("CONFLICT", 409, "Please pause the debate before editing the question");
  }
  if (!["pending", "paused"].includes(status)) {
    throw new AppError("CONFLICT", 409, "Debate question cannot be edited in current status");
  }

  const result = await query<Record<string, unknown>>(
    `update debates
        set question = $3,
            updated_at = $4
      where id = $1 and user_id = $2 and status in ('pending','paused')
      returning *`,
    [id, session.userId, data.question, now]
  );
  if ((result.rowCount ?? 0) !== 1) {
    throw new AppError("CONFLICT", 409, "Debate question update failed");
  }

  // Persist latest diff and versions for runtime injection.
  const prevLines = previousQuestion.replace(/\r\n/g, "\n").split("\n");
  const nextLines = data.question.replace(/\r\n/g, "\n").split("\n");
  let prefix = 0;
  while (prefix < prevLines.length && prefix < nextLines.length && prevLines[prefix] === nextLines[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < prevLines.length - prefix &&
    suffix < nextLines.length - prefix &&
    prevLines[prevLines.length - 1 - suffix] === nextLines[nextLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const removed = prevLines.slice(prefix, prevLines.length - suffix);
  const added = nextLines.slice(prefix, nextLines.length - suffix);
  const limit = 120;
  const removedShown = removed.slice(0, limit);
  const addedShown = added.slice(0, limit);
  const diffLines = [
    ...removedShown.map((line) => `- ${line}`),
    ...addedShown.map((line) => `+ ${line}`)
  ];
  const truncatedNote =
    removed.length > removedShown.length || added.length > addedShown.length
      ? "\n\n（diff 过长，已截断展示）"
      : "";

  try {
    type HistoryItem = { version: number; path: string; at: string };
    const historyPath = "question/history.json";
    const versionPrefix = "question/versions/";
    const pad = (n: number) => String(n).padStart(4, "0");

    const historyRes = await query<{ content: string }>(
      "select content from debate_files where debate_id = $1 and path = $2 limit 1",
      [id, historyPath]
    );
    let history: HistoryItem[] = [];
    if ((historyRes.rowCount ?? 0) === 1) {
      try {
        const parsed = JSON.parse(String(historyRes.rows[0].content ?? "")) as unknown;
        if (Array.isArray(parsed)) {
          history = parsed
            .map((item) => ({
              version: Number((item as { version?: unknown }).version),
              path: String((item as { path?: unknown }).path ?? ""),
              at: String((item as { at?: unknown }).at ?? "")
            }))
            .filter((item) => Number.isFinite(item.version) && item.version > 0 && item.path);
        }
      } catch {
      }
    }

    // If no history yet, seed v0001 from previous question (best-effort).
    if (history.length === 0) {
      const seededPath = `${versionPrefix}v${pad(1)}.md`;
      await query(
        `
          insert into debate_files (debate_id, path, content, created_at, updated_at)
          values ($1, $2, $3, $4, $4)
          on conflict (debate_id, path)
          do update set content = excluded.content, updated_at = excluded.updated_at
        `,
        [id, seededPath, previousQuestion, now]
      );
      history.push({ version: 1, path: seededPath, at: now });
    }

    const previousVersion = history[history.length - 1]?.version ?? 1;
    const nextVersion = previousVersion + 1;
    const nextVersionPath = `${versionPrefix}v${pad(nextVersion)}.md`;

    await query(
      `
        insert into debate_files (debate_id, path, content, created_at, updated_at)
        values ($1, $2, $3, $4, $4)
        on conflict (debate_id, path)
        do update set content = excluded.content, updated_at = excluded.updated_at
      `,
      [id, nextVersionPath, data.question, now]
    );
    history.push({ version: nextVersion, path: nextVersionPath, at: now });

    await query(
      `
        insert into debate_files (debate_id, path, content, created_at, updated_at)
        values ($1, $2, $3, $4, $4)
        on conflict (debate_id, path)
        do update set content = excluded.content, updated_at = excluded.updated_at
      `,
      [id, historyPath, JSON.stringify(history, null, 2), now]
    );

    const diffMarkdown = [
      "# QUESTION UPDATED",
      "",
      `- At: ${now}`,
      `- From: v${previousVersion}`,
      `- To: v${nextVersion}`,
      "",
      "```diff",
      ...diffLines,
      "```",
      truncatedNote
    ]
      .join("\n")
      .trim();

    await query(
      `
        insert into debate_files (debate_id, path, content, created_at, updated_at)
        values ($1, $2, $3, $4, $4)
        on conflict (debate_id, path)
        do update set content = excluded.content, updated_at = excluded.updated_at
      `,
      [id, "question/latest_diff.md", diffMarkdown, now]
    );
  } catch (error) {
    if (!isMissingTableError(error, "debate_files")) throw error;
  }

  return toListItem(normalizeDebateRow(result.rows[0]));
}

export async function updateDebateSharing(id: string, input: unknown) {
  const session = await requireSessionUser();
  const data = updateDebateSharingSchema.parse(input);
  const now = new Date().toISOString();

  try {
    const result = await query<Record<string, unknown>>(
      `update debates
          set is_shared = $3,
              updated_at = $4
        where id = $1 and user_id = $2
        returning *`,
      [id, session.userId, data.isShared, now]
    );

    if ((result.rowCount ?? 0) !== 1) {
      throw new AppError("NOT_FOUND", 404, "Debate not found");
    }

    return toListItem(normalizeDebateRow(result.rows[0]));
  } catch (error) {
    if (isMissingColumnError(error, "is_shared")) {
      throw new AppError("MIGRATION_REQUIRED", 500, "Missing debates.is_shared column");
    }
    throw error;
  }
}

export async function deleteDebate(id: string) {
  const session = await requireSessionUser();

  const existing = await query<{ status: string }>(
    "select status from debates where id = $1 and user_id = $2",
    [id, session.userId]
  );
  if ((existing.rowCount ?? 0) !== 1) {
    throw new AppError("NOT_FOUND", 404, "Debate not found");
  }
  if (String(existing.rows[0].status) === "running") {
    throw new AppError("CONFLICT", 409, "Please stop the debate before deleting");
  }

  await query("delete from debates where id = $1 and user_id = $2", [id, session.userId]);
  return { id };
}

export async function listDebateTurns(
  id: string,
  options?: {
    afterTurnNumber?: number;
    limit?: number;
  }
) {
  const session = await requireSessionUser();
  const { debate } = await getDebateForView(id, session.userId);
  const afterRaw = options?.afterTurnNumber ?? null;
  const afterTurnNumber = typeof afterRaw === "number" && Number.isFinite(afterRaw) && afterRaw >= 0 ? Math.floor(afterRaw) : null;
  const limitRaw = options?.limit ?? null;
  const limit = typeof limitRaw === "number" && Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : null;
  const turnRows = await query<Record<string, unknown>>(
    `
      select t.*,
             a.name as agent_name,
             a.provider as agent_provider
        from debate_turns t
        join ai_agents a on a.id = t.ai_agent_id
       where t.debate_id = $1
         and ($2::int is null or t.turn_number > $2::int)
       order by t.turn_number asc
       ${limit ? "limit $3::int" : ""}
    `,
    limit ? [debate.id, afterTurnNumber, limit] : [debate.id, afterTurnNumber]
  );

  return turnRows.rows.map((turn) => ({
    id: String(turn.id),
    turnNumber: Number(turn.turn_number),
    content: String(turn.content),
    structuredOutput: (turn.structured_output as Record<string, unknown> | null) ?? null,
    parseStatus: String(turn.parse_status),
    tokenUsed: Number(turn.token_used),
    createdAt: String(turn.created_at),
    agent: {
      name: turn.agent_name ? String(turn.agent_name) : "Unknown",
      provider: turn.agent_provider ? String(turn.agent_provider) : "openai"
    }
  }));
}

export type DebateAllFileEntry =
  | {
      scope: "debate";
      path: string;
      updatedAt: string | null;
    }
  | {
      scope: "agent";
      debateAgentId: string;
      turnOrder: number | null;
      agentName: string;
      path: string;
      updatedAt: string | null;
    };

export async function listDebateAllFiles(debateId: string): Promise<DebateAllFileEntry[]> {
  const session = await requireSessionUser();
  const { isOwner } = await getDebateForView(debateId, session.userId);
  if (!isOwner) {
    throw new AppError("NOT_FOUND", 404, "Debate not found");
  }

  const entries: DebateAllFileEntry[] = [];

  try {
    const debateFiles = await query<{ path: string; updated_at: string | null }>(
      `
        select f.path, f.updated_at
          from debate_files f
         where f.debate_id = $1
         order by f.path asc
         limit 5000
      `,
      [debateId]
    );
    for (const row of debateFiles.rows) {
      entries.push({
        scope: "debate",
        path: String(row.path),
        updatedAt: row.updated_at ? String(row.updated_at) : null
      });
    }
  } catch (error) {
    if (isMissingTableError(error, "debate_files")) {
      throw new AppError("MIGRATION_REQUIRED", 500, "Missing debate_files table");
    }
    throw error;
  }

  try {
    const agentFiles = await query<{ debate_agent_id: string; turn_order: number | null; agent_name: string | null; path: string; updated_at: string | null }>(
      `
        select da.id as debate_agent_id,
               da.turn_order as turn_order,
               a.name as agent_name,
               f.path as path,
               f.updated_at as updated_at
          from debate_agent_files f
          join debate_agents da on da.id = f.debate_agent_id
          join ai_agents a on a.id = da.ai_agent_id
         where da.debate_id = $1
         order by da.turn_order asc nulls last, a.name asc, f.path asc
         limit 20000
      `,
      [debateId]
    );
    for (const row of agentFiles.rows) {
      entries.push({
        scope: "agent",
        debateAgentId: String(row.debate_agent_id),
        turnOrder: row.turn_order === null ? null : Number(row.turn_order),
        agentName: row.agent_name ? String(row.agent_name) : "Unknown",
        path: String(row.path),
        updatedAt: row.updated_at ? String(row.updated_at) : null
      });
    }
  } catch (error) {
    if (isMissingTableError(error, "debate_agent_files")) {
      // Keep debate files available even if agent files table doesn't exist yet.
      return entries;
    }
    throw error;
  }

  return entries;
}

export async function listDebateFiles(id: string, prefix?: string) {
  const session = await requireSessionUser();
  const { isOwner } = await getDebateForView(id, session.userId);
  if (!isOwner) {
    throw new AppError("NOT_FOUND", 404, "Debate not found");
  }

  try {
    const result = await query<{ path: string }>(
      `
        select f.path
          from debate_files f
         where f.debate_id = $1
           and f.path like $2
         order by f.path asc
         limit 500
      `,
      [id, `${(prefix ?? "").trim()}%`]
    );
    return result.rows.map((row) => String(row.path));
  } catch (error) {
    if (isMissingTableError(error, "debate_files")) {
      throw new AppError("MIGRATION_REQUIRED", 500, "Missing debate_files table");
    }
    throw error;
  }
}

export async function readDebateFile(id: string, path: string) {
  const session = await requireSessionUser();
  const { isOwner } = await getDebateForView(id, session.userId);
  if (!isOwner) {
    throw new AppError("NOT_FOUND", 404, "Debate not found");
  }

  try {
    const result = await query<{ content: string; updated_at: string }>(
      `
        select f.content, f.updated_at
          from debate_files f
         where f.debate_id = $1
           and f.path = $2
         limit 1
      `,
      [id, path]
    );
    if ((result.rowCount ?? 0) !== 1) {
      throw new AppError("NOT_FOUND", 404, "File not found");
    }
    return {
      path,
      content: String(result.rows[0].content ?? ""),
      updatedAt: String(result.rows[0].updated_at ?? "")
    };
  } catch (error) {
    if (isMissingTableError(error, "debate_files")) {
      throw new AppError("MIGRATION_REQUIRED", 500, "Missing debate_files table");
    }
    throw error;
  }
}

export async function listDebateAgentFiles(debateId: string, debateAgentId: string, prefix?: string) {
  const session = await requireSessionUser();
  const { isOwner } = await getDebateForView(debateId, session.userId);
  if (!isOwner) {
    throw new AppError("NOT_FOUND", 404, "Debate not found");
  }

  try {
    const result = await query<{ path: string }>(
      `
        select f.path
          from debate_agent_files f
          join debate_agents da on da.id = f.debate_agent_id
         where da.debate_id = $1
           and f.debate_agent_id = $2
           and f.path like $3
         order by f.path asc
         limit 500
      `,
      [debateId, debateAgentId, `${(prefix ?? "").trim()}%`]
    );
    return result.rows.map((row) => String(row.path));
  } catch (error) {
    if (isMissingTableError(error, "debate_agent_files")) {
      throw new AppError("MIGRATION_REQUIRED", 500, "Missing debate_agent_files table");
    }
    throw error;
  }
}

export async function readDebateAgentFile(debateId: string, debateAgentId: string, path: string) {
  const session = await requireSessionUser();
  const { isOwner } = await getDebateForView(debateId, session.userId);
  if (!isOwner) {
    throw new AppError("NOT_FOUND", 404, "Debate not found");
  }

  try {
    const result = await query<{ content: string; updated_at: string }>(
      `
        select f.content, f.updated_at
          from debate_agent_files f
          join debate_agents da on da.id = f.debate_agent_id
         where da.debate_id = $1
           and f.debate_agent_id = $2
           and f.path = $3
         limit 1
      `,
      [debateId, debateAgentId, path]
    );
    if ((result.rowCount ?? 0) !== 1) {
      throw new AppError("NOT_FOUND", 404, "File not found");
    }
    return {
      path,
      content: String(result.rows[0].content ?? ""),
      updatedAt: String(result.rows[0].updated_at ?? "")
    };
  } catch (error) {
    if (isMissingTableError(error, "debate_agent_files")) {
      throw new AppError("MIGRATION_REQUIRED", 500, "Missing debate_agent_files table");
    }
    throw error;
  }
}

export async function reorderDebateSeats(id: string, input: unknown) {
  const session = await requireSessionUser();
  const body = input as { order?: unknown };
  const order = Array.isArray(body?.order) ? body.order.map((x) => String(x)) : [];
  if (order.length < 2) {
    throw new AppError("VALIDATION_ERROR", 400, "order must include at least 2 debateAgentIds");
  }

  const debateRes = await query<{ status: string; current_turn: number }>(
    "select status, current_turn from debates where id = $1 and user_id = $2",
    [id, session.userId]
  );
  if ((debateRes.rowCount ?? 0) !== 1) {
    throw new AppError("NOT_FOUND", 404, "Debate not found");
  }
  const status = String(debateRes.rows[0].status ?? "");
  const currentTurn = Number(debateRes.rows[0].current_turn ?? 0);
  if (!["pending", "paused"].includes(status)) {
    throw new AppError("CONFLICT", 409, "Please pause the debate before reordering seats");
  }

  const agentsRes = await query<{ id: string; turn_order: number }>(
    "select id, turn_order from debate_agents where debate_id = $1 order by turn_order asc",
    [id]
  );
  const debateAgentIds = agentsRes.rows.map((row) => String(row.id));
  const participantCount = debateAgentIds.length;
  if (participantCount !== order.length) {
    throw new AppError("VALIDATION_ERROR", 400, "order length must match participant count");
  }

  if (status === "paused" && participantCount > 0 && currentTurn % participantCount !== 0) {
    throw new AppError("CONFLICT", 409, "Please reorder seats at a round boundary (after a full round ends)");
  }

  const expected = new Set(debateAgentIds);
  for (const item of order) {
    if (!expected.has(item)) {
      throw new AppError("VALIDATION_ERROR", 400, "order includes invalid debateAgentId");
    }
  }
  if (new Set(order).size !== order.length) {
    throw new AppError("VALIDATION_ERROR", 400, "order contains duplicates");
  }

  // Two-phase update to avoid unique(debate_id, turn_order) conflicts.
  const now = new Date().toISOString();
  await query("update debate_agents set turn_order = turn_order + 1000 where debate_id = $1", [id]);
  for (let index = 0; index < order.length; index += 1) {
    await query(
      "update debate_agents set turn_order = $3 where debate_id = $1 and id = $2",
      [id, order[index], index + 1]
    );
  }
  await query("update debates set updated_at = $2 where id = $1 and user_id = $3", [id, now, session.userId]);

  return { id, order };
}

export async function startDebateSegment(id: string, input: unknown) {
  const session = await requireSessionUser();
  const body = input as { reason?: unknown };
  const reason = typeof body?.reason === "string" ? body.reason.trim() : "";

  const debateRes = await query<{ status: string; current_turn: number; question: string }>(
    "select status, current_turn, question from debates where id = $1 and user_id = $2",
    [id, session.userId]
  );
  if ((debateRes.rowCount ?? 0) !== 1) {
    throw new AppError("NOT_FOUND", 404, "Debate not found");
  }

  const status = String(debateRes.rows[0].status ?? "");
  const currentTurn = Number(debateRes.rows[0].current_turn ?? 0);
  const question = String(debateRes.rows[0].question ?? "");
  if (status !== "paused") {
    throw new AppError("CONFLICT", 409, "Please pause the debate before starting a new segment");
  }

  const participants = await query<{ debate_agent_id: string; turn_order: number; agent_name: string }>(
    `
      select da.id as debate_agent_id,
             da.turn_order,
             a.name as agent_name
        from debate_agents da
        join ai_agents a on a.id = da.ai_agent_id
       where da.debate_id = $1
       order by da.turn_order asc
       limit 50
    `,
    [id]
  );
  const participantCount = participants.rows.length;
  if (participantCount < 2) {
    throw new AppError("VALIDATION_ERROR", 400, "Debate requires at least 2 agents");
  }
  if (participantCount > 0 && currentTurn % participantCount !== 0) {
    throw new AppError("CONFLICT", 409, "Please start a new segment at a round boundary (after a full round ends)");
  }

  const now = new Date().toISOString();
  const completedRounds = Math.floor(currentTurn / participantCount);
  const minTurnNumber = currentTurn + 1;

  let workflow: ReturnType<typeof normalizeDebateWorkflow> | null = null;
  try {
    const workflowRes = await query<{ content: string }>(
      "select content from debate_files where debate_id = $1 and path = 'workflow.json' limit 1",
      [id]
    );
    const workflowRaw = (workflowRes.rowCount ?? 0) === 1 ? String(workflowRes.rows[0]?.content ?? "") : "";
    workflow = workflowRaw ? normalizeDebateWorkflow(JSON.parse(workflowRaw) as unknown) : null;
  } catch {
    workflow = null;
  }

  let directive = "";
  try {
    const directiveRes = await query<{ content: string }>(
      "select content from debate_files where debate_id = $1 and path = 'votes/directive.md' limit 1",
      [id]
    );
    directive = (directiveRes.rowCount ?? 0) === 1 ? String(directiveRes.rows[0]?.content ?? "") : "";
  } catch {
    directive = "";
  }

  const checkpointPrefix = "context/checkpoints/seg-";
  const existing = await query<{ path: string }>(
    "select path from debate_files where debate_id = $1 and path like $2 order by path asc limit 200",
    [id, `${checkpointPrefix}%`]
  );
  const nextIndex = (existing.rowCount ?? 0) + 1;
  const pad = (n: number) => String(n).padStart(4, "0");
  const seg = `seg-${pad(nextIndex)}`;
  const checkpointPath = `${checkpointPrefix}${pad(nextIndex)}.md`;

  const lines: string[] = [];
  lines.push(`# Segment Checkpoint · ${seg}`);
  lines.push("");
  lines.push(`- At: ${now}`);
  lines.push(`- Completed rounds: ${completedRounds}`);
  lines.push(`- Current turn: ${currentTurn}`);
  lines.push(`- Context window reset: next model calls will inject recent turns from Turn >= ${minTurnNumber}.`);
  if (reason) lines.push(`- Reason: ${reason}`);
  lines.push("");
  lines.push("## Question");
  lines.push(question ? question : "(empty)");
  lines.push("");
  lines.push("## Seats (current order)");
  for (const row of participants.rows) {
    lines.push(`- Seat-${Number(row.turn_order)}: ${String(row.agent_name ?? "Unknown")}`);
  }

  lines.push("");
  lines.push("## Workflow (summary)");
  if (!workflow?.enabled) {
    lines.push("- disabled (no workflow.json or enabled=false)");
  } else {
    lines.push(`- version: v${workflow.workflowVersion}`);
    lines.push(`- election startRound: ${workflow.election.startRound}`);
    lines.push(`- election roles: ${workflow.election.roles.length ? workflow.election.roles.join(" / ") : "(none)"}`);
    const first = workflow.election.speakingOrder.firstRole;
    const last = workflow.election.speakingOrder.lastRole;
    lines.push(`- speakingOrder (after election, next-round boundary): first=${first ?? "(none)"}; last=${last ?? "(none)"}`);
    if (workflow.seatOrderRules.length === 0) {
      lines.push("- seatOrderRules: (none)");
    } else {
      lines.push("- seatOrderRules:");
      for (const rule of workflow.seatOrderRules) {
        lines.push(
          `  - afterRound=${rule.afterRound}: ${rule.policy.type}${rule.policy.type === "rotate" ? ` offset=${rule.policy.offset}` : ""}`
        );
      }
    }
  }

  if (directive.trim()) {
    lines.push("");
    lines.push("## Latest official directive");
    lines.push(directive.trim());
  }

  lines.push("");
  lines.push("## Notes");
  lines.push("- This checkpoint is injected to all seats as a shared segment context.");
  lines.push("- Long-term memory (per seat) and shared facts (if enabled) are still used.");

  const checkpointContent = lines.join("\n").trim() + "\n";

  try {
    await query(
      `
        insert into debate_files (debate_id, path, content, created_at, updated_at)
        values ($1, $2, $3, $4, $4)
        on conflict (debate_id, path)
        do update set content = excluded.content, updated_at = excluded.updated_at
      `,
      [id, "context/window.json", JSON.stringify({ enabled: true, minTurnNumber, at: now, seg, reason }, null, 2), now]
    );
    await query(
      `
        insert into debate_files (debate_id, path, content, created_at, updated_at)
        values ($1, $2, $3, $4, $4)
        on conflict (debate_id, path)
        do update set content = excluded.content, updated_at = excluded.updated_at
      `,
      [id, "context/segment.md", checkpointContent, now]
    );
    await query(
      `
        insert into debate_files (debate_id, path, content, created_at, updated_at)
        values ($1, $2, $3, $4, $4)
        on conflict (debate_id, path)
        do update set content = excluded.content, updated_at = excluded.updated_at
      `,
      [id, checkpointPath, checkpointContent, now]
    );
  } catch (error) {
    if (isMissingTableError(error, "debate_files")) {
      throw new AppError("MIGRATION_REQUIRED", 500, "Missing debate_files table");
    }
    throw error;
  }

  return { ok: true, seg, minTurnNumber, checkpointPath };
}

export async function startDebate(id: string) {
  const session = await requireSessionUser();

  const before = await query<{ status: string; current_turn: number }>(
    "select status, current_turn from debates where id = $1 and user_id = $2",
    [id, session.userId]
  );
  if ((before.rowCount ?? 0) !== 1) {
    throw new AppError("NOT_FOUND", 404, "Debate not found");
  }
  const beforeStatus = String(before.rows[0].status ?? "");
  const beforeTurn = Number(before.rows[0].current_turn ?? 0);

  const now = new Date().toISOString();
  const result = await query<Record<string, unknown>>(
    `update debates
        set status = 'running',
            started_at = coalesce(started_at, $3),
            updated_at = $3
      where id = $1 and user_id = $2 and status in ('pending','paused')
      returning *`,
    [id, session.userId, now]
  );
  if ((result.rowCount ?? 0) !== 1) {
    throw new AppError("CONFLICT", 409, "Debate cannot be started");
  }

  // Safety: older versions could accidentally seed memory/* into a brand-new debate (via strategy role files).
  // Ensure a new debate starts with a fresh context.
  if (beforeStatus === "pending" && beforeTurn === 0) {
    await query(
      `
        delete from debate_agent_files f
        using debate_agents da
        where f.debate_agent_id = da.id
          and da.debate_id = $1
          and lower(replace(f.path, '\\\\', '/')) like 'memory/%'
      `,
      [id]
    );

    await query("delete from debate_files where debate_id = $1 and path = $2", [id, "facts/board.md"]);
  }

  void runDebate(id, session.userId);
  return toListItem(normalizeDebateRow(result.rows[0]));
}

export async function pauseDebate(id: string) {
  const session = await requireSessionUser();
  const result = await query<Record<string, unknown>>(
    `update debates
        set status = 'paused',
            updated_at = $3
      where id = $1 and user_id = $2 and status = 'running'
      returning *`,
    [id, session.userId, new Date().toISOString()]
  );
  if ((result.rowCount ?? 0) !== 1) {
    throw new AppError("CONFLICT", 409, "Only running debates can be paused");
  }
  return toListItem(normalizeDebateRow(result.rows[0]));
}

export async function resumeDebate(id: string) {
  const session = await requireSessionUser();
  const result = await query<Record<string, unknown>>(
    `update debates
        set status = 'running',
            updated_at = $3
      where id = $1 and user_id = $2 and status = 'paused'
      returning *`,
    [id, session.userId, new Date().toISOString()]
  );
  if ((result.rowCount ?? 0) !== 1) {
    throw new AppError("CONFLICT", 409, "Only paused debates can be resumed");
  }
  void runDebate(id, session.userId);
  return toListItem(normalizeDebateRow(result.rows[0]));
}

export async function stopDebate(id: string, reason: string) {
  const session = await requireSessionUser();
  const now = new Date().toISOString();
  const result = await query<Record<string, unknown>>(
    `update debates
        set status = 'stopped',
            stopped_reason = $3,
            finished_at = $4,
            updated_at = $4
      where id = $1 and user_id = $2 and status in ('pending','running','paused')
      returning *`,
    [id, session.userId, reason, now]
  );
  if ((result.rowCount ?? 0) !== 1) {
    throw new AppError("CONFLICT", 409, "Debate is already finished");
  }
  return toListItem(normalizeDebateRow(result.rows[0]));
}

export async function appendAgentToDebate(id: string, agentId: string) {
  const { session, debate } = await getDebate(id);
  if (!["running", "paused"].includes(debate.status)) {
    throw new AppError("CONFLICT", 409, "Only running/paused debates can add new agents");
  }

  const agent = await query<{ id: string }>(
    "select id from ai_agents where user_id = $1 and deleted_at is null and id = $2",
    [session.userId, agentId]
  );
  if ((agent.rowCount ?? 0) !== 1) {
    throw new AppError("NOT_FOUND", 404, "Agent not found");
  }

  const exists = await query<{ id: string }>(
    "select id from debate_agents where debate_id = $1 and ai_agent_id = $2",
    [debate.id, agentId]
  );
  if ((exists.rowCount ?? 0) > 0) {
    throw new AppError("CONFLICT", 409, "Agent already joined this debate");
  }

  const maxOrderResult = await query<{ max: number }>(
    "select coalesce(max(turn_order), 0)::int as max from debate_agents where debate_id = $1",
    [debate.id]
  );
  const maxOrder = maxOrderResult.rows[0]?.max ?? 0;
  const now = new Date().toISOString();

  await query(
    `insert into debate_agents (debate_id, ai_agent_id, turn_order, turn_count, created_at)
     values ($1,$2,$3,0,$4)`,
    [debate.id, agentId, maxOrder + 1, now]
  );

  await query("update debates set updated_at = $2 where id = $1", [debate.id, now]);

  return getDebateDetail(debate.id);
}
