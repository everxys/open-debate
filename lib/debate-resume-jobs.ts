import { randomUUID } from "crypto";

import { sql } from "kysely";

import { ensureDb } from "@/lib/db";
import { createServerLogger } from "@/lib/logger/server";
import { getQuotaProfileSummaryForSystem } from "@/lib/quota-control";

const quotaResumeLogger = createServerLogger("quota-resume");
const RESUME_JOB_STALE_AFTER_MS = 120_000;

type Row = Record<string, unknown>;

type ResumeJobRecord = {
  id: string;
  debateId: string;
  profileId: string;
  resumeAt: string;
  reason: string;
  status: string;
  lockedBy: string | null;
  lockedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

function parseNullableString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function parseResumeJobRow(row: Row): ResumeJobRecord {
  return {
    id: String(row.id),
    debateId: String(row.debate_id),
    profileId: String(row.profile_id),
    resumeAt: String(row.resume_at),
    reason: String(row.reason ?? "quota_wait"),
    status: String(row.status ?? "pending"),
    lockedBy: parseNullableString(row.locked_by),
    lockedAt: parseNullableString(row.locked_at),
    lastError: parseNullableString(row.last_error),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    completedAt: parseNullableString(row.completed_at)
  };
}

export function buildQuotaWaitNoticeMessage(profileName: string, resumeAt: string, timeZone = "Asia/Shanghai") {
  const date = new Date(resumeAt);
  const formatted = Number.isNaN(date.getTime())
    ? resumeAt
    : date.toLocaleString("zh-CN", { hour12: false, timeZone });
  return `因 Coding Plan 限额控制已暂停，将于 ${formatted} 自动恢复（${profileName}）`;
}

export async function enqueueDebateResumeJob(input: {
  debateId: string;
  profileId: string;
  resumeAt: string;
  reason?: string;
}) {
  const db = await ensureDb();
  const now = new Date().toISOString();
  return db.transaction().execute(async (trx) => {
    const existing = await trx.executeQuery<Row>(sql`
      select *
        from debate_resume_jobs
       where debate_id = ${input.debateId}
         and status = 'pending'
       order by created_at desc
       limit 1
       for update
    `.compile(trx));
    if (existing.rows[0]) {
      const updated = await trx.executeQuery<Row>(sql`
        update debate_resume_jobs
           set profile_id = ${input.profileId},
               resume_at = ${input.resumeAt},
               reason = ${input.reason ?? "quota_wait"},
               last_error = null,
               updated_at = ${now}
         where id = ${String(existing.rows[0].id)}
         returning *
      `.compile(trx));
      return parseResumeJobRow(updated.rows[0]);
    }

    const inserted = await trx.executeQuery<Row>(sql`
      insert into debate_resume_jobs (
        id,
        debate_id,
        profile_id,
        resume_at,
        reason,
        status,
        locked_by,
        locked_at,
        last_error,
        created_at,
        updated_at,
        completed_at
      )
      values (
        ${randomUUID()},
        ${input.debateId},
        ${input.profileId},
        ${input.resumeAt},
        ${input.reason ?? "quota_wait"},
        'pending',
        null,
        null,
        null,
        ${now},
        ${now},
        null
      )
      returning *
    `.compile(trx));
    return parseResumeJobRow(inserted.rows[0]);
  });
}

export async function pauseDebateForQuotaWait(input: {
  debateId: string;
  profileId: string;
  profileName: string;
  resumeAt: string;
  timeZone?: string | null;
  phase?: {
    workflowPhaseKind: string | null;
    workflowPhaseTitle: string | null;
    workflowPhaseRound: number | null;
  } | null;
}) {
  const db = await ensureDb();
  const now = new Date().toISOString();
  const message = buildQuotaWaitNoticeMessage(input.profileName, input.resumeAt, input.timeZone ?? undefined);
  await db.executeQuery(sql`
    update debates
       set status = case
             when status = 'running' then 'paused'
             else status
           end,
           stopped_reason = ${"quota_wait"},
           workflow_phase_kind = ${input.phase?.workflowPhaseKind ?? null},
           workflow_phase_title = ${input.phase?.workflowPhaseTitle ?? null},
           workflow_phase_round = ${input.phase?.workflowPhaseRound ?? null},
           runtime_notice_kind = ${"quota_wait"},
           runtime_notice_message = ${message},
           runtime_notice_at = ${now},
           updated_at = ${now}
     where id = ${input.debateId}
  `.compile(db));
  await enqueueDebateResumeJob({
    debateId: input.debateId,
    profileId: input.profileId,
    resumeAt: input.resumeAt,
    reason: "quota_wait"
  });
  quotaResumeLogger.info("quota.pause_debate", {
    debateId: input.debateId,
    profileId: input.profileId,
    profileName: input.profileName,
    nextAvailableAt: input.resumeAt
  });
}

async function rescheduleResumeJob(jobId: string, resumeAt: string, lastError?: string | null) {
  const db = await ensureDb();
  const result = await db.executeQuery<Row>(sql`
    update debate_resume_jobs
       set status = 'pending',
           resume_at = ${resumeAt},
           locked_by = null,
           locked_at = null,
           last_error = ${lastError ?? null},
           updated_at = ${new Date().toISOString()}
     where id = ${jobId}
     returning *
  `.compile(db));
  return parseResumeJobRow(result.rows[0]);
}

async function completeResumeJob(jobId: string) {
  const db = await ensureDb();
  const now = new Date().toISOString();
  await db.executeQuery(sql`
    update debate_resume_jobs
       set status = 'completed',
           locked_by = null,
           locked_at = null,
           updated_at = ${now},
           completed_at = ${now}
     where id = ${jobId}
  `.compile(db));
}

async function failResumeJob(jobId: string, lastError: string) {
  const db = await ensureDb();
  await db.executeQuery(sql`
    update debate_resume_jobs
       set status = 'failed',
           locked_by = null,
           locked_at = null,
           last_error = ${lastError.slice(0, 600)},
           updated_at = ${new Date().toISOString()}
     where id = ${jobId}
  `.compile(db));
}

async function claimDueResumeJobs(workerId: string, limit: number) {
  const db = await ensureDb();
  const staleSeconds = Math.ceil(RESUME_JOB_STALE_AFTER_MS / 1000);
  const result = await db.executeQuery<Row>(sql`
    with candidates as (
      select j.id
        from debate_resume_jobs j
       where (
         (j.status = 'pending' and j.resume_at <= now())
         or (
           j.status = 'running'
           and (
             j.locked_at is null
             or j.locked_at < now() - (${staleSeconds} * interval '1 second')
           )
         )
       )
       order by j.resume_at asc, j.created_at asc
       limit ${Math.max(1, limit)}
       for update skip locked
    )
    update debate_resume_jobs j
       set status = 'running',
           locked_by = ${workerId},
           locked_at = now(),
           updated_at = now()
      from candidates
     where j.id = candidates.id
     returning j.*
  `.compile(db));
  return result.rows.map((row) => parseResumeJobRow(row));
}

export async function processDueDebateResumeJobs(input: { workerId: string; limit?: number }) {
  const claimed = await claimDueResumeJobs(input.workerId, input.limit ?? 4);
  for (const job of claimed) {
    try {
      const db = await ensureDb();
      const debateResult = await db.executeQuery<Row>(sql`
        select id, user_id, status
          from debates
         where id = ${job.debateId}
         limit 1
      `.compile(db));
      const debateRow = debateResult.rows[0];
      if (!debateRow) {
        await completeResumeJob(job.id);
        continue;
      }
      const debateStatus = String(debateRow.status ?? "");
      if (debateStatus !== "paused") {
        await completeResumeJob(job.id);
        continue;
      }

      const { profile, summary } = await getQuotaProfileSummaryForSystem(job.profileId);
      if (summary.nextAvailableAt) {
        await db.executeQuery(sql`
          update debates
             set runtime_notice_kind = ${"quota_wait"},
                 runtime_notice_message = ${buildQuotaWaitNoticeMessage(
                   profile.name,
                   summary.nextAvailableAt,
                   profile.resetTimezone
                 )},
                 runtime_notice_at = ${new Date().toISOString()},
                 updated_at = ${new Date().toISOString()}
           where id = ${job.debateId}
        `.compile(db));
        await rescheduleResumeJob(job.id, summary.nextAvailableAt, summary.blockingReason ?? "quota_wait");
        continue;
      }

      const now = new Date().toISOString();
      const resumed = await db.executeQuery<Row>(sql`
        update debates
           set status = 'running',
               runtime_notice_kind = null,
               runtime_notice_message = null,
               runtime_notice_at = null,
               ignored_runtime_error_signature = null,
               ignored_runtime_error_at = null,
               updated_at = ${now}
         where id = ${job.debateId}
           and status = 'paused'
         returning user_id
      `.compile(db));
      if (!resumed.rows[0]) {
        await completeResumeJob(job.id);
        continue;
      }

      await completeResumeJob(job.id);
      quotaResumeLogger.info("quota.resume_debate", {
        debateId: job.debateId,
        profileId: profile.id,
        profileName: profile.name,
        used5h: summary.used5h,
        usedWeek: summary.usedWeek,
        usedMonth: summary.usedMonth,
        nextAvailableAt: summary.nextAvailableAt,
        reason: summary.blockingReason
      });

      const userId = String(resumed.rows[0].user_id);
      const { runDebate } = await import("@/lib/runtime");
      void runDebate(job.debateId, userId).catch((error) => {
        quotaResumeLogger.error("quota resume launch failed", {
          debateId: job.debateId,
          profileId: profile.id,
          error
        });
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await failResumeJob(job.id, message);
      quotaResumeLogger.error("quota resume job failed", {
        debateId: job.debateId,
        profileId: job.profileId,
        error
      });
    }
  }
  return claimed;
}
