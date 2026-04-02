import { randomUUID } from "crypto";

import { ensureDbReady, query } from "@/lib/db";

export type DebateSummaryJobKind = "turn_summary" | "round_summary" | "facts_board";

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
  attempt_count: number;
  last_error: string | null;
  next_retry_at: string | null;
  locked_by: string | null;
  locked_at: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
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

export function getSummaryJobRetryDelayMs(attemptCount: number) {
  if (attemptCount <= 1) return 30_000;
  if (attemptCount === 2) return 2 * 60_000;
  if (attemptCount === 3) return 10 * 60_000;
  if (attemptCount === 4) return 30 * 60_000;
  return 2 * 60 * 60_000;
}

export async function listDebateSummaryJobs(debateId: string) {
  const result = await query<SummaryJobRow>(
    `
      select *
        from debate_summary_jobs
       where debate_id = $1
       order by
         case kind
           when 'turn_summary' then 1
           when 'round_summary' then 2
           else 3
         end,
         coalesce(round_number, 0) asc,
         coalesce(turn_number, 0) asc,
         created_at asc
    `,
    [debateId]
  );
  return result.rows.map(normalizeSummaryJobRow);
}

export async function listActiveDebateSummaryJobs(debateId: string) {
  const result = await query<SummaryJobRow>(
    `
      select *
        from debate_summary_jobs
       where debate_id = $1
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
    `,
    [debateId]
  );
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
  const result = await query<SummaryJobRow>(
    `select * from debate_summary_jobs where debate_id = $1 and job_key = $2 limit 1`,
    [debateId, jobKey]
  );
  if ((result.rowCount ?? 0) !== 1) return null;
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
  force?: boolean;
}) {
  const now = new Date().toISOString();
  const payloadJson = JSON.stringify(input.payload ?? {});
  const dependsOnJson = JSON.stringify(input.dependsOnKeys ?? []);
  const status = input.status ?? "queued";

  const result = await query<SummaryJobRow>(
    `
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
        $1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,0,null,null,null,null,$10,$10,null
      )
      on conflict (debate_id, job_key) do update
      set
        kind = excluded.kind,
        turn_number = excluded.turn_number,
        round_number = excluded.round_number,
        depends_on_keys = excluded.depends_on_keys,
        payload_json = case
          when $11 then excluded.payload_json
          when debate_summary_jobs.kind = 'facts_board'
            then excluded.payload_json
          else debate_summary_jobs.payload_json
        end,
        status = case
          when $11 then excluded.status
          when debate_summary_jobs.kind = 'facts_board'
               and debate_summary_jobs.status = 'running'
            then debate_summary_jobs.status
          when debate_summary_jobs.kind = 'facts_board'
            then excluded.status
          when debate_summary_jobs.status = 'completed' and not $11 then debate_summary_jobs.status
          else debate_summary_jobs.status
        end,
        attempt_count = case
          when $11 then 0
          when debate_summary_jobs.kind = 'facts_board' and debate_summary_jobs.status <> 'running' then 0
          else debate_summary_jobs.attempt_count
        end,
        last_error = case
          when $11 then null
          when debate_summary_jobs.kind = 'facts_board' and debate_summary_jobs.status <> 'running' then null
          else debate_summary_jobs.last_error
        end,
        next_retry_at = case
          when $11 then null
          when debate_summary_jobs.kind = 'facts_board' and debate_summary_jobs.status <> 'running' then null
          else debate_summary_jobs.next_retry_at
        end,
        locked_by = case
          when $11 then null
          when debate_summary_jobs.kind = 'facts_board' and debate_summary_jobs.status <> 'running' then null
          else debate_summary_jobs.locked_by
        end,
        locked_at = case
          when $11 then null
          when debate_summary_jobs.kind = 'facts_board' and debate_summary_jobs.status <> 'running' then null
          else debate_summary_jobs.locked_at
        end,
        completed_at = case
          when $11 then null
          when debate_summary_jobs.kind = 'facts_board' and debate_summary_jobs.status <> 'running' then null
          else debate_summary_jobs.completed_at
        end,
        updated_at = $10
      returning *
    `,
    [
      randomUUID(),
      input.debateId,
      input.kind,
      status,
      input.jobKey,
      input.turnNumber ?? null,
      input.roundNumber ?? null,
      dependsOnJson,
      payloadJson,
      now,
      Boolean(input.force)
    ]
  );
  return normalizeSummaryJobRow(result.rows[0]);
}

