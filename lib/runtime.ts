import { randomInt, randomUUID } from "node:crypto";

import { decryptSecret } from "@/lib/crypto";
import { query } from "@/lib/db";
import { AppError } from "@/lib/http";
import type { AgentRecord, DebateRecord, DebateTurnRecord, StructuredOutput } from "@/lib/types";

const activeDebates = new Set<string>();

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function aggregateConsensus(turns: DebateTurnRecord[]) {
  const bySolution = new Map<
    string,
    { support: number; rebuttal: number; agreement: number[] }
  >();

  for (const turn of turns) {
    const output = turn.structuredOutput;
    if (!output?.proposed_solution) {
      continue;
    }

    const bucket = bySolution.get(output.proposed_solution) ?? {
      support: 0,
      rebuttal: 0,
      agreement: []
    };

    for (const argument of output.arguments ?? []) {
      if (argument.type === "support") {
        bucket.support += 1;
      } else {
        bucket.rebuttal += 1;
      }
    }

    if (typeof output.agreement_score === "number") {
      bucket.agreement.push(output.agreement_score);
    }

    bySolution.set(output.proposed_solution, bucket);
  }

  let leadingSolution: string | null = null;
  let leadingScore = 0;

  for (const [name, bucket] of bySolution.entries()) {
    const agreement =
      bucket.agreement.length > 0
        ? bucket.agreement.reduce((sum, item) => sum + item, 0) / bucket.agreement.length / 10
        : 0.5;
    const normalizedBase = Math.max(
      0,
      Math.min(1, 0.5 + (bucket.support - bucket.rebuttal) * 0.1)
    );
    const score = Number((normalizedBase * 0.6 + agreement * 0.4).toFixed(3));
    if (score > leadingScore) {
      leadingScore = score;
      leadingSolution = name;
    }
  }

  return {
    reached: Boolean(leadingSolution && leadingScore >= 0.7),
    leadingSolution,
    score: leadingScore
  };
}

function parseResponse(raw: string) {
  try {
    const parsed = JSON.parse(raw) as StructuredOutput;
    return {
      content: raw,
      structuredOutput: parsed,
      parseStatus: "ok" as const
    };
  } catch {
    return {
      content: raw,
      structuredOutput: null,
      parseStatus: "fallback" as const
    };
  }
}

function buildDemoResponse(debate: DebateRecord, agent: AgentRecord, turnNumber: number) {
  const solution = turnNumber % 2 === 0 ? "方案 A" : "方案 B";
  const argumentType = turnNumber % 3 === 0 ? "rebuttal" : "support";
  return JSON.stringify({
    proposed_solution: solution,
    arguments: [
      {
        type: argumentType,
        content:
          argumentType === "support"
            ? `${agent.name} 认为 ${solution} 在问题“${debate.question.slice(0, 20)}”上更可执行。`
            : `${agent.name} 认为对立方案在成本与风险上仍然存在漏洞。`
      }
    ],
    agreement_score: randomInt(6, 10)
  });
}

function resolveChatUrl(agent: AgentRecord) {
  const normalized = agent.baseUrl.replace(/\/+$/, "");
  return agent.provider === "openai"
    ? `${normalized}/chat/completions`
    : `${normalized}/messages`;
}

async function callProvider(debate: DebateRecord, agent: AgentRecord, turnNumber: number) {
  const apiKey = decryptSecret(agent.apiKeyEncrypted);
  const prompt = `Question: ${debate.question}\nTurn: ${turnNumber}\nRespond in JSON with proposed_solution, arguments, agreement_score.`;
  const url = resolveChatUrl(agent);

  if (process.env.NODE_ENV !== "production" && apiKey.startsWith("demo-")) {
    return buildDemoResponse(debate, agent, turnNumber);
  }

  if (agent.provider === "openai") {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: agent.model,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: agent.systemPrompt ?? "You are a rigorous debate participant."
          },
          { role: "user", content: prompt }
        ]
      })
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new AppError("AI_API_ERROR", 502, JSON.stringify(payload).slice(0, 200));
    }
    return payload.choices?.[0]?.message?.content ?? buildDemoResponse(debate, agent, turnNumber);
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: agent.model,
      max_tokens: 512,
      system: agent.systemPrompt ?? "You are a rigorous debate participant.",
      messages: [{ role: "user", content: prompt }]
    })
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new AppError("AI_API_ERROR", 502, JSON.stringify(payload).slice(0, 200));
  }
  return payload.content?.[0]?.text ?? buildDemoResponse(debate, agent, turnNumber);
}

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

function normalizeAgentRow(row: Record<string, unknown>): AgentRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    name: String(row.name),
    provider: row.provider as AgentRecord["provider"],
    model: String(row.model),
    baseUrl: String(row.base_url),
    apiKeyEncrypted: String(row.api_key_encrypted),
    apiKeyMasked: String(row.api_key_masked),
    systemPrompt: (row.system_prompt as string | null) ?? null,
    isActive: Boolean(row.is_active),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

