import { query } from "@/lib/db";
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

    const runningDebates = await query<{ id: string; user_id: string }>(
      `
        select id, user_id
          from debates
         where status = 'running'
         order by updated_at asc, created_at asc
      `
    );

    const recoveredIds: string[] = [];
    for (const row of runningDebates.rows) {
      const debateId = String(row.id);
      const userId = String(row.user_id);
      const recoveringAt = new Date().toISOString();
      await query(
        `update debates
            set runtime_notice_kind = $2,
                runtime_notice_message = $3,
                runtime_notice_at = $4,
                updated_at = greatest(updated_at, $4::timestamptz)
          where id = $1`,
        [
          debateId,
          "recovering",
          "检测到服务进程中断，系统正在自动恢复这场进行中的辩论",
          recoveringAt
        ]
      );
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
