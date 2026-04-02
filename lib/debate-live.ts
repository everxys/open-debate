import { EventEmitter } from "node:events";

export type DebateLiveStage =
  | "idle"
  | "calling_model"
  | "running_tools"
  | "parsing"
  | "saving"
  | "sleeping";

export type DebateLiveProgress = {
  debateId: string;
  roundNumber: number;
  messageNumber: number;
  debateAgentId: string;
  aiAgentId: string;
  agentName: string;
  baseRoleName: string;
  stage: DebateLiveStage;
  updatedAt: string;
};

export type DebateSummaryJobStatus =
  | "queued"
  | "running"
  | "retry_wait"
  | "blocked"
  | "failed"
  | "completed"
  | "dead_letter";

export type DebateSummaryJob = {
  key: string;
  kind: "turn_summary" | "round_summary" | "facts_board";
  status: DebateSummaryJobStatus;
  label: string;
  turnNumber: number | null;
  roundNumber: number | null;
  message: string | null;
  errorReason: string | null;
  retryAt: string | null;
  attemptCount: number | null;
  blockedReason: string | null;
  deadLetter: boolean;
  updatedAt: string;
};

export type DebateLiveEvent =
  | { type: "turn_start"; progress: DebateLiveProgress }
  | { type: "summary_job"; debateId: string; job: DebateSummaryJob }
  | { type: "status"; debateId: string; message: string; at: string }
  | { type: "chunk"; debateId: string; turnNumber: number; agentName: string; baseRoleName: string | null; text: string; at: string }
  | { type: "turn_end"; debateId: string; turnNumber: number; agentName: string; at: string };

type Store = {
  emitter: EventEmitter;
  progressByDebateId: Map<string, DebateLiveProgress>;
  summaryJobsByDebateId: Map<string, Map<string, DebateSummaryJob>>;
};

function getStore(): Store {
  const anyGlobal = globalThis as unknown as { __openDebateLive?: Store };
  if (!anyGlobal.__openDebateLive) {
    anyGlobal.__openDebateLive = {
      emitter: new EventEmitter(),
      progressByDebateId: new Map(),
      summaryJobsByDebateId: new Map()
    };
    anyGlobal.__openDebateLive.emitter.setMaxListeners(200);
  }
  return anyGlobal.__openDebateLive;
}

export function getDebateLiveProgress(debateId: string) {
  const store = getStore();
  return {
    progress: store.progressByDebateId.get(debateId) ?? null,
    summaryJobs: [...(store.summaryJobsByDebateId.get(debateId)?.values() ?? [])].sort((left, right) =>
      left.updatedAt.localeCompare(right.updatedAt)
    )
  };
}

export function clearDebateLiveProgress(debateId: string) {
  const store = getStore();
  store.progressByDebateId.delete(debateId);
  store.summaryJobsByDebateId.delete(debateId);
}

export function setDebateLiveProgress(progress: Omit<DebateLiveProgress, "updatedAt"> & { updatedAt?: string }) {
  const store = getStore();
  const next: DebateLiveProgress = {
    ...progress,
    updatedAt: progress.updatedAt ?? new Date().toISOString()
  };
  store.progressByDebateId.set(progress.debateId, next);
  store.emitter.emit(`debate:${progress.debateId}`, { type: "turn_start", progress: next } satisfies DebateLiveEvent);
}

export function emitDebateLiveEvent(debateId: string, event: DebateLiveEvent) {
  getStore().emitter.emit(`debate:${debateId}`, event);
}

export function setDebateSummaryJob(
  debateId: string,
  job: Omit<DebateSummaryJob, "updatedAt" | "attemptCount" | "blockedReason" | "deadLetter"> & {
    updatedAt?: string;
    attemptCount?: number | null;
    blockedReason?: string | null;
    deadLetter?: boolean;
  }
) {
  const store = getStore();
  const jobs = store.summaryJobsByDebateId.get(debateId) ?? new Map<string, DebateSummaryJob>();
  const next: DebateSummaryJob = {
    ...job,
    attemptCount: job.attemptCount ?? null,
    blockedReason: job.blockedReason ?? null,
    deadLetter: Boolean(job.deadLetter),
    updatedAt: job.updatedAt ?? new Date().toISOString()
  };
  jobs.set(next.key, next);
  store.summaryJobsByDebateId.set(debateId, jobs);
  store.emitter.emit(`debate:${debateId}`, { type: "summary_job", debateId, job: next } satisfies DebateLiveEvent);
}

export function clearDebateSummaryJob(debateId: string, key: string) {
  const store = getStore();
  const jobs = store.summaryJobsByDebateId.get(debateId);
  if (!jobs) return;
  jobs.delete(key);
  if (jobs.size <= 0) {
    store.summaryJobsByDebateId.delete(debateId);
  }
}

export function subscribeDebateLiveEvents(
  debateId: string,
  listener: (event: DebateLiveEvent) => void
) {
  const store = getStore();
  const key = `debate:${debateId}`;
  store.emitter.on(key, listener);
  return () => store.emitter.off(key, listener);
}
