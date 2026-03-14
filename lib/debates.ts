import { randomUUID } from "crypto";

import { query } from "@/lib/db";
import { AppError } from "@/lib/http";
import { runDebate } from "@/lib/runtime";
import { readSession } from "@/lib/session";
import type { DebateRecord } from "@/lib/types";
import { createDebateSchema } from "@/lib/validation";

function normalizeDebateRow(row: Record<string, unknown>): DebateRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    question: String(row.question),
    status: row.status as DebateRecord["status"],
    maxTurns: Number(row.max_turns),
    currentTurn: Number(row.current_turn),
    tokenBudget: row.token_budget === null ? null : Number(row.token_budget),
    tokenUsed: Number(row.token_used),
    enableSharedFacts: row.enable_shared_facts === undefined ? true : Boolean(row.enable_shared_facts),
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

export async function listDebates() {
  const session = await requireSessionUser();
  const result = await query<Record<string, unknown>>(
    "select * from debates where user_id = $1 order by created_at desc",
    [session.userId]
  );
  return result.rows.map((row: Record<string, unknown>) => toListItem(normalizeDebateRow(row)));
}

export async function createDebate(input: unknown) {
  const data = createDebateSchema.parse(input);
  const session = await requireSessionUser();

  if ("agentIds" in data) {
    const agents = await query<{ id: string }>(
      "select id from ai_agents where user_id = $1 and id = any($2::uuid[])",
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
      ) values ($1,$2,'pending',$3,0,$4,0,$5,false,null,null,null,null,null,null,$6,$6)
      returning *`,
      [session.userId, data.question, data.maxTurns, data.tokenBudget ?? null, data.enableSharedFacts, now]
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

  if (new Set(roleIds).size !== roleIds.length) {
    throw new AppError("VALIDATION_ERROR", 400, "Duplicate role bindings");
  }
  if (new Set(agentIds).size !== agentIds.length) {
    throw new AppError("VALIDATION_ERROR", 400, "Duplicate agent bindings");
  }

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
    "select id from ai_agents where user_id = $1 and id = any($2::uuid[])",
    [session.userId, agentIds]
  );
  if ((agents.rowCount ?? 0) !== agentIds.length) {
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

  if (rolesById.size !== roleIds.length) {
    throw new AppError("VALIDATION_ERROR", 400, "Selected strategy roles are invalid");
  }

  const now = new Date().toISOString();
  const insertedDebate = await query<Record<string, unknown>>(
    `insert into debates (
      user_id, question, status, max_turns, current_turn, token_budget, token_used, enable_shared_facts,
      consensus_reached, consensus_summary, last_error_code, last_error_message,
      started_at, finished_at, stopped_reason, created_at, updated_at
    ) values ($1,$2,'pending',$3,0,$4,0,$5,false,null,null,null,null,null,null,$6,$6)
    returning *`,
    [session.userId, data.question, data.maxTurns, data.tokenBudget ?? null, data.enableSharedFacts, now]
  );

  const debate = normalizeDebateRow(insertedDebate.rows[0]);

  try {
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
        await query(
          `insert into debate_agent_files (id, debate_agent_id, path, content, created_at, updated_at)
           values ($1,$2,$3,$4,$5,$5)`,
          [randomUUID(), debateAgentId, file.path, file.content ?? "", now]
        );
      }
    }
  } catch (error) {
    if (
      isMissingTableError(error, "strategy_role_files") ||
      isMissingTableError(error, "debate_agent_overrides") ||
      isMissingTableError(error, "debate_agent_files")
    ) {
      throw new AppError("MIGRATION_REQUIRED", 500, "Missing strategies tables");
    }
    throw error;
  }

  return toListItem(debate);
}

export async function getDebateDetail(id: string) {
  const { debate, session } = await getDebate(id);
  const [agentRows, agentInfoRows] = await Promise.all([
    query<Record<string, unknown>>(
      "select * from debate_agents where debate_id = $1 order by turn_order asc",
      [debate.id]
    ),
    query<Record<string, unknown>>(
      "select id, name, provider from ai_agents where user_id = $1",
      [session.userId]
    )
  ]);

  const agentMap = new Map(agentInfoRows.rows.map((item) => [String(item.id), item]));
  const agents = agentRows.rows.map((item) => {
    const agent = agentMap.get(String(item.ai_agent_id));
    return {
      id: String(item.ai_agent_id),
      name: agent?.name ? String(agent.name) : "Unknown",
      provider: agent?.provider ? String(agent.provider) : "openai",
      turnOrder: Number(item.turn_order),
      turnCount: Number(item.turn_count)
    };
  });

  return {
    id: debate.id,
    question: debate.question,
    status: debate.status,
    currentTurn: debate.currentTurn,
    maxTurns: debate.maxTurns,
    tokenUsed: debate.tokenUsed,
    tokenBudget: debate.tokenBudget,
    consensusReached: debate.consensusReached,
    consensusSummary: debate.consensusSummary,
    agents
  };
}

export async function listDebateTurns(id: string) {
  const { debate, session } = await getDebate(id);
  const [turnRows, agentRows] = await Promise.all([
    query<Record<string, unknown>>(
      "select * from debate_turns where debate_id = $1 order by turn_number asc",
      [debate.id]
    ),
    query<Record<string, unknown>>(
      "select id, name, provider from ai_agents where user_id = $1",
      [session.userId]
    )
  ]);

  const agentMap = new Map(agentRows.rows.map((item) => [String(item.id), item]));
  return turnRows.rows.map((turn) => {
    const agent = agentMap.get(String(turn.ai_agent_id));
    return {
      id: String(turn.id),
      turnNumber: Number(turn.turn_number),
      content: String(turn.content),
      structuredOutput: (turn.structured_output as Record<string, unknown> | null) ?? null,
      parseStatus: String(turn.parse_status),
      tokenUsed: Number(turn.token_used),
      createdAt: String(turn.created_at),
      agent: {
        name: agent?.name ? String(agent.name) : "Unknown",
        provider: agent?.provider ? String(agent.provider) : "openai"
      }
    };
  });
}

export async function startDebate(id: string) {
  const session = await requireSessionUser();
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
    "select id from ai_agents where user_id = $1 and id = $2",
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
