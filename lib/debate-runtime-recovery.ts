import { sql } from "kysely";

import { ensureDb } from "@/lib/db";
import { runDebate } from "@/lib/runtime";
import { appendServerLog } from "@/lib/server-log";

const recoveryGlobal = globalThis as typeof globalThis & {
  openDebateRuntimeRecoveryPromise?: Promise<void>;
};

function toErrorMeta(error: unknown) {
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack ?? null };
  }
  return { message: String(error) };
}

export function ensureDebateRuntimeRecoveryStarted(reason = "server_boot") {
  if (typeof window !== "undefined") {
    return Promise.resolve();
  }
  if (recoveryGlobal.openDebateRuntimeRecoveryPromise) {
    return recoveryGlobal.openDebateRuntimeRecoveryPromise;
  }

  recoveryGlobal.openDebateRuntimeRecoveryPromise = (async () => {
    await appendServerLog("info", "debate runtime recovery started", { reason });

    const db = await ensureDb();
    const runningDebates = await db
      .selectFrom("debates")
      .select(["id", "user_id"])
      .where("status", "=", "running")
      .orderBy("updated_at", "asc")
      .orderBy("created_at", "asc")
      .execute();

    const recoveredIds: string[] = [];
    for (const row of runningDebates) {
      const debateId = String(row.id);
      const userId = String(row.user_id);
      const recoveringAt = new Date().toISOString();
      await db
        .updateTable("debates")
        .set({
          runtime_notice_kind: "recovering",
          runtime_notice_message: "检测到服务进程中断，系统正在自动恢复这场进行中的辩论",
          runtime_notice_at: recoveringAt,
          updated_at: sql`greatest(updated_at, ${recoveringAt}::timestamptz)`
        })
        .where("id", "=", debateId)
        .execute();
      recoveredIds.push(debateId);
      void runDebate(debateId, userId);
    }

    await appendServerLog("info", "debate runtime recovery finished", {
      reason,
      recoveredCount: recoveredIds.length,
      recoveredDebateIds: recoveredIds
    });
  })().catch(async (error) => {
    recoveryGlobal.openDebateRuntimeRecoveryPromise = undefined;
    try {
      await appendServerLog("error", "debate runtime recovery failed", {
        reason,
        error: toErrorMeta(error)
      });
    } catch {
      // ignore secondary logging failure
    }
    throw error;
  });

  return recoveryGlobal.openDebateRuntimeRecoveryPromise;
}
