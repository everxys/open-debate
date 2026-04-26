import { randomUUID } from "crypto";

import { sql, type Kysely } from "kysely";

import { requireSessionUser } from "@/lib/auth";
import type { OpenDebateDb } from "@/lib/db-schema";
import { ensureDb } from "@/lib/db";
import { AppError } from "@/lib/http";
import { createServerLogger } from "@/lib/logger/server";
import { normalizeNullableTimestampString, normalizeTimestampString } from "@/lib/timestamps";
import type {
  AgentUsageControlMode,
  QuotaPacingMode,
  QuotaProfileRecord,
  QuotaProfileSummary,
  QuotaWindowType
} from "@/lib/types";
import {
  adjustQuotaProfileSchema,
  createQuotaProfileSchema,
  updateQuotaProfileSchema
} from "@/lib/validation";

const quotaLogger = createServerLogger("quota");

export const DEFAULT_QUOTA_RESET_TIMEZONE = "Asia/Shanghai";
export const QUOTA_INLINE_WAIT_MAX_MS = 60_000;

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const DEFAULT_REQUEST_LIMIT = 1;
const WAIT_JITTER_MS = 25;

type Row = Record<string, unknown>;

type QuotaWindowUsageSnapshot = {
  id: string | null;
  windowType: QuotaWindowType;
  windowStartAt: string | null;
  windowEndAt: string | null;
  internalRequestCount: number;
  manualAdjustmentCount: number;
};

type QuotaWindowCollection = {
  rolling5h: QuotaWindowUsageSnapshot;
  week: QuotaWindowUsageSnapshot;
  month: QuotaWindowUsageSnapshot;
};

type QuotaBlockingReason = QuotaProfileSummary["blockingReason"];

export type QuotaProfileView = QuotaProfileRecord & {
  summary: QuotaProfileSummary;
  referencedAgentCount: number;
};

export type QuotaReservationInput = {
  userId: string;
  usageControlMode?: AgentUsageControlMode | null;
  quotaProfileId?: string | null;
  requestKind: string;
  agentId?: string | null;
  agentName?: string | null;
  debateId?: string | null;
  debateAgentId?: string | null;
};

type QuotaReservationSkipped = {
  kind: "skipped";
};

type QuotaReservationGranted = {
  kind: "granted";
  profile: QuotaProfileRecord;
  summary: QuotaProfileSummary;
};

export type QuotaReservationWait = {
  kind: "wait";
  profile: QuotaProfileRecord;
  summary: QuotaProfileSummary;
  waitMs: number;
  nextAvailableAt: string;
  reason: QuotaBlockingReason;
};

export type QuotaReservationDecision = QuotaReservationSkipped | QuotaReservationGranted | QuotaReservationWait;

type QuotaEvaluation = {
  used5h: number;
  usedWeek: number;
  usedMonth: number;
  nextAvailableAt: string | null;
  blockingReason: QuotaBlockingReason;
  nextIntervalMs: number;
  pacingTarget5h: number;
  summary: QuotaProfileSummary;
};

type ZonedDateTimeParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
};

export class QuotaDelayError extends Error {
  constructor(public readonly wait: QuotaReservationWait) {
    super(
      `Coding Plan "${wait.profile.name}" is throttled until ${formatQuotaDateTime(wait.nextAvailableAt, wait.profile.resetTimezone)}`
    );
    this.name = "QuotaDelayError";
  }
}

function parseNullableString(value: unknown) {
  const normalized = normalizeNullableTimestampString(value);
  return typeof normalized === "string" && normalized.trim().length > 0 ? normalized : null;
}

function parseNullableInt(value: unknown) {
  if (value === null || value === undefined) return null;
  const num = Number(value);
  return Number.isFinite(num) ? Math.trunc(num) : null;
}

function parseRequiredInt(value: unknown) {
  const parsed = parseNullableInt(value);
  return parsed === null ? 0 : parsed;
}

function parseQuotaProfileRow(row: Row): QuotaProfileRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    name: String(row.name),
    profileType: (row.profile_type as QuotaProfileRecord["profileType"]) ?? "coding_plan",
    requestLimit5h: parseRequiredInt(row.request_limit_5h),
    requestLimitWeek: parseRequiredInt(row.request_limit_week),
    requestLimitMonth: parseRequiredInt(row.request_limit_month),
    pacingMode: (row.pacing_mode as QuotaPacingMode) ?? "percent",
    pacingValue: parseRequiredInt(row.pacing_value),
    resetTimezone: String(row.reset_timezone ?? DEFAULT_QUOTA_RESET_TIMEZONE),
    nextRequestNotBeforeAt: parseNullableString(row.next_request_not_before_at),
    createdAt: normalizeTimestampString(row.created_at),
    updatedAt: normalizeTimestampString(row.updated_at),
    deletedAt: parseNullableString(row.deleted_at)
  };
}