async function finishDebate(id: string, status: "completed" | "stopped" | "failed", reason?: string) {
  await query(
    `update debates
        set status = $2,
            finished_at = $3,
            stopped_reason = $4,
            updated_at = $3
      where id = $1`,
    [id, status, new Date().toISOString(), reason ?? null]
  );
}

export async function runDebate(id: string, userId: string) {
  if (activeDebates.has(id)) {
    return;
  }

  activeDebates.add(id);

  try {
    while (true) {
      const debateResult = await query<Record<string, unknown>>(
        "select * from debates where id = $1 and user_id = $2",
        [id, userId]
      );
      if ((debateResult.rowCount ?? 0) !== 1) {
        break;
      }

      const debate = normalizeDebateRow(debateResult.rows[0]);
      if (debate.status !== "running") {
        break;
      }
      if (debate.currentTurn >= debate.maxTurns) {
        await finishDebate(id, "completed");
        break;
      }
      if (debate.tokenBudget && debate.tokenUsed >= debate.tokenBudget) {
        await finishDebate(id, "stopped", "token budget reached");
        break;
      }

      const participantRows = await query<Record<string, unknown>>(
        "select * from debate_agents where debate_id = $1 order by turn_order asc",
        [id]
      );
      if ((participantRows.rowCount ?? 0) < 2) {
        throw new AppError("VALIDATION_ERROR", 400, "Debate requires at least 2 agents");
      }

      const currentIndex = debate.currentTurn % participantRows.rows.length;
      const currentParticipant = participantRows.rows[currentIndex];
      const agentResult = await query<Record<string, unknown>>(
        "select * from ai_agents where id = $1",
        [String(currentParticipant.ai_agent_id)]
      );
      if ((agentResult.rowCount ?? 0) !== 1) {
        throw new AppError("NOT_FOUND", 404, "Agent not found for debate");
      }

      const agent = normalizeAgentRow(agentResult.rows[0]);
      const startedAt = Date.now();
      let raw = "";
      let retryCount = 0;

      while (retryCount <= 2) {
        try {
          raw = await callProvider(debate, agent, debate.currentTurn + 1);
          break;
        } catch (error) {
          retryCount += 1;
          if (retryCount > 2) {
            throw error;
          }
          await sleep(500);
        }
      }

      const parsed = parseResponse(raw);
      const tokenUsed = Math.max(80, Math.ceil(raw.length / 3));
      const responseTimeMs = Date.now() - startedAt;
      const createdAt = new Date().toISOString();

      await query(
        `insert into debate_turns (
          id, debate_id, ai_agent_id, turn_number, content, structured_output,
          parse_status, token_used, response_time_ms, retry_count, error_code, created_at
        ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          randomUUID(),
          id,
          String(currentParticipant.ai_agent_id),
          debate.currentTurn + 1,
          parsed.content,
          parsed.structuredOutput ? JSON.stringify(parsed.structuredOutput) : null,
          parsed.parseStatus,
          tokenUsed,
          responseTimeMs,
          retryCount,
          null,
          createdAt
        ]
      );

      await query("update debate_agents set turn_count = turn_count + 1 where id = $1", [
        String(currentParticipant.id)
      ]);

      const turnRows = await query<Record<string, unknown>>(
        "select * from debate_turns where debate_id = $1 order by turn_number asc",
        [id]
      );
      const turns: DebateTurnRecord[] = turnRows.rows.map((row) => ({
        id: String(row.id),
        debateId: String(row.debate_id),
        aiAgentId: String(row.ai_agent_id),
        turnNumber: Number(row.turn_number),
        content: String(row.content),
        structuredOutput: (row.structured_output as StructuredOutput | null) ?? null,
        parseStatus: row.parse_status as "ok" | "fallback",
        tokenUsed: Number(row.token_used),
        responseTimeMs: row.response_time_ms === null ? null : Number(row.response_time_ms),
        retryCount: Number(row.retry_count),
        errorCode: (row.error_code as string | null) ?? null,
        createdAt: String(row.created_at)
      }));

      const consensus = aggregateConsensus(turns);
      await query(
        `update debates
            set current_turn = $2,
                token_used = $3,
                consensus_summary = $4,
                consensus_reached = $5,
                status = $6,
                finished_at = $7,
                updated_at = $7
          where id = $1`,
        [
          id,
          debate.currentTurn + 1,
          debate.tokenUsed + tokenUsed,
          consensus.leadingSolution
            ? JSON.stringify({
                leadingSolution: consensus.leadingSolution,
                score: consensus.score
              })
            : null,
          consensus.reached,
          consensus.reached ? "completed" : debate.status,
          createdAt
        ]
      );

      await sleep(1000);
    }
  } catch (error) {
    console.error(error);
    await finishDebate(id, "failed", "runtime error");
  } finally {
    activeDebates.delete(id);
  }
}
