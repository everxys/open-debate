import {
  type BackgroundJobAdapter,
  type BackgroundJobDashboardItem,
  type BackgroundJobQueueStat,
  type BackgroundJobSourceFilter,
  type BackgroundJobStat,
  type BackgroundJobStatusBucket,
  type BackgroundJobStatusFilter,
  type BackgroundJobWorkerHealth
} from "@/lib/background-job";
import { query } from "@/lib/db";
import { AppError } from "@/lib/http";
import {
  getSummaryWorkerHealthSnapshot,
  SUMMARY_JOB_MAX_ATTEMPTS,
  SUMMARY_WORKER_NOTIFY_CHANNEL
} from "@/lib/summary-jobs";
import { normalizeNullableTimestampString, normalizeTimestampString } from "@/lib/timestamps";

export type OpenDebateBackgroundJobSource = "summary" | "resume";

type JobRow = {
  source: OpenDebateBackgroundJobSource;
  id: string;
  kind: string;
  status: string;
  status_bucket: BackgroundJobStatusBucket;
  debate_id: string | null;
  debate_question: string | null;
  job_key: string | null;
  retry_count: number | string | null;
  max_retries: number | string | null;
  failure_reason: string | null;
  run_at: string | null;
  next_retry_at: string | null;
  locked_by: string | null;
  locked_at: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  duration_ms: number | string | null;
  can_rerun: boolean;
};

type JobStatRow = {
  source: OpenDebateBackgroundJobSource;
  status_bucket: BackgroundJobStatusBucket;
  count: number | string;
};

export const openDebateBackgroundJobSources = [
  { source: "summary" as const, label: "Summary Worker" },
  { source: "resume" as const, label: "恢复任务" }
];

let summaryWorkerHealthSnapshotPromise: ReturnType<typeof getSummaryWorkerHealthSnapshot> | null = null;

function getSharedSummaryWorkerHealthSnapshot() {
  if (summaryWorkerHealthSnapshotPromise) return summaryWorkerHealthSnapshotPromise;
  const promise = getSummaryWorkerHealthSnapshot();
  summaryWorkerHealthSnapshotPromise = promise;
  void promise
    .finally(() => {
      if (summaryWorkerHealthSnapshotPromise === promise) summaryWorkerHealthSnapshotPromise = null;
    })
    .catch(() => null);
  return promise;
}

