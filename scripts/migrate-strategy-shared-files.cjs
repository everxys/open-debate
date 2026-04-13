const { Client } = require("pg");
const { randomUUID } = require("crypto");

function printUsage() {
  console.log("Usage:");
  console.log("  node scripts/migrate-strategy-shared-files.cjs <strategyId>");
  console.log("");
  console.log("If no strategyId is provided, the script will list the most recently updated strategies.");
}

async function listStrategies(client) {
  const result = await client.query(
    "select id, name, updated_at from strategies order by updated_at desc limit 10"
  );
  console.log("Recent strategies:");
  for (const row of result.rows) {
    console.log(`- ${row.id} | ${row.name} | ${row.updated_at}`);
  }
}

async function migrateStrategy(client, strategyId) {
  await client.query(`
    create table if not exists strategy_shared_files (
      id uuid primary key,
      strategy_id uuid not null,
      path text not null,
      content text not null default '',
      created_at timestamptz not null,
      updated_at timestamptz not null,
      unique (strategy_id, path)
    )
  `);
  await client.query(
    "create index if not exists idx_strategy_shared_files_strategy_id_updated_at on strategy_shared_files (strategy_id, updated_at desc)"
  );
  await client.query(`
    do $$
    begin
      if not exists (
        select 1 from pg_constraint where conname = 'strategy_shared_files_strategy_id_fkey'
      ) then
        alter table strategy_shared_files
          add constraint strategy_shared_files_strategy_id_fkey
          foreign key (strategy_id) references strategies(id) on delete cascade;
      end if;
    exception when undefined_table then
      null;
    end $$;
  `);

  const duplicateRows = await client.query(
    `
    with files as (
      select r.strategy_id, f.strategy_role_id, f.path, f.content
        from strategy_role_files f
        join strategy_roles r on r.id = f.strategy_role_id
       where r.strategy_id = $1
    ),
    dupes as (
      select path, content, count(distinct strategy_role_id) as role_count
        from files
       group by path, content
      having count(distinct strategy_role_id) > 1
    )
    select path, content, role_count
      from dupes
     order by path asc
    `,
    [strategyId]
  );

  if (duplicateRows.rows.length <= 0) {
    console.log("No duplicate role files detected.");
    return;
  }

  let moved = 0;
  let skipped = 0;
  let deleted = 0;

  await client.query("begin");
  try {
    for (const row of duplicateRows.rows) {
      const path = String(row.path);
      const content = String(row.content ?? "");
      const existing = await client.query(
        "select content from strategy_shared_files where strategy_id = $1 and path = $2 limit 1",
        [strategyId, path]
      );
      if (existing.rows.length > 0) {
        const existingContent = String(existing.rows[0].content ?? "");
        if (existingContent !== content) {
          console.log(`Skip ${path}: shared file exists with different content.`);
          skipped += 1;
          continue;
        }
      } else {
        await client.query(
          `
          insert into strategy_shared_files (id, strategy_id, path, content, created_at, updated_at)
          values ($1, $2, $3, $4, now(), now())
          on conflict (strategy_id, path) do nothing
          `,
          [randomUUID(), strategyId, path, content]
        );
        moved += 1;
      }

      const deleteResult = await client.query(
        `
        delete from strategy_role_files
         where strategy_role_id in (select id from strategy_roles where strategy_id = $1)
           and path = $2
           and content = $3
        `,
        [strategyId, path, content]
      );
      deleted += Number(deleteResult.rowCount ?? 0);
    }

    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }

  console.log(`Done. Moved ${moved} shared files, deleted ${deleted} role files, skipped ${skipped}.`);
}

async function main() {
  const strategyId = process.argv[2];
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("Missing DATABASE_URL");
    process.exit(1);
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    if (!strategyId) {
      printUsage();
      await listStrategies(client);
      return;
    }

    await migrateStrategy(client, strategyId);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error("Migration failed:", error);
  process.exit(1);
});
