import { randomUUID } from "crypto";
import type { PoolClient } from "pg";

import { sql } from "kysely";

import { ensureDb, getPool } from "@/lib/db";
import { logRuntimeEvent, runSummaryJobByRecord } from "@/lib/runtime-main";
import {
  claimRunnableDebateSummaryJobs,
  coalesceActiveFactsBoardJobs,
  heartbeatRunningSummaryJobLock,
  markSummaryWorkerStopped,
  recoverStaleDebateSummaryJobs,
  SUMMARY_JOB_LEASE_HEARTBEAT_MS,
  SUMMARY_WORKER_NOTIFY_CHANNEL,
  upsertSummaryWorkerHeartbeat,
  type DebateSummaryJobRecord
} from "@/lib/summary-jobs";

type SummaryWorkerMode = "embedded" | "standalone";
type SummaryWorkerTickInput = {
  reason: string;
  workerId: string;
  mode: SummaryWorkerMode;
  unrefTimer: boolean;
  reschedule: boolean;
};

const workerGlobal = globalThis as typeof globalThis & {
  openDebateSummaryWorkerPromise?: Promise<{ workerId: string }>;
  openDebateSummaryWorkerTimer?: ReturnType<typeof setTimeout> | null;
  openDebateSummaryWorkerFailureCount?: number;
  openDebateSummaryWorkerStopped?: boolean;
  openDebateSummaryWorkerId?: string;
  openDebateSummaryWorkerMode?: SummaryWorkerMode;
  openDebateSummaryWorkerTickRunning?: boolean;
  openDebateSummaryWorkerWakeRequested?: boolean;
  openDebateSummaryWorkerWakeClient?: PoolClient | null;
  openDebateSummaryWorkerWakeListenerPromise?: Promise<void>;
};

function flattenErrorCodes(error: unknown, into: Set<string>) {
  if (!error) return;
  if (error instanceof AggregateError) {
    for (const item of error.errors) flattenErrorCodes(item, into);
    return;
  }
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code.trim()) into.add(code.trim());
    const cause = (error as { cause?: unknown }).cause;
    if (cause) flattenErrorCodes(cause, into);
  }
}

async function logRecoveredSummaryJobs(reason: string, recovered: Awaited<ReturnType<typeof recoverStaleDebateSummaryJobs>>) {
  if (recovered.length <= 0) return;
  await logRuntimeEvent("warn", "summary worker recovered stale jobs", {
    reason,
    recovered: recovered.map((item) => ({
      debateId: item.job.debateId,
      jobId: item.job.id,
      jobKey: item.job.jobKey,
      lockedBy: item.lockedBy,
      lockedAt: item.lockedAt,
      workerStatus: item.workerStatus,
      workerHeartbeatAgeMs: item.workerHeartbeatAgeMs,
      recoveredBecause: item.recoveredBecause
    }))
  });
}

function isDatabaseConnectionError(error: unknown) {
  const codes = new Set<string>();
  flattenErrorCodes(error, codes);
  return (
    codes.has("ECONNREFUSED") ||
    codes.has("57P01") ||
    codes.has("57P02") ||
    codes.has("57P03") ||
    codes.has("08001") ||
    codes.has("08006")
  );
}

function getNextTickDelay(error: unknown) {
  if (!isDatabaseConnectionError(error)) return 4_000;
  const failures = Math.max(1, (workerGlobal.openDebateSummaryWorkerFailureCount ?? 0) + 1);
  workerGlobal.openDebateSummaryWorkerFailureCount = failures;
  return Math.min(30_000, 4_000 * failures);
}

function isFailedJobResult(job: DebateSummaryJobRecord) {
  return job.status === "failed" || job.status === "dead_letter" || job.status === "retry_wait" || job.status === "blocked";
}

function scheduleSummaryWorkerTick(input: SummaryWorkerTickInput, delayMs: number) {
  if (workerGlobal.openDebateSummaryWorkerStopped) return;
  if (!input.reschedule) return;
  if (workerGlobal.openDebateSummaryWorkerTimer) {
    clearTimeout(workerGlobal.openDebateSummaryWorkerTimer);
    workerGlobal.openDebateSummaryWorkerTimer = null;
  }
  workerGlobal.openDebateSummaryWorkerTimer = setTimeout(() => {
    workerGlobal.openDebateSummaryWorkerTimer = null;
    void tickSummaryJobWorker(input);
  }, delayMs);
  if (input.unrefTimer) workerGlobal.openDebateSummaryWorkerTimer.unref?.();
}

