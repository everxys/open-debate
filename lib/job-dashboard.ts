import {
  formatBackgroundJobDurationMs,
  getBackgroundJobDashboardData,
  normalizeBackgroundJobSourceFilter,
  normalizeBackgroundJobStatusFilter,
  parseBackgroundJobLimit,
  rerunBackgroundJobWithAdapter,
  type BackgroundJobDashboardItem as GenericBackgroundJobDashboardItem,
  type BackgroundJobSourceFilter as GenericBackgroundJobSourceFilter,
  type BackgroundJobStatusBucket,
  type BackgroundJobStatusFilter
} from "@/lib/background-job";
import {
  getOpenDebateWorkerSnapshot,
  openDebateBackgroundJobAdapter,
  openDebateBackgroundJobSources,
  type OpenDebateBackgroundJobSource
} from "@/lib/open-debate-background-jobs";

export type BackgroundJobSource = OpenDebateBackgroundJobSource;
export type BackgroundJobSourceFilter = GenericBackgroundJobSourceFilter<BackgroundJobSource>;
export type { BackgroundJobStatusBucket, BackgroundJobStatusFilter };
export type BackgroundJobDashboardItem = GenericBackgroundJobDashboardItem<BackgroundJobSource>;

export const parseJobLimit = parseBackgroundJobLimit;
export const normalizeJobStatusFilter = normalizeBackgroundJobStatusFilter;
export const formatDurationMs = formatBackgroundJobDurationMs;

export function normalizeJobSourceFilter(value: string | null | undefined): BackgroundJobSourceFilter {
  return normalizeBackgroundJobSourceFilter(value, openDebateBackgroundJobSources);
}

export async function getBackgroundJobDashboard(input?: {
  source?: BackgroundJobSourceFilter;
  status?: BackgroundJobStatusFilter;
  limit?: number;
}) {
  const data = await getBackgroundJobDashboardData(openDebateBackgroundJobAdapter, input);
  return {
    ...data,
    summaryQueue: data.queues.map(({ kind, status, count }) => ({ kind, status, count }))
  };
}

export async function rerunBackgroundJob(source: BackgroundJobSource, id: string) {
  return rerunBackgroundJobWithAdapter(openDebateBackgroundJobAdapter, source, id);
}

export async function getBackgroundJobWorkerSnapshot() {
  return getOpenDebateWorkerSnapshot();
}