function parseQuotaWindowRow(row: Row, windowType: QuotaWindowType): QuotaWindowUsageSnapshot {
  return {
    id: String(row.id),
    windowType,
    windowStartAt: parseNullableString(row.window_start_at),
    windowEndAt: parseNullableString(row.window_end_at),
    internalRequestCount: parseRequiredInt(row.internal_request_count),
    manualAdjustmentCount: parseRequiredInt(row.manual_adjustment_count)
  };
}

function isValidTimeZone(timeZone: string | null | undefined) {
  if (!timeZone || typeof timeZone !== "string") return false;
  try {
    Intl.DateTimeFormat("zh-CN", { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function normalizeTimeZone(timeZone: string | null | undefined) {
  return isValidTimeZone(timeZone) ? String(timeZone) : DEFAULT_QUOTA_RESET_TIMEZONE;
}

function getDateTimeFormatter(timeZone: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
    hour12: false
  });
}

function getZonedDateTimeParts(date: Date, timeZone: string): ZonedDateTimeParts {
  const formatter = getDateTimeFormatter(normalizeTimeZone(timeZone));
  const parts = formatter.formatToParts(date);
  const data = new Map(parts.map((part) => [part.type, part.value]));
  const weekdayRaw = data.get("weekday") ?? "Sun";
  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6
  };
  return {
    year: Number(data.get("year") ?? "0"),
    month: Number(data.get("month") ?? "1"),
    day: Number(data.get("day") ?? "1"),
    hour: Number(data.get("hour") ?? "0"),
    minute: Number(data.get("minute") ?? "0"),
    second: Number(data.get("second") ?? "0"),
    weekday: weekdayMap[weekdayRaw] ?? 0
  };
}

function getTimeZoneOffsetMs(date: Date, timeZone: string) {
  const parts = getZonedDateTimeParts(date, timeZone);
  const utcValue = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return utcValue - date.getTime();
}

function datePartsFromUtcTimestamp(timestamp: number) {
  const date = new Date(timestamp);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    second: date.getUTCSeconds()
  };
}

function zonedPartsToUtcDate(
  parts: { year: number; month: number; day: number; hour?: number; minute?: number; second?: number },
  timeZone: string
) {
  const normalizedTimeZone = normalizeTimeZone(timeZone);
  let timestamp = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour ?? 0,
    parts.minute ?? 0,
    parts.second ?? 0
  );
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const offset = getTimeZoneOffsetMs(new Date(timestamp), normalizedTimeZone);
    const next = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour ?? 0,
      parts.minute ?? 0,
      parts.second ?? 0
    ) - offset;
    if (next === timestamp) break;
    timestamp = next;
  }
  return new Date(timestamp);
}

function shiftUtcCalendarDays(input: { year: number; month: number; day: number }, deltaDays: number) {
  return datePartsFromUtcTimestamp(Date.UTC(input.year, input.month - 1, input.day + deltaDays, 0, 0, 0));
}

function shiftUtcCalendarMonths(input: { year: number; month: number; day: number }, deltaMonths: number) {
  return datePartsFromUtcTimestamp(Date.UTC(input.year, input.month - 1 + deltaMonths, input.day, 0, 0, 0));
}

function computeFixedWindowBounds(windowType: "week" | "month", now: Date, timeZone: string) {
  const zoned = getZonedDateTimeParts(now, timeZone);
  if (windowType === "week") {
    const mondayOffset = (zoned.weekday + 6) % 7;
    const weekStart = shiftUtcCalendarDays({ year: zoned.year, month: zoned.month, day: zoned.day }, -mondayOffset);
    const weekEnd = shiftUtcCalendarDays(
      { year: weekStart.year, month: weekStart.month, day: weekStart.day },
      7
    );
    return {
      startAt: zonedPartsToUtcDate({ ...weekStart, hour: 0, minute: 0, second: 0 }, timeZone).toISOString(),
      endAt: zonedPartsToUtcDate({ ...weekEnd, hour: 0, minute: 0, second: 0 }, timeZone).toISOString()
    };
  }

  const monthStart = { year: zoned.year, month: zoned.month, day: 1 };
  const nextMonth = shiftUtcCalendarMonths(monthStart, 1);
  return {
    startAt: zonedPartsToUtcDate({ ...monthStart, hour: 0, minute: 0, second: 0 }, timeZone).toISOString(),
    endAt: zonedPartsToUtcDate({ ...nextMonth, hour: 0, minute: 0, second: 0 }, timeZone).toISOString()
  };
}

function formatQuotaDateTime(value: string, timeZone: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { hour12: false, timeZone: normalizeTimeZone(timeZone) });
}

function getFutureCursor(value: string | null, nowMs: number) {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp) || timestamp <= nowMs + WAIT_JITTER_MS) {
    return null;
  }
  return value;
}