async function runJobWithLeaseHeartbeat(input: SummaryWorkerTickInput, job: DebateSummaryJobRecord) {
  const heartbeat = setInterval(() => {
    void (async () => {
      const lockStillOwned = await heartbeatRunningSummaryJobLock({ jobId: job.id, workerId: input.workerId });
      await upsertSummaryWorkerHeartbeat({
        workerId: input.workerId,
        mode: input.mode,
        status: "running",
        currentJob: job
      });
      if (!lockStillOwned) {
        await logRuntimeEvent("warn", "summary worker lost job lease heartbeat", {
          debateId: job.debateId,
          jobKey: job.jobKey,
          workerId: input.workerId
        });
      }
    })().catch((error) => {
      if (isDatabaseConnectionError(error)) return;
      console.warn("summary job lease heartbeat failed", {
        debateId: job.debateId,
        jobKey: job.jobKey
      });
    });
  }, SUMMARY_JOB_LEASE_HEARTBEAT_MS);
  if (input.unrefTimer) heartbeat.unref?.();

  try {
    return await runSummaryJobByRecord(job);
  } finally {
    clearInterval(heartbeat);
  }
}

async function startSummaryWorkerWakeListener(input: SummaryWorkerTickInput) {
  if (workerGlobal.openDebateSummaryWorkerWakeListenerPromise) return workerGlobal.openDebateSummaryWorkerWakeListenerPromise;

  workerGlobal.openDebateSummaryWorkerWakeListenerPromise = (async () => {
    const client = await getPool().connect();
    workerGlobal.openDebateSummaryWorkerWakeClient = client;

    client.on("notification", (message) => {
      if (message.channel !== SUMMARY_WORKER_NOTIFY_CHANNEL) return;
      if (workerGlobal.openDebateSummaryWorkerTickRunning) {
        workerGlobal.openDebateSummaryWorkerWakeRequested = true;
        return;
      }
      scheduleSummaryWorkerTick(input, 0);
    });
    client.on("error", (error) => {
      workerGlobal.openDebateSummaryWorkerWakeClient = null;
      workerGlobal.openDebateSummaryWorkerWakeListenerPromise = undefined;
      if (workerGlobal.openDebateSummaryWorkerStopped) return;
      console.warn("summary worker wake listener lost database connection", error);
      setTimeout(() => {
        void startSummaryWorkerWakeListener(input).catch(() => null);
      }, 5_000).unref?.();
    });

    await client.query(`listen ${SUMMARY_WORKER_NOTIFY_CHANNEL}`);
  })().catch((error) => {
    workerGlobal.openDebateSummaryWorkerWakeClient = null;
    workerGlobal.openDebateSummaryWorkerWakeListenerPromise = undefined;
    throw error;
  });

  return workerGlobal.openDebateSummaryWorkerWakeListenerPromise;
}

async function tickSummaryJobWorker(input: SummaryWorkerTickInput) {
  if (workerGlobal.openDebateSummaryWorkerTickRunning) {
    workerGlobal.openDebateSummaryWorkerWakeRequested = true;
    return;
  }
  workerGlobal.openDebateSummaryWorkerTickRunning = true;
  let nextDelayMs = 4_000;
  try {
    await upsertSummaryWorkerHeartbeat({ workerId: input.workerId, mode: input.mode, status: "idle", currentJob: null });
    const coalesced = await coalesceActiveFactsBoardJobs();
    if (coalesced.removed > 0) {
      await logRuntimeEvent("warn", "summary worker coalesced facts board jobs", {
        reason: input.reason,
        debates: coalesced.debates,
        removed: coalesced.removed
      });
    }

    const recovered = await recoverStaleDebateSummaryJobs();
    workerGlobal.openDebateSummaryWorkerFailureCount = 0;
    await logRecoveredSummaryJobs(input.reason, recovered);

    const claimed = await claimRunnableDebateSummaryJobs({
      workerId: input.workerId,
      limit: 1,
      maxConcurrentPerDebate: 1
    });
    if (claimed.length > 0) {
      nextDelayMs = 500;
      await upsertSummaryWorkerHeartbeat({
        workerId: input.workerId,
        mode: input.mode,
        status: "running",
        claimedDelta: claimed.length
      });
    }

    for (const job of claimed) {
      await upsertSummaryWorkerHeartbeat({ workerId: input.workerId, mode: input.mode, status: "running", currentJob: job });
      // eslint-disable-next-line no-await-in-loop
      const result = await runJobWithLeaseHeartbeat(input, job);
      // eslint-disable-next-line no-await-in-loop
      await upsertSummaryWorkerHeartbeat({
        workerId: input.workerId,
        mode: input.mode,
        status: "idle",
        currentJob: null,
        completedDelta: result.status === "completed" ? 1 : 0,
        failedDelta: isFailedJobResult(result) ? 1 : 0
      });
    }
  } catch (error) {
    nextDelayMs = getNextTickDelay(error);
    if (isDatabaseConnectionError(error)) {
      console.warn("summary job worker tick skipped: database unavailable", {
        delayMs: nextDelayMs
      });
    } else {
      console.error("summary job worker tick failed", error);
    }
  } finally {
    workerGlobal.openDebateSummaryWorkerTickRunning = false;
    const shouldWakeNow = Boolean(workerGlobal.openDebateSummaryWorkerWakeRequested);
    workerGlobal.openDebateSummaryWorkerWakeRequested = false;
    scheduleSummaryWorkerTick(input, shouldWakeNow ? 0 : nextDelayMs);
  }
}