export async function scheduleDebateSummaryJobRetry(input: {
  id: string;
  attemptCount: number;
  errorMessage: string;
}) {
  const nextAttemptCount = input.attemptCount + 1;
  const nextRetryAt = new Date(Date.now() + getSummaryJobRetryDelayMs(nextAttemptCount)).toISOString();
  const nextStatus: DebateSummaryJobStatus = nextAttemptCount >= 8 ? "dead_letter" : "retry_wait";
  const result = await query<SummaryJobRow>(
    `
      update debate_summary_jobs
         set status = $2,
             attempt_count = $3,
             last_error = $4,
             next_retry_at = $5,
             locked_by = null,
             locked_at = null,
             updated_at = $6,
             completed_at = case when $2 = 'dead_letter' then completed_at else null end
       where id = $1
       returning *
    `,
    [input.id, nextStatus, nextAttemptCount, input.errorMessage.slice(0, 600), nextStatus === "retry_wait" ? nextRetryAt : null, new Date().toISOString()]
  );
  return normalizeSummaryJobRow(result.rows[0]);
}

export async function completeDebateSummaryJob(id: string) {
  const now = new Date().toISOString();
  const result = await query<SummaryJobRow>(
    `
      update debate_summary_jobs
         set status = 'completed',
             locked_by = null,
             locked_at = null,
             next_retry_at = null,
             updated_at = $2,
             completed_at = $2
       where id = $1
       returning *
    `,
    [id, now]
  );
  return normalizeSummaryJobRow(result.rows[0]);
}

export async function failDebateSummaryJob(id: string, errorMessage: string) {
  const now = new Date().toISOString();
  const result = await query<SummaryJobRow>(
    `
      update debate_summary_jobs
         set status = 'failed',
             last_error = $2,
             locked_by = null,
             locked_at = null,
             next_retry_at = null,
             updated_at = $3
       where id = $1
       returning *
    `,
    [id, errorMessage.slice(0, 600), now]
  );
  return normalizeSummaryJobRow(result.rows[0]);
}

export async function recoverStaleDebateSummaryJobs() {
  const now = new Date().toISOString();
  const result = await query<SummaryJobRow>(
    `
      update debate_summary_jobs
         set status = 'queued',
             locked_by = null,
             locked_at = null,
             updated_at = $1,
             last_error = coalesce(last_error, 'stale_running_recovered')
       where status = 'running'
         and locked_at is not null
         and locked_at < now() - interval '5 minutes'
       returning *
    `,
    [now]
  );
  return result.rows.map(normalizeSummaryJobRow);
}

export async function markBlockedDebateSummaryJob(id: string, reason: string) {
  const now = new Date().toISOString();
  const result = await query<SummaryJobRow>(
    `
      update debate_summary_jobs
         set status = 'blocked',
             last_error = $2,
             locked_by = null,
             locked_at = null,
             updated_at = $3
       where id = $1
       returning *
    `,
    [id, reason.slice(0, 600), now]
  );
  return normalizeSummaryJobRow(result.rows[0]);
}

export async function retryFailedDebateSummaryJobs(debateId: string) {
  const now = new Date().toISOString();
  const result = await query<SummaryJobRow>(
    `
      update debate_summary_jobs
         set status = 'queued',
             next_retry_at = null,
             locked_by = null,
             locked_at = null,
             updated_at = $2
       where debate_id = $1
         and status in ('failed', 'dead_letter')
       returning *
    `,
    [debateId, now]
  );
  return result.rows.map(normalizeSummaryJobRow);
}

export async function claimRunnableDebateSummaryJobs(input: {
  workerId: string;
  limit: number;
  maxConcurrentPerDebate?: number;
}) {
  const pool = await ensureDbReady();
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await client.query<SummaryJobRow>(
      `
        with candidates as (
          select j.id
            from debate_summary_jobs j
           where (
             j.status = 'queued'
             or (j.status = 'retry_wait' and (j.next_retry_at is null or j.next_retry_at <= now()))
             or (j.status = 'blocked')
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
             ) < $1
           order by
             case j.kind
               when 'turn_summary' then 1
               when 'round_summary' then 2
               else 3
             end,
             coalesce(j.round_number, 0) asc,
             coalesce(j.turn_number, 0) asc,
             j.created_at asc
           limit $2
           for update skip locked
        )
        update debate_summary_jobs j
           set status = 'running',
               locked_by = $3,
               locked_at = now(),
               updated_at = now()
          from candidates c
         where j.id = c.id
         returning j.*
      `,
      [Math.max(1, input.maxConcurrentPerDebate ?? 1), Math.max(1, input.limit), input.workerId]
    );
    await client.query("commit");
    return result.rows.map(normalizeSummaryJobRow);
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