function getLaterIsoTimestamp(left: string | null, right: string | null) {
  if (!left) return right;
  if (!right) return left;
  const leftMs = new Date(left).getTime();
  const rightMs = new Date(right).getTime();
  if (Number.isNaN(leftMs)) return right;
  if (Number.isNaN(rightMs)) return left;
  return leftMs >= rightMs ? left : right;
}

function resolvePacingTarget5h(profile: QuotaProfileRecord) {
  const hardLimit = Math.max(DEFAULT_REQUEST_LIMIT, profile.requestLimit5h);
  if (profile.pacingMode === "absolute") {
    return Math.min(hardLimit, Math.max(DEFAULT_REQUEST_LIMIT, Math.trunc(profile.pacingValue)));
  }
  return Math.min(
    hardLimit,
    Math.max(DEFAULT_REQUEST_LIMIT, Math.floor((hardLimit * Math.max(DEFAULT_REQUEST_LIMIT, profile.pacingValue)) / 100))
  );
}

function getUsedRequests(window: QuotaWindowUsageSnapshot) {
  return Math.max(0, window.internalRequestCount + window.manualAdjustmentCount);
}

function getRemainingRequests(limit: number, used: number) {
  return Math.max(0, limit - used);
}

function buildQuotaEvaluation(profile: QuotaProfileRecord, windows: QuotaWindowCollection, now: Date): QuotaEvaluation {
  const nowMs = now.getTime();
  const pacingTarget5h = resolvePacingTarget5h(profile);
  const used5h = getUsedRequests(windows.rolling5h);
  const usedWeek = getUsedRequests(windows.week);
  const usedMonth = getUsedRequests(windows.month);

  let nextAllowedMs = nowMs;
  let blockingReason: QuotaBlockingReason = null;
  const considerWait = (candidate: string | null, reason: QuotaBlockingReason) => {
    if (!candidate) return;
    const candidateMs = new Date(candidate).getTime();
    if (Number.isNaN(candidateMs)) return;
    if (candidateMs > nextAllowedMs) {
      nextAllowedMs = candidateMs;
      blockingReason = reason;
    }
  };

  considerWait(profile.nextRequestNotBeforeAt, "pacing");
  if (used5h >= profile.requestLimit5h) {
    considerWait(windows.rolling5h.windowEndAt, "rolling_5h_limit");
  }
  if (usedWeek >= profile.requestLimitWeek) {
    considerWait(windows.week.windowEndAt, "week_limit");
  }
  if (usedMonth >= profile.requestLimitMonth) {
    considerWait(windows.month.windowEndAt, "month_limit");
  }

  const timeToWeekResetMs = Math.max(
    0,
    windows.week.windowEndAt ? new Date(windows.week.windowEndAt).getTime() - nowMs : 0
  );
  const timeToMonthResetMs = Math.max(
    0,
    windows.month.windowEndAt ? new Date(windows.month.windowEndAt).getTime() - nowMs : 0
  );

  const remainingWeekAfterGrant = profile.requestLimitWeek - (usedWeek + 1);
  const remainingMonthAfterGrant = profile.requestLimitMonth - (usedMonth + 1);
  const interval5hMs = Math.ceil(FIVE_HOURS_MS / pacingTarget5h);
  const intervalWeekMs =
    remainingWeekAfterGrant > 0 ? Math.ceil(timeToWeekResetMs / remainingWeekAfterGrant) : timeToWeekResetMs;
  const intervalMonthMs =
    remainingMonthAfterGrant > 0 ? Math.ceil(timeToMonthResetMs / remainingMonthAfterGrant) : timeToMonthResetMs;
  const nextIntervalMs = Math.max(interval5hMs, intervalWeekMs, intervalMonthMs, 0);

  const summary: QuotaProfileSummary = {
    profileId: profile.id,
    profileName: profile.name,
    limit5h: profile.requestLimit5h,
    used5h,
    remaining5h: getRemainingRequests(profile.requestLimit5h, used5h),
    window5hStartAt: windows.rolling5h.windowStartAt,
    window5hEndAt: windows.rolling5h.windowEndAt,
    limitWeek: profile.requestLimitWeek,
    usedWeek,
    remainingWeek: getRemainingRequests(profile.requestLimitWeek, usedWeek),
    weekWindowStartAt: String(windows.week.windowStartAt),
    weekWindowEndAt: String(windows.week.windowEndAt),
    limitMonth: profile.requestLimitMonth,
    usedMonth,
    remainingMonth: getRemainingRequests(profile.requestLimitMonth, usedMonth),
    monthWindowStartAt: String(windows.month.windowStartAt),
    monthWindowEndAt: String(windows.month.windowEndAt),
    pacingMode: profile.pacingMode,
    pacingValue: profile.pacingValue,
    pacingTarget5h,
    nextAvailableAt: nextAllowedMs > nowMs + WAIT_JITTER_MS ? new Date(nextAllowedMs).toISOString() : null,
    blockingReason,
    effectiveIntervalMs: nextIntervalMs
  };

  return {
    used5h,
    usedWeek,
    usedMonth,
    nextAvailableAt: summary.nextAvailableAt,
    blockingReason,
    nextIntervalMs,
    pacingTarget5h,
    summary
  };
}