export function startSummaryJobWorkerLoop(options?: {
  reason?: string;
  mode?: SummaryWorkerMode;
  unrefTimer?: boolean;
}) {
  if (typeof window !== "undefined") return Promise.resolve({ workerId: "browser:no-op" });
  if (workerGlobal.openDebateSummaryWorkerPromise) {
    return workerGlobal.openDebateSummaryWorkerPromise;
  }

  const mode = options?.mode ?? "embedded";
  const workerId = `summary-worker:${mode}:${process.pid}:${randomUUID()}`;
  workerGlobal.openDebateSummaryWorkerId = workerId;
  workerGlobal.openDebateSummaryWorkerMode = mode;
  workerGlobal.openDebateSummaryWorkerStopped = false;

  workerGlobal.openDebateSummaryWorkerPromise = (async () => {
    const db = await ensureDb();
    await db.executeQuery(sql`select 1`.compile(db));
    await upsertSummaryWorkerHeartbeat({ workerId, mode, status: "idle", currentJob: null });
    const tickInput = {
      reason: options?.reason ?? "server_boot",
      workerId,
      mode,
      unrefTimer: options?.unrefTimer ?? mode === "embedded",
      reschedule: true
    };
    void startSummaryWorkerWakeListener(tickInput).catch((error) => {
      if (isDatabaseConnectionError(error)) return;
      console.warn("summary worker wake listener failed", error);
    });
    scheduleSummaryWorkerTick(tickInput, 0);
    return { workerId };
  })().catch((error) => {
    workerGlobal.openDebateSummaryWorkerPromise = undefined;
    throw error;
  });

  return workerGlobal.openDebateSummaryWorkerPromise;
}

export async function runSummaryJobWorkerOnce(options?: { reason?: string; mode?: SummaryWorkerMode }) {
  const mode = options?.mode ?? "standalone";
  const workerId = `summary-worker:${mode}:once:${process.pid}:${randomUUID()}`;
  const db = await ensureDb();
  await db.executeQuery(sql`select 1`.compile(db));
  await tickSummaryJobWorker({
    reason: options?.reason ?? "manual_once",
    workerId,
    mode,
    unrefTimer: false,
    reschedule: false
  });
  await markSummaryWorkerStopped(workerId).catch(() => null);
  const recovered = await recoverStaleDebateSummaryJobs({ workerId });
  await logRecoveredSummaryJobs("worker_once_stop", recovered);
  return { workerId };
}

export async function stopSummaryJobWorkerLoop() {
  workerGlobal.openDebateSummaryWorkerStopped = true;
  if (workerGlobal.openDebateSummaryWorkerTimer) {
    clearTimeout(workerGlobal.openDebateSummaryWorkerTimer);
    workerGlobal.openDebateSummaryWorkerTimer = null;
  }
  if (workerGlobal.openDebateSummaryWorkerId) {
    const workerId = workerGlobal.openDebateSummaryWorkerId;
    await markSummaryWorkerStopped(workerId).catch(() => null);
    const recovered = await recoverStaleDebateSummaryJobs({ workerId });
    await logRecoveredSummaryJobs("worker_stop", recovered);
  }
  const wakeClient = workerGlobal.openDebateSummaryWorkerWakeClient;
  workerGlobal.openDebateSummaryWorkerWakeClient = null;
  workerGlobal.openDebateSummaryWorkerWakeListenerPromise = undefined;
  if (wakeClient) {
    await wakeClient.query(`unlisten ${SUMMARY_WORKER_NOTIFY_CHANNEL}`).catch(() => null);
    wakeClient.release();
  }
  workerGlobal.openDebateSummaryWorkerPromise = undefined;
}

export function ensureSummaryJobWorkerStarted(reason = "server_boot") {
  if (process.env.OPEN_DEBATE_DISABLE_EMBEDDED_SUMMARY_WORKER === "1") {
    return Promise.resolve({ workerId: "embedded:disabled" });
  }
  return startSummaryJobWorkerLoop({ reason, mode: "embedded", unrefTimer: true });
}