function toInt(value: unknown) {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

function getSourceLabel(source: OpenDebateBackgroundJobSource) {
  return source === "summary" ? "Summary Worker" : "恢复任务";
}

function getKindLabel(source: OpenDebateBackgroundJobSource, kind: string) {
  if (source === "resume") {
    if (kind === "quota_wait") return "限额恢复";
    return kind || "恢复任务";
  }
  if (kind === "turn_summary") return "回合摘要";
  if (kind === "round_summary") return "轮次摘要";
  if (kind === "facts_board") return "事实板刷新";
  return kind || "总结任务";
}

function normalizeJobRow(row: JobRow): BackgroundJobDashboardItem<OpenDebateBackgroundJobSource> {
  return {
    source: row.source,
    sourceLabel: getSourceLabel(row.source),
    id: String(row.id),
    kind: String(row.kind ?? ""),
    kindLabel: getKindLabel(row.source, String(row.kind ?? "")),
    status: String(row.status ?? ""),
    statusBucket: row.status_bucket,
    debateId: row.debate_id ? String(row.debate_id) : null,
    debateQuestion: row.debate_question ? String(row.debate_question) : null,
    jobKey: row.job_key ? String(row.job_key) : null,
    retryCount: toInt(row.retry_count),
    maxRetries: row.max_retries === null ? null : toInt(row.max_retries),
    failureReason: row.failure_reason ? String(row.failure_reason) : null,
    runAt: normalizeNullableTimestampString(row.run_at),
    nextRetryAt: normalizeNullableTimestampString(row.next_retry_at),
    lockedBy: row.locked_by ? String(row.locked_by) : null,
    lockedAt: normalizeNullableTimestampString(row.locked_at),
    createdAt: normalizeTimestampString(row.created_at),
    updatedAt: normalizeTimestampString(row.updated_at),
    completedAt: normalizeNullableTimestampString(row.completed_at),
    durationMs: toInt(row.duration_ms),
    canRerun: Boolean(row.can_rerun)
  };
}

function buildJobsCte() {
  return `
    with jobs as (
      select
        'summary'::text as source,
        j.id::text as id,
        j.kind::text as kind,
        j.status::text as status,
        case
          when j.status in ('queued', 'running', 'retry_wait', 'blocked') then 'active'
          when j.status in ('failed', 'dead_letter') then 'failed'
          else 'completed'
        end as status_bucket,
        j.debate_id::text as debate_id,
        d.question as debate_question,
        j.job_key::text as job_key,
        j.attempt_count::int as retry_count,
        ${SUMMARY_JOB_MAX_ATTEMPTS}::int as max_retries,
        j.last_error as failure_reason,
        case when j.status = 'retry_wait' then j.next_retry_at else j.run_after end as run_at,
        j.next_retry_at,
        j.locked_by,
        j.locked_at,
        j.created_at,
        j.updated_at,
        j.completed_at,
        greatest(0, floor(extract(epoch from (
          case
            when j.completed_at is not null then j.completed_at - coalesce(j.locked_at, j.created_at)
            when j.status = 'running' then now() - coalesce(j.locked_at, j.created_at)
            else j.updated_at - j.created_at
          end
        )) * 1000))::bigint as duration_ms,
        (j.status <> 'running') as can_rerun
      from debate_summary_jobs j
      left join debates d on d.id = j.debate_id

      union all

      select
        'resume'::text as source,
        j.id::text as id,
        j.reason::text as kind,
        j.status::text as status,
        case
          when j.status in ('pending', 'running') then 'active'
          when j.status = 'failed' then 'failed'
          else 'completed'
        end as status_bucket,
        j.debate_id::text as debate_id,
        d.question as debate_question,
        null::text as job_key,
        j.attempt_count::int as retry_count,
        null::int as max_retries,
        j.last_error as failure_reason,
        j.resume_at as run_at,
        null::timestamptz as next_retry_at,
        j.locked_by,
        j.locked_at,
        j.created_at,
        j.updated_at,
        j.completed_at,
        greatest(0, floor(extract(epoch from (
          case
            when j.completed_at is not null then j.completed_at - coalesce(j.locked_at, j.created_at)
            when j.status = 'running' then now() - coalesce(j.locked_at, j.created_at)
            else j.updated_at - j.created_at
          end
        )) * 1000))::bigint as duration_ms,
        (j.status <> 'running') as can_rerun
      from debate_resume_jobs j
      left join debates d on d.id = j.debate_id
    )
  `;
}

async function listJobs(input: {
  source: BackgroundJobSourceFilter<OpenDebateBackgroundJobSource>;
  status: BackgroundJobStatusFilter;
  limit: number;
}) {
  const cte = buildJobsCte();
  const result = await query<JobRow>(
    `
      ${cte}
      select *
        from jobs
       where ($1 = 'all' or source = $1)
         and ($2 = 'all' or status_bucket = $2)
       order by
         case status_bucket when 'active' then 0 when 'failed' then 1 else 2 end,
         updated_at desc,
         created_at desc
       limit $3
    `,
    [input.source, input.status, input.limit]
  );
  return result.rows.map(normalizeJobRow);
}

async function listStats(): Promise<Array<BackgroundJobStat<OpenDebateBackgroundJobSource>>> {
  const cte = buildJobsCte();
  const result = await query<JobStatRow>(
    `
      ${cte}
      select source, status_bucket, count(*)::int as count
        from jobs
       group by source, status_bucket
       order by source asc, status_bucket asc
    `
  );
  return result.rows.map((row) => ({
    source: row.source,
    statusBucket: row.status_bucket,
    count: toInt(row.count)
  }));
}

async function listWorkers(): Promise<Array<BackgroundJobWorkerHealth<OpenDebateBackgroundJobSource>>> {
  const snapshot = await getSharedSummaryWorkerHealthSnapshot();
  return snapshot.workers.map((worker) => ({
    ...worker,
    source: "summary" as const,
    label: "Summary Worker"
  }));
}

async function listQueues(): Promise<Array<BackgroundJobQueueStat<OpenDebateBackgroundJobSource>>> {
  const snapshot = await getSharedSummaryWorkerHealthSnapshot();
  return snapshot.queue.map((item) => ({
    source: "summary" as const,
    kind: item.kind,
    status: item.status,
    count: item.count
  }));
}

async function notifyJobDashboardRerun(source: OpenDebateBackgroundJobSource, id: string, debateId: string | null) {
  await query("select pg_notify($1, $2)", [
    SUMMARY_WORKER_NOTIFY_CHANNEL,
    JSON.stringify({ action: "manual_rerun", source, id, debateId, at: new Date().toISOString() })
  ]).catch(() => null);
}

async function rerun(input: { source: OpenDebateBackgroundJobSource; id: string }) {
  if (input.source === "summary") {
    const result = await query<{ id: string; debate_id: string }>(
      `
        update debate_summary_jobs
           set status = 'queued',
               run_after = now(),
               next_retry_at = null,
               locked_by = null,
               locked_at = null,
               last_error = null,
               completed_at = null,
               payload_json = coalesce(payload_json, '{}'::jsonb) || jsonb_build_object('manualRerunRequestedAt', now()::text),
               updated_at = now()
         where id = $1
           and status <> 'running'
         returning id, debate_id
      `,
      [input.id]
    );
    const row = result.rows[0];
    if (!row) throw new AppError("JOB_NOT_RERUNNABLE", 409, "Job is running or does not exist");
    await notifyJobDashboardRerun(input.source, row.id, row.debate_id);
    return { source: input.source, id: row.id };
  }

  const result = await query<{ id: string; debate_id: string }>(
    `
      update debate_resume_jobs
         set status = 'pending',
             resume_at = now(),
             locked_by = null,
             locked_at = null,
             last_error = null,
             completed_at = null,
             updated_at = now()
       where id = $1
         and status <> 'running'
       returning id, debate_id
    `,
    [input.id]
  );
  const row = result.rows[0];
  if (!row) throw new AppError("JOB_NOT_RERUNNABLE", 409, "Job is running or does not exist");
  await notifyJobDashboardRerun(input.source, row.id, row.debate_id);
  return { source: input.source, id: row.id };
}

export const openDebateBackgroundJobAdapter: BackgroundJobAdapter<OpenDebateBackgroundJobSource> = {
  sources: openDebateBackgroundJobSources,
  listJobs,
  listStats,
  listWorkers,
  listQueues,
  rerun
};

export async function getOpenDebateWorkerSnapshot() {
  const [workers, queues] = await Promise.all([listWorkers(), listQueues()]);
  return {
    workers,
    queue: queues.map(({ kind, status, count }) => ({ kind, status, count }))
  };
}
