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
      user_id, question, status, max_turns, current_turn, token_budget, token_used,
      consensus_reached, consensus_summary, last_error_code, last_error_message,
      started_at, finished_at, stopped_reason, created_at, updated_at
    ) values ($1,$2,'pending',$3,0,$4,0,false,null,null,null,null,null,null,$5,$5)
    returning *`,
    [session.userId, data.question, data.maxTurns, data.tokenBudget ?? null, now]
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

export async function getDebateDetail(id: string) {
  const { debate } = await getDebate(id);
  const [agentRows, agentInfoRows] = await Promise.all([
    query<Record<string, unknown>>(
      "select * from debate_agents where debate_id = $1 order by turn_order asc",
      [debate.id]
    ),
    query<Record<string, unknown>>("select id, name, provider from ai_agents")
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
  const { debate } = await getDebate(id);
  const [turnRows, agentRows] = await Promise.all([
    query<Record<string, unknown>>(
      "select * from debate_turns where debate_id = $1 order by turn_number asc",
      [debate.id]
    ),
    query<Record<string, unknown>>("select id, name, provider from ai_agents")
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
