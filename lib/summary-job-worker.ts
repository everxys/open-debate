import { randomUUID } from "crypto";

import { sql } from "kysely";

import { ensureDb } from "@/lib/db";
import { logRuntimeEvent, runSummaryJobByRecord } from "@/lib/runtime-main";
import { claimRunnableDebateSummaryJobs, recoverStaleDebateSummaryJobs } from "@/lib/summary-jobs";

const workerGlobal = globalThis as typeof globalThis & {
  openDebateSummaryWorkerPromise?: Promise<void>;
  openDebateSummaryWorkerTimer?: ReturnType<typeof setTimeout> | null;
};

async function tickSummaryJobWorker(reason: string) {
  try {
    const recovered = await recoverStaleDebateSummaryJobs();
    if (recovered.length > 0) {
      await logRuntimeEvent("warn", "summary worker recovered stale jobs", {
        reason,
        recovered: recovered.map((job) => ({ debateId: job.debateId, jobKey: job.jobKey }))
      });
    }

    const claimed = await claimRunnableDebateSummaryJobs({
      workerId: `summary-worker:${process.pid}:${randomUUID()}`,
      limit: 4,
      maxConcurrentPerDebate: 1
    });
    for (const job of claimed) {
      // eslint-disable-next-line no-await-in-loop
      await runSummaryJobByRecord(job);
    }
  } catch (error) {
    console.error("summary job worker tick failed", error);
  } finally {
    workerGlobal.openDebateSummaryWorkerTimer = setTimeout(() => {
      void tickSummaryJobWorker(reason);
    }, 4_000);
    workerGlobal.openDebateSummaryWorkerTimer.unref?.();
  }
}

export function ensureSummaryJobWorkerStarted(reason = "server_boot") {
  if (typeof window !== "undefined") return Promise.resolve();
  if (workerGlobal.openDebateSummaryWorkerPromise) {
    return workerGlobal.openDebateSummaryWorkerPromise;
  }

  workerGlobal.openDebateSummaryWorkerPromise = (async () => {
    const db = await ensureDb();
    await db.executeQuery(sql`select 1`.compile(db));
    void tickSummaryJobWorker(reason);
  })().catch((error) => {
    workerGlobal.openDebateSummaryWorkerPromise = undefined;
    throw error;
  });

  return workerGlobal.openDebateSummaryWorkerPromise;
}