async function loadQuotaProfileRowById(
  executor: Kysely<OpenDebateDb>,
  profileId: string,
  options?: { userId?: string | null; forUpdate?: boolean }
) {
  const result = await executor.executeQuery<Row>(sql`
    select *
      from ai_quota_profiles
     where id = ${profileId}
       and deleted_at is null
       and (${options?.userId ?? null}::uuid is null or user_id = ${options?.userId ?? null}::uuid)
     ${sql.raw(options?.forUpdate ? "for update" : "")}
  `.compile(executor));
  const row = result.rows[0];
  return row ? parseQuotaProfileRow(row) : null;
}

async function loadRollingWindow(
  executor: Kysely<OpenDebateDb>,
  profileId: string,
  now: Date,
  options?: { forUpdate?: boolean; createIfMissing?: boolean }
) {
  const nowIso = now.toISOString();
  const result = await executor.executeQuery<Row>(sql`
    select *
      from ai_quota_window_usage
     where profile_id = ${profileId}
       and window_type = ${"rolling_5h"}
       and window_end_at > ${nowIso}
     order by window_start_at desc
     limit 1
     ${sql.raw(options?.forUpdate ? "for update" : "")}
  `.compile(executor));
  const existing = result.rows[0] ? parseQuotaWindowRow(result.rows[0], "rolling_5h") : null;
  if (existing || !options?.createIfMissing) {
    return existing ?? {
      id: null,
      windowType: "rolling_5h" as const,
      windowStartAt: null,
      windowEndAt: null,
      internalRequestCount: 0,
      manualAdjustmentCount: 0
    };
  }

  const createdAt = new Date(now.getTime() + FIVE_HOURS_MS).toISOString();
  const inserted = await executor.executeQuery<Row>(sql`
    insert into ai_quota_window_usage (
      id,
      profile_id,
      window_type,
      window_start_at,
      window_end_at,
      internal_request_count,
      manual_adjustment_count,
      created_at,
      updated_at
    )
    values (
      ${randomUUID()},
      ${profileId},
      ${"rolling_5h"},
      ${nowIso},
      ${createdAt},
      0,
      0,
      ${nowIso},
      ${nowIso}
    )
    returning *
  `.compile(executor));
  return parseQuotaWindowRow(inserted.rows[0], "rolling_5h");
}

async function loadFixedWindow(
  executor: Kysely<OpenDebateDb>,
  profileId: string,
  windowType: "week" | "month",
  bounds: { startAt: string; endAt: string },
  options?: { forUpdate?: boolean; createIfMissing?: boolean }
) {
  if (options?.createIfMissing) {
    await executor.executeQuery(sql`
      insert into ai_quota_window_usage (
        id,
        profile_id,
        window_type,
        window_start_at,
        window_end_at,
        internal_request_count,
        manual_adjustment_count,
        created_at,
        updated_at
      )
      values (
        ${randomUUID()},
        ${profileId},
        ${windowType},
        ${bounds.startAt},
        ${bounds.endAt},
        0,
        0,
        ${new Date().toISOString()},
        ${new Date().toISOString()}
      )
      on conflict (profile_id, window_type, window_start_at) do nothing
    `.compile(executor));
  }

  const result = await executor.executeQuery<Row>(sql`
    select *
      from ai_quota_window_usage
     where profile_id = ${profileId}
       and window_type = ${windowType}
       and window_start_at = ${bounds.startAt}
     limit 1
     ${sql.raw(options?.forUpdate ? "for update" : "")}
  `.compile(executor));
  const row = result.rows[0];
  return row
    ? parseQuotaWindowRow(row, windowType)
    : {
        id: null,
        windowType,
        windowStartAt: bounds.startAt,
        windowEndAt: bounds.endAt,
        internalRequestCount: 0,
        manualAdjustmentCount: 0
      };
}

async function loadQuotaWindows(
  executor: Kysely<OpenDebateDb>,
  profile: QuotaProfileRecord,
  now: Date,
  options?: { forUpdate?: boolean; createIfMissing?: boolean }
): Promise<QuotaWindowCollection> {
  const boundsWeek = computeFixedWindowBounds("week", now, profile.resetTimezone);
  const boundsMonth = computeFixedWindowBounds("month", now, profile.resetTimezone);

  const [rolling5h, week, month] = await Promise.all([
    loadRollingWindow(executor, profile.id, now, options),
    loadFixedWindow(executor, profile.id, "week", boundsWeek, options),
    loadFixedWindow(executor, profile.id, "month", boundsMonth, options)
  ]);

  return { rolling5h, week, month };
}

