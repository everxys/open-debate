import { randomUUID } from "crypto";

import { sql } from "kysely";

import { ensureDb } from "@/lib/db";

export type DebateSummaryJobKind = "turn_summary" | "round_summary" | "facts_board";
export const FACTS_BOARD_JOB_KEY = "facts:board";
export const FACTS_BOARD_DEBOUNCE_MS = 8_000;
export const SUMMARY_WORKER_NOTIFY_CHANNEL = "open_debate_summary_jobs";

export type DebateSummaryJobStatus =
  | "queued"
  | "running"
  | "retry_wait"
  | "blocked"
  | "failed"
  | "completed"
  | "dead_letter";

export type DebateSummaryJobRecord = {
  id: string;
  debateId: string;
  kind: DebateSummaryJobKind;
  status: DebateSummaryJobStatus;
  jobKey: string;
  turnNumber: number | null;
  roundNumber: number | null;
  dependsOnKeys: string[];
  payload: Record<string, unknown>;
  priority: number;
  runAfter: string | null;
  attemptCount: number;
  lastError: string | null;
  nextRetryAt: string | null;
  lockedBy: string | null;
  lockedAt: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type DebateSummaryJobLiveView = {
  key: string;
  kind: DebateSummaryJobKind;
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

type SummaryJobRow = {
  id: string;
  debate_id: string;
  kind: DebateSummaryJobKind;
  status: DebateSummaryJobStatus;
  job_key: string;
  turn_number: number | null;
  round_number: number | null;
  depends_on_keys: unknown;
  payload_json: unknown;
  priority: number;
  run_after: string | null;
  attempt_count: number;
  last_error: string | null;
  next_retry_at: string | null;
  locked_by: string | null;
  locked_at: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

type SummaryWorkerRow = {
  id: string;
  mode: string;
  status: string;
  started_at: string;
  last_heartbeat_at: string;
  current_job_id: string | null;
  current_debate_id: string | null;
  current_job_key: string | null;
  claimed_count: number;
  completed_count: number;
  failed_count: number;
  updated_at: string;
};

export type DebateSummaryWorkerHealth = {
  id: string;
  mode: string;
  status: string;
  startedAt: string;
  lastHeartbeatAt: string;
  currentJobId: string | null;
  currentDebateId: string | null;
  currentJobKey: string | null;
  claimedCount: number;
  completedCount: number;
  failedCount: number;
  updatedAt: string;
  stale: boolean;
};

export type DebateSummaryQueueStat = {
  kind: DebateSummaryJobKind;
  status: DebateSummaryJobStatus;
  count: number;
};

function normalizeStringArray(value: unknown) {
  if (!Array.isArray(value)) return [] as string[];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function normalizePayload(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {} as Record<string, unknown>;
  return value as Record<string, unknown>;
}

function normalizeSummaryJobRow(row: SummaryJobRow): DebateSummaryJobRecord {
  return {
    id: String(row.id),
    debateId: String(row.debate_id),
    kind: row.kind,
    status: row.status,
    jobKey: String(row.job_key),
    turnNumber: row.turn_number === null ? null : Number(row.turn_number),
    roundNumber: row.round_number === null ? null : Number(row.round_number),
    dependsOnKeys: normalizeStringArray(row.depends_on_keys),
    payload: normalizePayload(row.payload_json),
    priority: Number(row.priority ?? 100),
    runAfter: row.run_after ? String(row.run_after) : null,
    attemptCount: Number(row.attempt_count ?? 0),
    lastError: row.last_error ? String(row.last_error) : null,
    nextRetryAt: row.next_retry_at ? String(row.next_retry_at) : null,
    lockedBy: row.locked_by ? String(row.locked_by) : null,
    lockedAt: row.locked_at ? String(row.locked_at) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    completedAt: row.completed_at ? String(row.completed_at) : null
  };
}

function normalizeSummaryWorkerRow(row: SummaryWorkerRow): DebateSummaryWorkerHealth {
  const lastHeartbeatMs = new Date(row.last_heartbeat_at).getTime();
  const stale = !Number.isFinite(lastHeartbeatMs) || Date.now() - lastHeartbeatMs > 30_000;
  return {
    id: String(row.id),
    mode: String(row.mode),
    status: String(row.status),
    startedAt: String(row.started_at),
    lastHeartbeatAt: String(row.last_heartbeat_at),
    currentJobId: row.current_job_id ? String(row.current_job_id) : null,
    currentDebateId: row.current_debate_id ? String(row.current_debate_id) : null,
    currentJobKey: row.current_job_key ? String(row.current_job_key) : null,
    claimedCount: Number(row.claimed_count ?? 0),
    completedCount: Number(row.completed_count ?? 0),
    failedCount: Number(row.failed_count ?? 0),
    updatedAt: String(row.updated_at),
    stale
  };
}

export function getSummaryJobRetryDelayMs(attemptCount: number) {
  if (attemptCount <= 1) return 30_000;
  if (attemptCount === 2) return 2 * 60_000;
  if (attemptCount === 3) return 10 * 60_000;
  if (attemptCount === 4) return 30 * 60_000;
  return 2 * 60 * 60_000;
}

async function notifySummaryWorkerQueueChanged(debateId: string) {
  const db = await ensureDb();
  await db.executeQuery(sql`
    select pg_notify(
      ${SUMMARY_WORKER_NOTIFY_CHANNEL},
      json_build_object('debateId', ${debateId}, 'at', now())::text
    )
  `.compile(db));
}

export async function listDebateSummaryJobs(debateId: string) {
  const db = await ensureDb();
  const result = await db.executeQuery<SummaryJobRow>(sql`
    select *
      from debate_summary_jobs
     where debate_id = ${debateId}
     order by
       case kind
         when 'turn_summary' then 1
         when 'round_summary' then 2
         else 3
       end,
       coalesce(round_number, 0) asc,
       coalesce(turn_number, 0) asc,
       created_at asc
  `.compile(db));
  return result.rows.map(normalizeSummaryJobRow);
}

export async function listActiveDebateSummaryJobs(debateId: string) {
  const db = await ensureDb();
  const result = await db.executeQuery<SummaryJobRow>(sql`
    select *
      from debate_summary_jobs
     where debate_id = ${debateId}
       and status <> 'completed'
     order by
       case kind
         when 'turn_summary' then 1
         when 'round_summary' then 2
         else 3
       end,
       coalesce(round_number, 0) asc,
       coalesce(turn_number, 0) asc,
       created_at asc
  `.compile(db));
  return result.rows.map(normalizeSummaryJobRow);
}

export function toDebateSummaryJobLiveView(
  job: DebateSummaryJobRecord,
  message?: string | null,
  blockedReason?: string | null
): DebateSummaryJobLiveView {
  return {
    key: job.jobKey,
    kind: job.kind,
    status: job.status,
    label:
      job.kind === "turn_summary"
        ? `第 ${job.roundNumber ?? "?"} 轮第 ${job.turnNumber ?? "?"} 回摘要`
        : job.kind === "round_summary"
          ? `第 ${job.roundNumber ?? "?"} 轮摘要`
          : "结构化事实板",
    turnNumber: job.turnNumber,
    roundNumber: job.roundNumber,
    message: message ?? null,
    errorReason: blockedReason ?? job.lastError,
    retryAt: job.nextRetryAt,
    attemptCount: job.attemptCount,
    blockedReason: blockedReason ?? (job.status === "blocked" ? job.lastError : null),
    deadLetter: job.status === "dead_letter",
    updatedAt: job.updatedAt
  };
}

export async function getDebateSummaryJobByKey(debateId: string, jobKey: string) {
  const db = await ensureDb();
  const result = await db.executeQuery<SummaryJobRow>(sql`
    select * from debate_summary_jobs where debate_id = ${debateId} and job_key = ${jobKey} limit 1
  `.compile(db));
  if ((result.rows.length ?? 0) !== 1) return null;
  return normalizeSummaryJobRow(result.rows[0]);
}

export async function enqueueDebateSummaryJob(input: {
  debateId: string;
  kind: DebateSummaryJobKind;
  jobKey: string;
  turnNumber?: number | null;
  roundNumber?: number | null;
  dependsOnKeys?: string[];
  payload?: Record<string, unknown>;
  status?: Extract<DebateSummaryJobStatus, "queued" | "blocked">;
  priority?: number;
  runAfter?: string | null;
  force?: boolean;
}) {
  const now = new Date().toISOString();
  const payloadJson = JSON.stringify(input.payload ?? {});
  const dependsOnJson = JSON.stringify(input.dependsOnKeys ?? []);
  const status = input.status ?? "queued";
  const priority = Number.isFinite(input.priority) ? Math.trunc(Number(input.priority)) : 100;
  const runAfter = typeof input.runAfter === "string" && input.runAfter.trim() ? input.runAfter : null;

  const db = await ensureDb();
  const result = await db.executeQuery<SummaryJobRow>(sql`
    insert into debate_summary_jobs (
      id,
      debate_id,
      kind,
      status,
      job_key,
      turn_number,
      round_number,
      depends_on_keys,
      payload_json,
      priority,
      run_after,
      attempt_count,
      last_error,
      next_retry_at,
      locked_by,
      locked_at,
      created_at,
      updated_at,
      completed_at
    )
    values (
      ${randomUUID()},
      ${input.debateId},
      ${input.kind},
      ${status},
      ${input.jobKey},
      ${input.turnNumber ?? null},
      ${input.roundNumber ?? null},
      ${dependsOnJson}::jsonb,
      ${payloadJson}::jsonb,
      ${priority},
      ${runAfter}::timestamptz,
      0,
      null,
      null,
      null,
      null,
      ${now},
      ${now},
      null
    )
    on conflict (debate_id, job_key) do update
    set
      kind = excluded.kind,
      turn_number = excluded.turn_number,
      round_number = excluded.round_number,
      depends_on_keys = excluded.depends_on_keys,
      payload_json = case
        when ${Boolean(input.force)} then excluded.payload_json
        when debate_summary_jobs.kind = 'facts_board'
             and debate_summary_jobs.status = 'running'
          then excluded.payload_json || jsonb_build_object('rerunRequestedAt', ${now}::text)
        when debate_summary_jobs.kind = 'facts_board'
          then excluded.payload_json
        else debate_summary_jobs.payload_json
      end,
      priority = case
        when ${Boolean(input.force)} then excluded.priority
        when debate_summary_jobs.kind = 'facts_board' then least(debate_summary_jobs.priority, excluded.priority)
        else debate_summary_jobs.priority
      end,
      run_after = case
        when ${Boolean(input.force)} then excluded.run_after
        when debate_summary_jobs.kind = 'facts_board' then excluded.run_after
        else debate_summary_jobs.run_after
      end,
      status = case
        when ${Boolean(input.force)} then excluded.status
        when debate_summary_jobs.kind = 'facts_board'
             and debate_summary_jobs.status = 'running'
          then debate_summary_jobs.status
        when debate_summary_jobs.kind = 'facts_board'
          then excluded.status
        when debate_summary_jobs.status = 'completed' and not ${Boolean(input.force)} then debate_summary_jobs.status
        else debate_summary_jobs.status
      end,
      attempt_count = case
        when ${Boolean(input.force)} then 0
        when debate_summary_jobs.kind = 'facts_board' and debate_summary_jobs.status <> 'running' then 0
        else debate_summary_jobs.attempt_count
      end,
      last_error = case
        when ${Boolean(input.force)} then null
        when debate_summary_jobs.kind = 'facts_board' and debate_summary_jobs.status <> 'running' then null
        else debate_summary_jobs.last_error
      end,
      next_retry_at = case
        when ${Boolean(input.force)} then null
        when debate_summary_jobs.kind = 'facts_board' and debate_summary_jobs.status <> 'running' then null
        else debate_summary_jobs.next_retry_at
      end,
      locked_by = case
        when ${Boolean(input.force)} then null
        when debate_summary_jobs.kind = 'facts_board' and debate_summary_jobs.status <> 'running' then null
        else debate_summary_jobs.locked_by
      end,
      locked_at = case
        when ${Boolean(input.force)} then null
        when debate_summary_jobs.kind = 'facts_board' and debate_summary_jobs.status <> 'running' then null
        else debate_summary_jobs.locked_at
      end,
      completed_at = case
        when ${Boolean(input.force)} then null
        when debate_summary_jobs.kind = 'facts_board' and debate_summary_jobs.status <> 'running' then null
        else debate_summary_jobs.completed_at
      end,
      updated_at = ${now}
    returning *
  `.compile(db));
  const record = normalizeSummaryJobRow(result.rows[0]);
  await notifySummaryWorkerQueueChanged(input.debateId).catch(() => null);
  return record;
}

export async function scheduleDebateSummaryJobRetry(input: {
  id: string;
  attemptCount: number;
  errorMessage: string;
}) {
  const nextAttemptCount = input.attemptCount + 1;
  const nextRetryAt = new Date(Date.now() + getSummaryJobRetryDelayMs(nextAttemptCount)).toISOString();
  const nextStatus: DebateSummaryJobStatus = nextAttemptCount >= 8 ? "dead_letter" : "retry_wait";
  const db = await ensureDb();
  const now = new Date().toISOString();
  const result = await db.executeQuery<SummaryJobRow>(sql`
    update debate_summary_jobs
       set status = ${nextStatus},
           attempt_count = ${nextAttemptCount},
           last_error = ${input.errorMessage.slice(0, 600)},
           next_retry_at = ${nextStatus === "retry_wait" ? nextRetryAt : null},
           locked_by = null,
           locked_at = null,
           updated_at = ${now},
           completed_at = case when ${nextStatus} = 'dead_letter' then completed_at else null end
     where id = ${input.id}
     returning *
  `.compile(db));
  return normalizeSummaryJobRow(result.rows[0]);
}

export async function completeDebateSummaryJob(id: string) {
  const now = new Date().toISOString();
  const db = await ensureDb();
  const result = await db.executeQuery<SummaryJobRow>(sql`
    update debate_summary_jobs
       set status = case
             when kind = 'facts_board' and payload_json ? 'rerunRequestedAt' then 'queued'
             else 'completed'
           end,
           locked_by = null,
           locked_at = null,
           next_retry_at = null,
           payload_json = case
             when kind = 'facts_board' and payload_json ? 'rerunRequestedAt' then payload_json - 'rerunRequestedAt'
             else payload_json
           end,
           updated_at = ${now},
           completed_at = case
             when kind = 'facts_board' and payload_json ? 'rerunRequestedAt' then null
             else ${now}::timestamptz
           end
     where id = ${id}
     returning *
  `.compile(db));
  return normalizeSummaryJobRow(result.rows[0]);
}

export async function failDebateSummaryJob(id: string, errorMessage: string) {
  const now = new Date().toISOString();
  const db = await ensureDb();
  const result = await db.executeQuery<SummaryJobRow>(sql`
    update debate_summary_jobs
       set status = 'failed',
           last_error = ${errorMessage.slice(0, 600)},
           locked_by = null,
           locked_at = null,
           next_retry_at = null,
           updated_at = ${now}
     where id = ${id}
     returning *
  `.compile(db));
  return normalizeSummaryJobRow(result.rows[0]);
}

export async function recoverStaleDebateSummaryJobs() {
  const now = new Date().toISOString();
  const db = await ensureDb();
  const result = await db.executeQuery<SummaryJobRow>(sql`
    update debate_summary_jobs
       set status = 'queued',
           locked_by = null,
           locked_at = null,
           updated_at = ${now},
           last_error = coalesce(last_error, 'stale_running_recovered')
     where status = 'running'
       and locked_at is not null
       and locked_at < now() - interval '5 minutes'
     returning *
  `.compile(db));
  return result.rows.map(normalizeSummaryJobRow);
}

export async function heartbeatRunningSummaryJobLock(input: { jobId: string; workerId: string }) {
  const db = await ensureDb();
  const result = await db.executeQuery<{ id: string }>(sql`
    update debate_summary_jobs
       set locked_at = now(),
           updated_at = now()
     where id = ${input.jobId}
       and locked_by = ${input.workerId}
       and status = 'running'
     returning id
  `.compile(db));
  return result.rows.length > 0;
}

export async function markBlockedDebateSummaryJob(id: string, reason: string) {
  const now = new Date().toISOString();
  const db = await ensureDb();
  const result = await db.executeQuery<SummaryJobRow>(sql`
    update debate_summary_jobs
       set status = 'blocked',
           last_error = ${reason.slice(0, 600)},
           locked_by = null,
           locked_at = null,
           updated_at = ${now}
     where id = ${id}
     returning *
  `.compile(db));
  return normalizeSummaryJobRow(result.rows[0]);
}

export async function retryFailedDebateSummaryJobs(debateId: string) {
  const now = new Date().toISOString();
  const db = await ensureDb();
  const result = await db.executeQuery<SummaryJobRow>(sql`
    update debate_summary_jobs
       set status = 'queued',
           next_retry_at = null,
           locked_by = null,
           locked_at = null,
           updated_at = ${now}
     where debate_id = ${debateId}
       and status in ('failed', 'dead_letter')
     returning *
  `.compile(db));
  return result.rows.map(normalizeSummaryJobRow);
}

export async function claimRunnableDebateSummaryJobs(input: {
  workerId: string;
  limit: number;
  maxConcurrentPerDebate?: number;
}) {
  const db = await ensureDb();
  return await db.transaction().execute(async (trx) => {
    const result = await trx.executeQuery<SummaryJobRow>(sql`
      with candidates as (
        select j.id
          from debate_summary_jobs j
          left join debates d on d.id = j.debate_id
         where (
           (j.status = 'queued' and (j.run_after is null or j.run_after <= now()))
           or (j.status = 'retry_wait' and (j.next_retry_at is null or j.next_retry_at <= now()))
           or (j.status = 'blocked' and j.updated_at < now() - interval '30 seconds')
           or (j.status = 'running' and j.locked_at is not null and j.locked_at < now() - interval '5 minutes')
         )
           and not exists (
             select 1
               from jsonb_array_elements_text(coalesce(j.depends_on_keys, '[]'::jsonb)) dep(job_key)
               left join debate_summary_jobs d
                 on d.debate_id = j.debate_id
                and d.job_key = dep.job_key
              where d.id is null or d.status <> 'completed'
           )
           and (
             select count(*)
               from debate_summary_jobs r
              where r.debate_id = j.debate_id
                and r.status = 'running'
                and r.id <> j.id
                and (r.locked_at is null or r.locked_at >= now() - interval '5 minutes')
           ) < ${Math.max(1, input.maxConcurrentPerDebate ?? 1)}
         order by
           case
             when d.status = 'running' then 0
             when d.status = 'paused' then 1
             when d.status = 'pending' then 2
             else 3
           end,
           case j.status
             when 'queued' then 0
             when 'retry_wait' then 1
             when 'running' then 2
             else 3
           end,
           j.priority asc,
           case j.kind
             when 'turn_summary' then 1
             when 'round_summary' then 2
             else 3
           end,
           coalesce(j.round_number, 0) asc,
           coalesce(j.turn_number, 0) asc,
           j.created_at asc
         limit ${Math.max(1, input.limit)}
         for update of j skip locked
      )
      update debate_summary_jobs j
         set status = 'running',
             locked_by = ${input.workerId},
             locked_at = now(),
             updated_at = now()
        from candidates c
       where j.id = c.id
       returning j.*
    `.compile(trx));
    return result.rows.map(normalizeSummaryJobRow);
  });
}

export async function coalesceActiveFactsBoardJobs(debateId?: string | null) {
  const db = await ensureDb();
  const legacy = await db.executeQuery<SummaryJobRow>(sql`
    select *
      from debate_summary_jobs
     where kind = 'facts_board'
       and job_key <> ${FACTS_BOARD_JOB_KEY}
       and status in ('queued', 'retry_wait', 'blocked')
       and (${debateId ?? null}::uuid is null or debate_id = ${debateId ?? null}::uuid)
     order by debate_id asc, updated_at desc, created_at desc
  `.compile(db));

  const latestByDebateId = new Map<string, DebateSummaryJobRecord>();
  for (const row of legacy.rows.map(normalizeSummaryJobRow)) {
    if (!latestByDebateId.has(row.debateId)) latestByDebateId.set(row.debateId, row);
  }

  for (const latest of latestByDebateId.values()) {
    // eslint-disable-next-line no-await-in-loop
    await enqueueDebateSummaryJob({
      debateId: latest.debateId,
      kind: "facts_board",
      jobKey: FACTS_BOARD_JOB_KEY,
      turnNumber: latest.turnNumber,
      roundNumber: latest.roundNumber,
      payload: {
        ...latest.payload,
        coalescedFromJobKey: latest.jobKey,
        coalescedAt: new Date().toISOString()
      },
      priority: latest.priority,
      runAfter: new Date().toISOString()
    });
  }

  if (legacy.rows.length > 0) {
    await db.executeQuery(sql`
      delete from debate_summary_jobs
       where kind = 'facts_board'
         and job_key <> ${FACTS_BOARD_JOB_KEY}
         and status in ('queued', 'retry_wait', 'blocked')
         and (${debateId ?? null}::uuid is null or debate_id = ${debateId ?? null}::uuid)
    `.compile(db));
  }

  return { debates: latestByDebateId.size, removed: legacy.rows.length };
}

export async function upsertSummaryWorkerHeartbeat(input: {
  workerId: string;
  mode: string;
  status?: "running" | "idle" | "stopped";
  currentJob?: Pick<DebateSummaryJobRecord, "id" | "debateId" | "jobKey"> | null;
  claimedDelta?: number;
  completedDelta?: number;
  failedDelta?: number;
}) {
  const now = new Date().toISOString();
  const db = await ensureDb();
  const result = await db.executeQuery<SummaryWorkerRow>(sql`
    insert into debate_summary_workers (
      id,
      mode,
      status,
      started_at,
      last_heartbeat_at,
      current_job_id,
      current_debate_id,
      current_job_key,
      claimed_count,
      completed_count,
      failed_count,
      updated_at
    )
    values (
      ${input.workerId},
      ${input.mode},
      ${input.status ?? "running"},
      ${now},
      ${now},
      ${input.currentJob?.id ?? null},
      ${input.currentJob?.debateId ?? null},
      ${input.currentJob?.jobKey ?? null},
      ${input.claimedDelta ?? 0},
      ${input.completedDelta ?? 0},
      ${input.failedDelta ?? 0},
      ${now}
    )
    on conflict (id) do update
    set mode = excluded.mode,
        status = excluded.status,
        last_heartbeat_at = excluded.last_heartbeat_at,
        current_job_id = excluded.current_job_id,
        current_debate_id = excluded.current_debate_id,
        current_job_key = excluded.current_job_key,
        claimed_count = debate_summary_workers.claimed_count + excluded.claimed_count,
        completed_count = debate_summary_workers.completed_count + excluded.completed_count,
        failed_count = debate_summary_workers.failed_count + excluded.failed_count,
        updated_at = excluded.updated_at
    returning *
  `.compile(db));
  return normalizeSummaryWorkerRow(result.rows[0]);
}

export async function markSummaryWorkerStopped(workerId: string) {
  const now = new Date().toISOString();
  const db = await ensureDb();
  const result = await db.executeQuery<SummaryWorkerRow>(sql`
    update debate_summary_workers
       set status = 'stopped',
           current_job_id = null,
           current_debate_id = null,
           current_job_key = null,
           updated_at = ${now}
     where id = ${workerId}
     returning *
  `.compile(db));
  return result.rows[0] ? normalizeSummaryWorkerRow(result.rows[0]) : null;
}

export async function getSummaryWorkerHealthSnapshot() {
  const db = await ensureDb();
  const workersResult = await db.executeQuery<SummaryWorkerRow>(sql`
    select *
      from debate_summary_workers
     order by last_heartbeat_at desc
     limit 10
  `.compile(db));
  const statsResult = await db.executeQuery<{ kind: DebateSummaryJobKind; status: DebateSummaryJobStatus; count: number }>(sql`
    select kind, status, count(*)::int as count
      from debate_summary_jobs
     group by kind, status
     order by kind asc, status asc
  `.compile(db));
  return {
    workers: workersResult.rows.map(normalizeSummaryWorkerRow),
    queue: statsResult.rows.map((row) => ({
      kind: row.kind,
      status: row.status,
      count: Number(row.count ?? 0)
    } satisfies DebateSummaryQueueStat))
  };
}
