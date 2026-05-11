import { loadEnvConfig } from "@next/env";
import { Pool } from "pg";

import { getMigrationStatus, runPendingMigrations } from "../lib/db-migrations";

loadEnvConfig(process.cwd(), process.env.NODE_ENV !== "production");

async function main() {
  const command = process.argv[2] ?? "up";
  if (!process.env.DATABASE_URL) throw new Error("Missing DATABASE_URL");

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    if (command === "check") {
      const status = await getMigrationStatus(pool);
      if (status.pending.length > 0) {
        throw new Error(`Pending database migrations: ${status.pending.map((migration) => migration.filename).join(", ")}`);
      }
      console.log(`Database migrations up to date (${status.applied.length}/${status.migrations.length}).`);
      return;
    }

    if (command !== "up") throw new Error(`Unknown db migration command "${command}". Use "up" or "check".`);

    const applied = await runPendingMigrations(pool);
    if (applied.length === 0) {
      console.log("Database migrations already up to date.");
      return;
    }
    for (const migration of applied) {
      console.log(`Applied migration ${migration.filename}`);
    }
  } finally {
    await pool.end();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
