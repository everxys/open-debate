const { randomUUID } = require("crypto");
const { loadEnvConfig } = require("@next/env");
const { Client } = require("pg");

loadEnvConfig(process.cwd());

function hasApplyFlag() {
  return process.argv.includes("--apply");
}

function printUsage() {
  console.log("Usage:");
  console.log("  node scripts/repair-duplicate-debate-turns.cjs");
  console.log("  node scripts/repair-duplicate-debate-turns.cjs --apply");
  console.log("");
  console.log("Default mode is dry-run. --apply archives later duplicate rows to debate_files before deleting them.");
}

async function listDuplicateGroups(client) {
  const result = await client.query(`
    select debate_id, turn_number, count(*)::int as row_count
      from debate_turns
     group by debate_id, turn_number
    having count(*) > 1
     order by max(created_at) desc, debate_id asc, turn_number asc
  `);
  return result.rows;
}

async function archiveAndDeleteDuplicateRows(client, group, now) {
  const rowsResult = await client.query(
    `
    select *
      from debate_turns
     where debate_id = $1
       and turn_number = $2
     order by created_at asc, id asc
    `,
    [group.debate_id, group.turn_number]
  );
  const rows = rowsResult.rows;
  const keep = rows[0];
  const duplicates = rows.slice(1);
  if (!keep || duplicates.length === 0) return 0;

  const archivePath = `context/repair/duplicate-turns-${now.replace(/[:.]/g, "-")}.json`;
  const archive = {
    repairedAt: now,
    debateId: group.debate_id,
    turnNumber: Number(group.turn_number),
    keptTurnId: keep.id,
    deletedTurnIds: duplicates.map((row) => row.id),
    deletedRows: duplicates
  };

  await client.query(
    `
    insert into debate_files (debate_id, path, content, version, created_at, updated_at)
    values ($1, $2, $3, 1, $4, $4)
    on conflict (debate_id, path)
    do update
       set content = debate_files.content || E'\n\n' || excluded.content,
           version = debate_files.version + 1,
           updated_at = excluded.updated_at
    `,
    [group.debate_id, archivePath, JSON.stringify(archive, null, 2), now]
  );

  await client.query(
    "delete from debate_turns where id = any($1::uuid[])",
    [duplicates.map((row) => row.id)]
  );
  return duplicates.length;
}

async function createUniqueIndex(client) {
  await client.query(
    "create unique index if not exists idx_debate_turns_debate_id_turn_number_unique on debate_turns(debate_id, turn_number)"
  );
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printUsage();
    return;
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("Missing DATABASE_URL");
  }

  const apply = hasApplyFlag();
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const groups = await listDuplicateGroups(client);
    if (groups.length === 0) {
      console.log("No duplicate debate_turns rows found.");
      await createUniqueIndex(client);
      console.log("Unique index ensured: debate_turns(debate_id, turn_number).");
      return;
    }

    console.log(`Found ${groups.length} duplicate debate_turns group(s):`);
    for (const group of groups) {
      console.log(`- debate=${group.debate_id} turn=${group.turn_number} rows=${group.row_count}`);
    }

    if (!apply) {
      console.log("");
      console.log("Dry-run only. Re-run with --apply to archive and delete later duplicate rows.");
      return;
    }

    const now = new Date().toISOString();
    let deleted = 0;
    await client.query("begin");
    try {
      for (const group of groups) {
        deleted += await archiveAndDeleteDuplicateRows(client, group, now);
      }
      await createUniqueIndex(client);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    }

    console.log(`Deleted ${deleted} duplicate row(s). Archived deleted rows under context/repair/*.json.`);
    console.log("Unique index ensured: debate_turns(debate_id, turn_number).");
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
