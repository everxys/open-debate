export type BackgroundJobStatusBucket = "active" | "failed" | "completed";
export type BackgroundJobStatusFilter = BackgroundJobStatusBucket | "all";
export type BackgroundJobSourceFilter<TSource extends string = string> = TSource | "all";

export type BackgroundJobSourceDefinition<TSource extends string = string> = {
  source: TSource;
  label: string;
};

export type BackgroundJobDashboardItem<TSource extends string = string> = {
  source: TSource;
  sourceLabel: string;
  id: string;
  kind: string;
  kindLabel: string;
  status: string;
  statusBucket: BackgroundJobStatusBucket;
  debateId: string | null;
  debateQuestion: string | null;
  jobKey: string | null;
  retryCount: number;
  maxRetries: number | null;
  failureReason: string | null;
  runAt: string | null;
  nextRetryAt: string | null;
  lockedBy: string | null;
  lockedAt: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  durationMs: number;
  canRerun: boolean;
};

export type BackgroundJobStat<TSource extends string = string> = {
  source: TSource;
  statusBucket: BackgroundJobStatusBucket;
  count: number;
};

export type BackgroundJobWorkerHealth<TSource extends string = string> = {
  id: string;
  source?: TSource;
  label?: string;
  mode: string;
  status: string;
  startedAt?: string;
  lastHeartbeatAt: string;
  currentJobId?: string | null;
  currentDebateId?: string | null;
  currentJobKey: string | null;
  claimedCount: number;
  completedCount: number;
  failedCount: number;
  updatedAt?: string;
  stale: boolean;
};

export type BackgroundJobQueueStat<TSource extends string = string> = {
  source: TSource;
  kind: string;
  status: string;
  count: number;
};

export type BackgroundJobDashboardData<TSource extends string = string> = {
  filters: {
    source: BackgroundJobSourceFilter<TSource>;
    status: BackgroundJobStatusFilter;
    limit: number;
  };
  sources: Array<BackgroundJobSourceDefinition<TSource>>;
  workers: Array<BackgroundJobWorkerHealth<TSource>>;
  queues: Array<BackgroundJobQueueStat<TSource>>;
  stats: Array<BackgroundJobStat<TSource>>;
  jobs: Array<BackgroundJobDashboardItem<TSource>>;
};

export type BackgroundJobAdapter<TSource extends string = string> = {
  sources: Array<BackgroundJobSourceDefinition<TSource>>;
  listJobs: (input: {
    source: BackgroundJobSourceFilter<TSource>;
    status: BackgroundJobStatusFilter;
    limit: number;
  }) => Promise<Array<BackgroundJobDashboardItem<TSource>>>;
  listStats: () => Promise<Array<BackgroundJobStat<TSource>>>;
  listWorkers?: () => Promise<Array<BackgroundJobWorkerHealth<TSource>>>;
  listQueues?: () => Promise<Array<BackgroundJobQueueStat<TSource>>>;
  rerun: (input: { source: TSource; id: string }) => Promise<{ source: TSource; id: string }>;
};

const DEFAULT_JOB_LIMIT = 80;
const MAX_JOB_LIMIT = 200;

export function parseBackgroundJobLimit(value: string | null | undefined) {
  if (value === null || value === undefined || value.trim() === "") return DEFAULT_JOB_LIMIT;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_JOB_LIMIT;
  return Math.max(1, Math.min(MAX_JOB_LIMIT, Math.trunc(parsed)));
}

export function normalizeBackgroundJobStatusFilter(value: string | null | undefined): BackgroundJobStatusFilter {
  if (value === "active" || value === "failed" || value === "completed") return value;
  return "all";
}

export function normalizeBackgroundJobSourceFilter<TSource extends string>(
  value: string | null | undefined,
  sources: Array<BackgroundJobSourceDefinition<TSource>>
): BackgroundJobSourceFilter<TSource> {
  if (value && sources.some((item) => item.source === value)) return value as TSource;
  return "all";
}

export function formatBackgroundJobDurationMs(durationMs: number) {
  const seconds = Math.max(0, Math.floor(durationMs / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export async function getBackgroundJobDashboardData<TSource extends string>(
  adapter: BackgroundJobAdapter<TSource>,
  input?: {
    source?: BackgroundJobSourceFilter<TSource>;
    status?: BackgroundJobStatusFilter;
    limit?: number;
  }
): Promise<BackgroundJobDashboardData<TSource>> {
  const source = input?.source ?? "all";
  const status = input?.status ?? "all";
  const limit = Math.max(1, Math.min(MAX_JOB_LIMIT, Math.trunc(input?.limit ?? DEFAULT_JOB_LIMIT)));
  const [jobs, stats, workers, queues] = await Promise.all([
    adapter.listJobs({ source, status, limit }),
    adapter.listStats(),
    adapter.listWorkers?.() ?? Promise.resolve([]),
    adapter.listQueues?.() ?? Promise.resolve([])
  ]);

  return {
    filters: { source, status, limit },
    sources: adapter.sources,
    workers,
    queues,
    stats,
    jobs
  };
}

export async function rerunBackgroundJobWithAdapter<TSource extends string>(
  adapter: BackgroundJobAdapter<TSource>,
  source: TSource,
  id: string
) {
  return adapter.rerun({ source, id });
}
