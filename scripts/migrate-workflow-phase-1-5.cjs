const { Pool } = require("pg");

const LEGACY_ELECTION_PHASE_ID = "phase-2";
const LEGACY_ELECTION_PHASE_TITLE = "Phase 2 · 民主选举";
const CANONICAL_ELECTION_PHASE_ID = "phase-1-5";
const CANONICAL_ELECTION_PHASE_TITLE = "Phase 1.5 · 主持人与监管者选举";
const CANONICAL_ELECTION_PHASE_DESCRIPTION =
  "用一整轮完成主持人与监管者选举；如果本轮未选出结果，则先回到 Phase 1 补充一轮全员发言，再重新进入本阶段。";
const CANONICAL_ELECTION_PHASE_PROMPT =
  "【Phase 1.5】当前是主持人与监管者的正式选举轮。你必须基于前面 Phase 1 已经出现的表现来判断谁适合做主持人、谁适合做监管者，并把判断依据讲清楚。禁止借投票继续推进新设定、新主线或新事件。若本轮无法形成明确结果，下一轮会先回到 Phase 1 继续补充一轮全员发言，然后系统再发起下一次 Phase 1.5 选举。";

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeElectionPrompt(input) {
  if (typeof input !== "string" || !input.trim()) {
    return CANONICAL_ELECTION_PHASE_PROMPT;
  }
  let next = input;
  next = next.replace(/【Phase 2 强化版】/g, "【Phase 1.5 强化版】");
  next = next.replace(/【Phase 2】/g, "【Phase 1.5】");
  next = next.replace(/Phase 2/g, "Phase 1.5");
  if (next === input && !next.includes("Phase 1.5")) {
    return CANONICAL_ELECTION_PHASE_PROMPT;
  }
  return next;
}

function upgradeWorkflowConfig(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { changed: false, workflow: input };
  }

  const workflow = cloneJson(input);
  let changed = false;

  const phaseMachine =
    workflow.phaseMachine && typeof workflow.phaseMachine === "object" ? workflow.phaseMachine : null;
  const phases = Array.isArray(phaseMachine?.phases) ? phaseMachine.phases : null;
  if (phases) {
    for (const phase of phases) {
      if (!phase || typeof phase !== "object") continue;
      if (phase.kind !== "election") continue;

      if (phase.id === LEGACY_ELECTION_PHASE_ID || phase.title === LEGACY_ELECTION_PHASE_TITLE) {
        if (phase.id !== CANONICAL_ELECTION_PHASE_ID) {
          phase.id = CANONICAL_ELECTION_PHASE_ID;
          changed = true;
        }
        if (phase.title !== CANONICAL_ELECTION_PHASE_TITLE) {
          phase.title = CANONICAL_ELECTION_PHASE_TITLE;
          changed = true;
        }
      }

      if (
        phase.description === "用一整轮完成主持人与监管者选举，不夹带额外发言，形成明确任命结果。" ||
        (typeof phase.description !== "string" || !phase.description.trim())
      ) {
        if (phase.description !== CANONICAL_ELECTION_PHASE_DESCRIPTION) {
          phase.description = CANONICAL_ELECTION_PHASE_DESCRIPTION;
          changed = true;
        }
      }

      const normalizedPrompt = normalizeElectionPrompt(phase.injectedPrompt);
      if (normalizedPrompt !== phase.injectedPrompt) {
        phase.injectedPrompt = normalizedPrompt;
        changed = true;
      }
    }
  }

  if (!workflow.phaseMachine || typeof workflow.phaseMachine !== "object") {
    workflow.phaseMachine = {};
    changed = true;
  }
  if (!workflow.phaseMachine.transitionRules || typeof workflow.phaseMachine.transitionRules !== "object") {
    workflow.phaseMachine.transitionRules = {};
    changed = true;
  }
  if (
    !workflow.phaseMachine.transitionRules.election ||
    typeof workflow.phaseMachine.transitionRules.election !== "object"
  ) {
    workflow.phaseMachine.transitionRules.election = {};
    changed = true;
  }
  const electionRules = workflow.phaseMachine.transitionRules.election;
  if (electionRules.reopenUntilPassed !== true) {
    electionRules.reopenUntilPassed = true;
    changed = true;
  }
  if (
    typeof electionRules.discussionRoundsBetweenVotes !== "number" ||
    !Number.isFinite(electionRules.discussionRoundsBetweenVotes) ||
    electionRules.discussionRoundsBetweenVotes < 1
  ) {
    electionRules.discussionRoundsBetweenVotes = 1;
    changed = true;
  }

  return { changed, workflow };
}

async function migrateTable(client, input) {
  const result = await client.query(input.selectSql);
  let scanned = 0;
  let updated = 0;

  for (const row of result.rows) {
    scanned += 1;
    const raw = typeof row.content === "string" ? row.content.trim() : "";
    if (!raw) continue;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const { changed, workflow } = upgradeWorkflowConfig(parsed);
    if (!changed) continue;
    await client.query(input.updateSql, [JSON.stringify(workflow, null, 2), row.id]);
    updated += 1;
  }

  return { scanned, updated };
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("Missing DATABASE_URL");
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query("begin");

    const debateFiles = await migrateTable(client, {
      selectSql: "select id, content from debate_files where path = 'workflow.json'",
      updateSql: "update debate_files set content = $1, updated_at = now() where id = $2"
    });

    const strategyFiles = await migrateTable(client, {
      selectSql: "select id, content from strategy_role_files where path = 'debate/workflow.json'",
      updateSql: "update strategy_role_files set content = $1, updated_at = now() where id = $2"
    });

    await client.query("commit");

    console.log(
      JSON.stringify(
        {
          ok: true,
          debateFiles,
          strategyFiles
        },
        null,
        2
      )
    );
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {}
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : null
      },
      null,
      2
    )
  );
  process.exitCode = 1;
});
