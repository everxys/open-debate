import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { listDbMigrations } from "@/lib/db-migrations";

test("listDbMigrations reads SQL migrations in version order", () => {
  const migrations = listDbMigrations();

  assert.equal(migrations[0].filename, "0001_baseline_schema.sql");
  assert.equal(migrations[1].filename, "0002_legacy_schema_cleanup.sql");
  assert.equal(migrations[2].filename, "0003_resume_job_attempt_count.sql");
  assert.deepEqual(
    migrations.map((migration) => migration.version),
    [...migrations.map((migration) => migration.version)].sort()
  );
  for (const migration of migrations) {
    assert.match(migration.checksum, /^[a-f0-9]{64}$/);
  }
});

test("real migrations cover schema moved out of startup repair", () => {
  const migrations = listDbMigrations();
  const baseline = migrations[0].sql;
  const cleanup = migrations[1].sql;
  const resumeAttemptCount = migrations.find(
    (migration) => migration.filename === "0003_resume_job_attempt_count.sql"
  )?.sql;

  assert.match(baseline, /create table if not exists users/);
  assert.match(baseline, /create table if not exists strategy_shared_files/);
  assert.match(baseline, /create table if not exists strategy_file_access_rules/);
  assert.match(baseline, /alter table debates add column if not exists auto_recover_once_on_failed/);
  assert.match(baseline, /alter table ai_agents add column if not exists deleted_at/);
  assert.match(cleanup, /insert into debate_file_versions/);
  assert.match(cleanup, /debate_context_chunks_debate_id_fkey/);
  assert.match(resumeAttemptCount ?? "", /alter table debate_resume_jobs/);
  assert.match(resumeAttemptCount ?? "", /attempt_count integer not null default 0/);
});

test("listDbMigrations rejects invalid filenames and empty files", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "open-debate-migrations-"));
  try {
    writeFileSync(path.join(dir, "001_bad.sql"), "select 1;\n");
    assert.throws(() => listDbMigrations(dir), /Invalid migration filename/);

    rmSync(path.join(dir, "001_bad.sql"));
    writeFileSync(path.join(dir, "0001_empty.sql"), "");
    assert.throws(() => listDbMigrations(dir), /Migration file is empty/);

    rmSync(path.join(dir, "0001_empty.sql"));
    writeFileSync(path.join(dir, "0001_first.sql"), "select 1;\n");
    writeFileSync(path.join(dir, "0001_second.sql"), "select 2;\n");
    assert.throws(() => listDbMigrations(dir), /Duplicate migration version 0001/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runtime db bootstrap only checks applied migrations", () => {
  const dbSource = readFileSync(path.join(process.cwd(), "lib", "core", "db.ts"), "utf8");

  assert.match(dbSource, /assertMigrationsApplied/);
  assert.doesNotMatch(dbSource, /ensureSchema/);
  assert.doesNotMatch(dbSource, /ensureDebateAutoRecoverColumns/);
  assert.doesNotMatch(dbSource, /alter table/i);
  assert.doesNotMatch(dbSource, /create table/i);
});