async function updateWindowInternalCount(
  executor: Kysely<OpenDebateDb>,
  window: QuotaWindowUsageSnapshot,
  nextInternalRequestCount: number
) {
  if (!window.id) {
    throw new AppError("INTERNAL_ERROR", 500, `Missing ${window.windowType} quota window row`);
  }
  await executor.executeQuery(sql`
    update ai_quota_window_usage
       set internal_request_count = ${nextInternalRequestCount},
           updated_at = ${new Date().toISOString()}
     where id = ${window.id}
  `.compile(executor));
}

async function updateWindowManualAdjustment(
  executor: Kysely<OpenDebateDb>,
  window: QuotaWindowUsageSnapshot,
  nextManualAdjustmentCount: number
) {
  if (!window.id) {
    throw new AppError("INTERNAL_ERROR", 500, `Missing ${window.windowType} quota window row`);
  }
  await executor.executeQuery(sql`
    update ai_quota_window_usage
       set manual_adjustment_count = ${nextManualAdjustmentCount},
           updated_at = ${new Date().toISOString()}
     where id = ${window.id}
  `.compile(executor));
}

async function updateProfileNextRequestTime(
  executor: Kysely<OpenDebateDb>,
  profileId: string,
  nextRequestNotBeforeAt: string | null
) {
  await executor.executeQuery(sql`
    update ai_quota_profiles
       set next_request_not_before_at = ${nextRequestNotBeforeAt},
           updated_at = ${new Date().toISOString()}
     where id = ${profileId}
  `.compile(executor));
}

async function buildQuotaSummaryForProfile(
  executor: Kysely<OpenDebateDb>,
  profile: QuotaProfileRecord,
  now = new Date()
) {
  const windows = await loadQuotaWindows(executor, profile, now, { createIfMissing: false, forUpdate: false });
  return buildQuotaEvaluation(profile, windows, now).summary;
}

async function getReferencedAgentCounts(
  executor: Kysely<OpenDebateDb>,
  userId: string
): Promise<Map<string, number>> {
  const result = await executor.executeQuery<{ quota_profile_id: string | null; ref_count: number }>(sql`
    select quota_profile_id, count(*)::int as ref_count
      from ai_agents
     where user_id = ${userId}
       and deleted_at is null
       and quota_profile_id is not null
     group by quota_profile_id
  `.compile(executor));
  return new Map(
    result.rows
      .filter((row) => typeof row.quota_profile_id === "string")
      .map((row) => [String(row.quota_profile_id), Number(row.ref_count ?? 0)])
  );
}

export function isQuotaDelayError(error: unknown): error is QuotaDelayError {
  return error instanceof QuotaDelayError;
}

export function createQuotaThrottledError(wait: QuotaReservationWait) {
  const error = new AppError(
    "QUOTA_THROTTLED",
    429,
    `Coding Plan“${wait.profile.name}”当前受限，将于 ${formatQuotaDateTime(wait.nextAvailableAt, wait.profile.resetTimezone)} 后恢复`
  );
  error.details = {
    profileId: wait.profile.id,
    profileName: wait.profile.name,
    nextAvailableAt: wait.nextAvailableAt,
    windowReason: wait.reason,
    summary: wait.summary
  };
  return error;
}

export async function ensureQuotaProfileBindingForUser(
  userId: string,
  usageControlMode: AgentUsageControlMode | null | undefined,
  quotaProfileId: string | null | undefined
) {
  const mode = usageControlMode ?? "none";
  if (mode !== "coding_plan") {
    return {
      usageControlMode: "none" as const,
      quotaProfileId: null
    };
  }
  if (!quotaProfileId) {
    throw new AppError("VALIDATION_ERROR", 400, "Coding Plan 配置缺少计划池");
  }
  const db = await ensureDb();
  const profile = await loadQuotaProfileRowById(db, quotaProfileId, { userId });
  if (!profile) {
    throw new AppError("VALIDATION_ERROR", 400, "Coding Plan 计划池不存在或无权访问");
  }
  return {
    usageControlMode: "coding_plan" as const,
    quotaProfileId: profile.id
  };
}

