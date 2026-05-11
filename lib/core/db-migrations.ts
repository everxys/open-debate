import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import type { Pool } from "pg";

const MIGRATION_FILE = /^(\d{4})_([a-z0-9][a-z0-9_-]*)\.sql$/;
const MIGRATION_LOCK_KEY = 726_104_421;
const MIGRATIONS_DIR = path.join(process.cwd(), "migrations");

export type DbMigration = {
  version: string;
  name: string;
  filename: string;
  path: string;
  sql: string;
  checksum: string;
};

export type AppliedDbMigration = {
  version: string;
  name: string;
  checksum: string;
  applied_at: string;
  execution_ms: number;
};

export type DbMigrationStatus = {
  migrations: DbMigration[];
  applied: AppliedDbMigration[];
  pending: DbMigration[];
};

function checksumSql(sql: string) {
  return createHash("sha256").update(sql.replace(/\r\n/g, "\n")).digest("hex");
}

export function listDbMigrations(dir = MIGRATIONS_DIR): DbMigration[] {
  if (!existsSync(dir)) throw new Error(`Migrations directory not found: ${dir}`);

  const migrations = readdirSync(dir)
    .filter((filename) => filename.endsWith(".sql"))
    .map((filename) => {
      const match = filename.match(MIGRATION_FILE);
      if (!match) {
        throw new Error(`Invalid migration filename "${filename}". Use "0001_short_name.sql".`);
      }
      const filePath = path.join(dir, filename);
      const sql = readFileSync(filePath, "utf8");
      if (!sql.trim()) throw new Error(`Migration file is empty: ${filename}`);
      return {
        version: match[1],
        name: match[2],
        filename,
        path: filePath,
        sql,
        checksum: checksumSql(sql)
      };
    })
    .sort((a, b) => a.version.localeCompare(b.version));

  const seenVersions = new Set<string>();
  for (const migration of migrations) {
    if (seenVersions.has(migration.version)) {
      throw new Error(`Duplicate migration version ${migration.version}. Use one SQL file per version.`);
    }
    seenVersions.add(migration.version);
  }

  return migrations;
}

async function ensureMigrationTable(pool: Pool) {
  await pool.query(`
    create table if not exists schema_migrations (
      version text primary key,
      name text not null,
      checksum text not null,
      applied_at timestamptz not null default now(),
      execution_ms integer not null
    )
  `);
}

async function hasMigrationTable(pool: Pool) {
  const result = await pool.query<{ oid: string | null }>("select to_regclass('public.schema_migrations') as oid");
  return Boolean(result.rows[0]?.oid);
}

async function getAppliedMigrations(pool: Pool): Promise<AppliedDbMigration[]> {
  const result = await pool.query<AppliedDbMigration>(
    "select version, name, checksum, applied_at, execution_ms from schema_migrations order by version asc"
  );
  return result.rows;
}

function compareMigrationHistory(migrations: DbMigration[], applied: AppliedDbMigration[]) {
  const knownVersions = new Set(migrations.map((migration) => migration.version));
  for (const row of applied) {
    if (!knownVersions.has(row.version)) {
      throw new Error(`Database has unknown migration version ${row.version}. Check the migrations directory.`);
    }
  }

  const appliedByVersion = new Map(applied.map((row) => [row.version, row]));
  const pending: DbMigration[] = [];
  for (const migration of migrations) {
    const row = appliedByVersion.get(migration.version);
    if (!row) {
      pending.push(migration);
      continue;
    }
    if (row.checksum !== migration.checksum) {
      throw new Error(
        `Migration ${migration.filename} checksum changed after it was applied. Create a new migration instead of editing history.`
      );
    }
  }
  return pending;
}

export async function getMigrationStatus(pool: Pool): Promise<DbMigrationStatus> {
  const migrations = listDbMigrations();
  if (!(await hasMigrationTable(pool))) return { migrations, applied: [], pending: migrations };
  const applied = await getAppliedMigrations(pool);
  return { migrations, applied, pending: compareMigrationHistory(migrations, applied) };
}

export async function assertMigrationsApplied(pool: Pool) {
  if (!(await hasMigrationTable(pool))) {
    throw new Error("Database migrations have not been initialized. Run `npm run db:migrate` first.");
  }
  const status = await getMigrationStatus(pool);
  if (status.pending.length > 0) {
    const names = status.pending.map((migration) => migration.filename).join(", ");
    throw new Error(`Database migrations are pending: ${names}. Run \`npm run db:migrate\`.`);
  }
}

export async function runPendingMigrations(pool: Pool) {
  await pool.query("select pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
  try {
    await ensureMigrationTable(pool);
    const applied = await getAppliedMigrations(pool);
    const migrations = listDbMigrations();
    const pending = compareMigrationHistory(migrations, applied);

    for (const migration of pending) {
      const startedAt = Date.now();
      await pool.query("begin");
      try {
        await pool.query(migration.sql);
        await pool.query(
          `
            insert into schema_migrations (version, name, checksum, execution_ms)
            values ($1, $2, $3, $4)
          `,
          [migration.version, migration.name, migration.checksum, Date.now() - startedAt]
        );
        await pool.query("commit");
      } catch (error) {
        await pool.query("rollback").catch(() => null);
        throw error;
      }
    }

    return pending;
  } finally {
    await pool.query("select pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]).catch(() => null);
  }
}
