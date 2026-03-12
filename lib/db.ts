import { Pool, type QueryResultRow } from "pg";

const globalPool = globalThis as typeof globalThis & {
  openDebatePool?: Pool;
};

export function getPool() {
  if (!process.env.DATABASE_URL) {
    throw new Error("Missing DATABASE_URL");
  }

  if (!globalPool.openDebatePool) {
    globalPool.openDebatePool = new Pool({
      connectionString: process.env.DATABASE_URL
    });
  }

  return globalPool.openDebatePool;
}

export async function query<T extends QueryResultRow>(sql: string, params: unknown[] = []) {
  return getPool().query<T>(sql, params);
}