export async function reserveQuotaForRequest(input: QuotaReservationInput): Promise<QuotaReservationDecision> {
  const mode = input.usageControlMode ?? "none";
  if (mode !== "coding_plan" || !input.quotaProfileId) {
    return { kind: "skipped" };
  }

  const db = await ensureDb();
  return db.transaction().execute(async (trx) => {
    const now = new Date();
    const profile = await loadQuotaProfileRowById(trx, input.quotaProfileId!, { userId: input.userId, forUpdate: true });
    if (!profile) {
      throw new AppError("VALIDATION_ERROR", 400, "Coding Plan 计划池不存在或已删除");
    }

    const windows = await loadQuotaWindows(trx, profile, now, { createIfMissing: true, forUpdate: true });
    const evaluation = buildQuotaEvaluation(profile, windows, now);
    if (evaluation.nextAvailableAt) {
      return {
        kind: "wait",
        profile,
        summary: evaluation.summary,
        waitMs: Math.max(0, new Date(evaluation.nextAvailableAt).getTime() - now.getTime()),
        nextAvailableAt: evaluation.nextAvailableAt,
        reason: evaluation.blockingReason
      };
    }

    await Promise.all([
      updateWindowInternalCount(trx, windows.rolling5h, windows.rolling5h.internalRequestCount + 1),
      updateWindowInternalCount(trx, windows.week, windows.week.internalRequestCount + 1),
      updateWindowInternalCount(trx, windows.month, windows.month.internalRequestCount + 1),
      updateProfileNextRequestTime(trx, profile.id, new Date(now.getTime() + evaluation.nextIntervalMs).toISOString())
    ]);

    const grantedSummary: QuotaProfileSummary = {
      ...evaluation.summary,
      used5h: evaluation.summary.used5h + 1,
      remaining5h: getRemainingRequests(profile.requestLimit5h, evaluation.summary.used5h + 1),
      usedWeek: evaluation.summary.usedWeek + 1,
      remainingWeek: getRemainingRequests(profile.requestLimitWeek, evaluation.summary.usedWeek + 1),
      usedMonth: evaluation.summary.usedMonth + 1,
      remainingMonth: getRemainingRequests(profile.requestLimitMonth, evaluation.summary.usedMonth + 1),
      nextAvailableAt: new Date(now.getTime() + evaluation.nextIntervalMs).toISOString(),
      blockingReason: null
    };

    quotaLogger.info("quota.reserve", {
      requestKind: input.requestKind,
      profileId: profile.id,
      profileName: profile.name,
      agentId: input.agentId ?? null,
      agentName: input.agentName ?? null,
      debateId: input.debateId ?? null,
      debateAgentId: input.debateAgentId ?? null,
      used5h: grantedSummary.used5h,
      usedWeek: grantedSummary.usedWeek,
      usedMonth: grantedSummary.usedMonth,
      nextAvailableAt: grantedSummary.nextAvailableAt,
      reason: null
    });

    return {
      kind: "granted",
      profile,
      summary: grantedSummary
    };
  });
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function ensureQuotaReservationOrDelay(
  input: QuotaReservationInput,
  options?: { maxInlineWaitMs?: number }
) {
  const maxInlineWaitMs = options?.maxInlineWaitMs ?? QUOTA_INLINE_WAIT_MAX_MS;
  while (true) {
    const decision = await reserveQuotaForRequest(input);
    if (decision.kind === "skipped" || decision.kind === "granted") {
      return decision;
    }

    if (decision.waitMs <= maxInlineWaitMs) {
      quotaLogger.info("quota.wait_inline", {
        requestKind: input.requestKind,
        profileId: decision.profile.id,
        profileName: decision.profile.name,
        waitMs: decision.waitMs,
        nextAvailableAt: decision.nextAvailableAt,
        reason: decision.reason,
        debateId: input.debateId ?? null,
        debateAgentId: input.debateAgentId ?? null,
        used5h: decision.summary.used5h,
        usedWeek: decision.summary.usedWeek,
        usedMonth: decision.summary.usedMonth
      });
      await sleep(Math.max(1, decision.waitMs));
      continue;
    }

    throw new QuotaDelayError(decision);
  }
}

export async function ensureQuotaAvailableOrThrowAppError(input: QuotaReservationInput) {
  const decision = await reserveQuotaForRequest(input);
  if (decision.kind === "wait") {
    throw createQuotaThrottledError(decision);
  }
  return decision;
}

async function listQuotaProfilesForUser(userId: string) {
  const db = await ensureDb();
  const rows = await db
    .selectFrom("ai_quota_profiles")
    .selectAll()
    .where("user_id", "=", userId)
    .where("deleted_at", "is", null)
    .orderBy("created_at", "desc")
    .execute();

  const profiles = rows.map((row) => parseQuotaProfileRow(row as Row));
  const referenceCounts = await getReferencedAgentCounts(db, userId);
  const views = await Promise.all(
    profiles.map(async (profile) => ({
      ...profile,
      summary: await buildQuotaSummaryForProfile(db, profile),
      referencedAgentCount: referenceCounts.get(profile.id) ?? 0
    }))
  );
  return views;
}

export async function listQuotaProfiles() {
  const session = await requireSessionUser();
  return listQuotaProfilesForUser(session.userId);
}

export async function createQuotaProfile(input: unknown) {
  const data = createQuotaProfileSchema.parse(input);
  const session = await requireSessionUser();
  const now = new Date().toISOString();
  const db = await ensureDb();
  const inserted = await db
    .insertInto("ai_quota_profiles")
    .values({
      id: randomUUID(),
      user_id: session.userId,
      name: data.name,
      profile_type: "coding_plan",
      request_limit_5h: data.requestLimit5h,
      request_limit_week: data.requestLimitWeek,
      request_limit_month: data.requestLimitMonth,
      pacing_mode: data.pacingMode,
      pacing_value: data.pacingValue,
      reset_timezone: normalizeTimeZone(data.resetTimezone),
      next_request_not_before_at: null,
      created_at: now,
      updated_at: now,
      deleted_at: null
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  const profile = parseQuotaProfileRow(inserted as Row);
  return {
    ...profile,
    summary: await buildQuotaSummaryForProfile(db, profile),
    referencedAgentCount: 0
  };
}

async function getQuotaProfileForSession(id: string) {
  const session = await requireSessionUser();
  const db = await ensureDb();
  const profile = await loadQuotaProfileRowById(db, id, { userId: session.userId });
  if (!profile) {
    throw new AppError("NOT_FOUND", 404, "Coding Plan 不存在");
  }
  return { session, db, profile };
}

export async function getQuotaProfileViewById(id: string) {
  const { db, profile, session } = await getQuotaProfileForSession(id);
  const referenceCounts = await getReferencedAgentCounts(db, session.userId);
  return {
    ...profile,
    summary: await buildQuotaSummaryForProfile(db, profile),
    referencedAgentCount: referenceCounts.get(profile.id) ?? 0
  };
}

export async function updateQuotaProfile(id: string, input: unknown) {
  const patch = updateQuotaProfileSchema.parse(input);
  const { db, profile } = await getQuotaProfileForSession(id);
  const merged = createQuotaProfileSchema.parse({
    name: patch.name ?? profile.name,
    requestLimit5h: patch.requestLimit5h ?? profile.requestLimit5h,
    requestLimitWeek: patch.requestLimitWeek ?? profile.requestLimitWeek,
    requestLimitMonth: patch.requestLimitMonth ?? profile.requestLimitMonth,
    pacingMode: patch.pacingMode ?? profile.pacingMode,
    pacingValue: patch.pacingValue ?? profile.pacingValue,
    resetTimezone: patch.resetTimezone ?? profile.resetTimezone
  });
  const updated = await db
    .updateTable("ai_quota_profiles")
    .set({
      name: merged.name,
      request_limit_5h: merged.requestLimit5h,
      request_limit_week: merged.requestLimitWeek,
      request_limit_month: merged.requestLimitMonth,
      pacing_mode: merged.pacingMode,
      pacing_value: merged.pacingValue,
      reset_timezone: normalizeTimeZone(merged.resetTimezone),
      updated_at: new Date().toISOString()
    })
    .where("id", "=", id)
    .returningAll()
    .executeTakeFirstOrThrow();
  const nextProfile = parseQuotaProfileRow(updated as Row);
  return {
    ...nextProfile,
    summary: await buildQuotaSummaryForProfile(db, nextProfile),
    referencedAgentCount: (await getReferencedAgentCounts(db, nextProfile.userId)).get(nextProfile.id) ?? 0
  };
}

export async function deleteQuotaProfile(id: string) {
  const { db, profile } = await getQuotaProfileForSession(id);
  const referenced = await db
    .selectFrom("ai_agents")
    .select(sql<number>`count(*)::int`.as("count"))
    .where("user_id", "=", profile.userId)
    .where("deleted_at", "is", null)
    .where("quota_profile_id", "=", id)
    .executeTakeFirst();
  if (Number(referenced?.count ?? 0) > 0) {
    throw new AppError("CONFLICT", 409, "该 Coding Plan 仍被 AI 配置引用，不能删除");
  }
  await db
    .updateTable("ai_quota_profiles")
    .set({
      deleted_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    .where("id", "=", id)
    .executeTakeFirst();
}

export async function adjustQuotaProfile(id: string, input: unknown) {
  const data = adjustQuotaProfileSchema.parse(input);
  const { db, profile } = await getQuotaProfileForSession(id);
  return db.transaction().execute(async (trx) => {
    const lockedProfile = await loadQuotaProfileRowById(trx, profile.id, { userId: profile.userId, forUpdate: true });
    if (!lockedProfile) {
      throw new AppError("NOT_FOUND", 404, "Coding Plan 不存在");
    }
    const now = new Date();
    const windows = await loadQuotaWindows(trx, lockedProfile, now, { createIfMissing: true, forUpdate: true });
    const targetWindow =
      data.windowType === "rolling_5h" ? windows.rolling5h : data.windowType === "week" ? windows.week : windows.month;
    const nextManualAdjustment = targetWindow.manualAdjustmentCount + data.delta;
    if (targetWindow.internalRequestCount + nextManualAdjustment < 0) {
      throw new AppError("VALIDATION_ERROR", 400, "手工校正后总请求数不能小于 0");
    }
    await updateWindowManualAdjustment(trx, targetWindow, nextManualAdjustment);
    const adjustedTargetWindow: QuotaWindowUsageSnapshot = {
      ...targetWindow,
      manualAdjustmentCount: nextManualAdjustment
    };
    const adjustedWindows: QuotaWindowCollection =
      data.windowType === "rolling_5h"
        ? { ...windows, rolling5h: adjustedTargetWindow }
        : data.windowType === "week"
          ? { ...windows, week: adjustedTargetWindow }
          : { ...windows, month: adjustedTargetWindow };
    const recalculatedBase = buildQuotaEvaluation(
      { ...lockedProfile, nextRequestNotBeforeAt: null },
      adjustedWindows,
      now
    );
    const preservedCursor = getFutureCursor(lockedProfile.nextRequestNotBeforeAt, now.getTime());
    const nextRequestNotBeforeAt =
      recalculatedBase.nextAvailableAt ??
      (data.delta > 0
        ? getLaterIsoTimestamp(
            preservedCursor,
            new Date(now.getTime() + recalculatedBase.nextIntervalMs).toISOString()
          )
        : preservedCursor);
    if (nextRequestNotBeforeAt !== lockedProfile.nextRequestNotBeforeAt) {
      await updateProfileNextRequestTime(trx, lockedProfile.id, nextRequestNotBeforeAt);
    }
    await trx.executeQuery(sql`
      insert into ai_quota_adjustments (
        id,
        profile_id,
        window_type,
        delta,
        note,
        created_at
      )
      values (
        ${randomUUID()},
        ${lockedProfile.id},
        ${data.windowType},
        ${data.delta},
        ${data.note ?? null},
        ${now.toISOString()}
      )
    `.compile(trx));
    const summary = buildQuotaEvaluation(
      {
        ...lockedProfile,
        nextRequestNotBeforeAt
      },
      adjustedWindows,
      now
    ).summary;
    quotaLogger.info("quota.manual_adjustment", {
      profileId: lockedProfile.id,
      profileName: lockedProfile.name,
      windowType: data.windowType,
      delta: data.delta,
      note: data.note ?? null,
      used5h: summary.used5h,
      usedWeek: summary.usedWeek,
      usedMonth: summary.usedMonth,
      nextAvailableAt: summary.nextAvailableAt,
      reason: summary.blockingReason
    });
    return {
      ...lockedProfile,
      nextRequestNotBeforeAt,
      summary,
      referencedAgentCount: 0
    };
  });
}

export async function getQuotaProfileSummaryForSystem(profileId: string) {
  const db = await ensureDb();
  const profile = await loadQuotaProfileRowById(db, profileId, { forUpdate: false });
  if (!profile) {
    throw new AppError("NOT_FOUND", 404, "Coding Plan 不存在");
  }
  return {
    profile,
    summary: await buildQuotaSummaryForProfile(db, profile)
  };
}

export async function getOrCreateImportedQuotaProfile(input: {
  executor: Kysely<OpenDebateDb>;
  userId: string;
  now: string;
  snapshot: {
    name: string;
    requestLimit5h: number;
    requestLimitWeek: number;
    requestLimitMonth: number;
    pacingMode: QuotaPacingMode;
    pacingValue: number;
    resetTimezone: string;
  };
}) {
  const normalized = createQuotaProfileSchema.parse(input.snapshot);
  const existingRows = await input.executor.executeQuery<Row>(sql`
    select *
      from ai_quota_profiles
     where user_id = ${input.userId}
       and deleted_at is null
       and name = ${normalized.name}
  `.compile(input.executor));
  const existing = existingRows.rows
    .map((row) => parseQuotaProfileRow(row))
    .find(
      (profile) =>
        profile.requestLimit5h === normalized.requestLimit5h &&
        profile.requestLimitWeek === normalized.requestLimitWeek &&
        profile.requestLimitMonth === normalized.requestLimitMonth &&
        profile.pacingMode === normalized.pacingMode &&
        profile.pacingValue === normalized.pacingValue &&
        profile.resetTimezone === normalizeTimeZone(normalized.resetTimezone)
    );
  if (existing) return existing;

  const inserted = await input.executor
    .insertInto("ai_quota_profiles")
    .values({
      id: randomUUID(),
      user_id: input.userId,
      name: normalized.name,
      profile_type: "coding_plan",
      request_limit_5h: normalized.requestLimit5h,
      request_limit_week: normalized.requestLimitWeek,
      request_limit_month: normalized.requestLimitMonth,
      pacing_mode: normalized.pacingMode,
      pacing_value: normalized.pacingValue,
      reset_timezone: normalizeTimeZone(normalized.resetTimezone),
      next_request_not_before_at: null,
      created_at: input.now,
      updated_at: input.now,
      deleted_at: null
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return parseQuotaProfileRow(inserted as Row);
}

export const quotaControlTestUtils = {
  computeFixedWindowBounds,
  resolvePacingTarget5h,
  buildQuotaEvaluation
};
