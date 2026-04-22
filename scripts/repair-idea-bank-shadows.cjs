const { loadEnvConfig } = require("@next/env");
const { Client } = require("pg");

loadEnvConfig(process.cwd());

const PATH_PAIRS = [
  ["outputs/selected-s-tier.md", "debate/ideas/selected-s-tier.md"],
  ["outputs/selected-a-tier.md", "debate/ideas/selected-a-tier.md"],
  ["outputs/rejected-or-merged.md", "debate/ideas/rejected-or-merged.md"],
  ["outputs/event-mappings.md", "debate/ideas/event-mappings.md"],
  ["outputs/newly-invented-ideas.md", "debate/ideas/newly-invented-ideas.md"]
];

function hasApplyFlag() {
  return process.argv.includes("--apply");
}

function isPlaceholder(content) {
  const text = String(content ?? "").trim();
  if (!text) return true;
  if (text.length > 400) return false;
  return /待筛选|待填写|建议结构/.test(text);
}

async function findShadowCandidates(client) {
  const result = await client.query(
    `
    select s.debate_id,
           s.path as source_path,
           s.content as source_content,
           s.version as source_version,
           s.updated_at as source_updated_at,
           t.path as target_path,
           t.content as target_content,
           t.version as target_version,
           t.updated_at as target_updated_at
      from debate_files s
      join (values ${PATH_PAIRS.map((_, index) => `($${index * 2 + 1}::text, $${index * 2 + 2}::text)`).join(", ")}) as p(source_path, target_path)
        on p.source_path = s.path
      left join debate_files t
        on t.debate_id = s.debate_id
       and t.path = p.target_path
     where char_length(s.content) > 400
     order by s.updated_at desc, s.debate_id asc, s.path asc
    `,
    PATH_PAIRS.flat()
  );
  return result.rows.filter((row) => isPlaceholder(row.target_content));
}

async function migrateCandidate(client, row, now) {
  const archivePath = `context/repair/idea-bank-shadow-${now.replace(/[:.]/g, "-")}.json`;
  const archive = {
    repairedAt: now,
    debateId: row.debate_id,
    sourcePath: row.source_path,
    sourceVersion: row.source_version,
    sourceUpdatedAt: row.source_updated_at,
    targetPath: row.target_path,
    targetVersion: row.target_version,
    targetUpdatedAt: row.target_updated_at,
    previousTargetContent: row.target_content ?? null
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
    [row.debate_id, archivePath, JSON.stringify(archive, null, 2), now]
  );

  await client.query(
    `
    insert into debate_files (debate_id, path, content, version, created_at, updated_at)
    values ($1, $2, $3, 1, $4, $4)
    on conflict (debate_id, path)
    do update
       set content = excluded.content,
           version = debate_files.version + 1,
           updated_at = excluded.updated_at
    `,
    [row.debate_id, row.target_path, row.source_content, now]
  );
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("Missing DATABASE_URL");

  const apply = hasApplyFlag();
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const candidates = await findShadowCandidates(client);
    if (candidates.length === 0) {
      console.log("No idea-bank shadow files need migration.");
      return;
    }

    console.log(`Found ${candidates.length} idea-bank shadow migration candidate(s):`);
    for (const row of candidates) {
      console.log(`- debate=${row.debate_id} ${row.source_path} -> ${row.target_path}`);
    }

    if (!apply) {
      console.log("");
      console.log("Dry-run only. Re-run with --apply to copy shadow content into source-of-truth debate/ideas files.");
      return;
    }

    const now = new Date().toISOString();
    await client.query("begin");
    try {
      for (const row of candidates) {
        await migrateCandidate(client, row, now);
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
    console.log(`Migrated ${candidates.length} file(s). Previous target placeholders archived under context/repair/*.json.`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
