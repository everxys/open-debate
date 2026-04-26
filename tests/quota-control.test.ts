import assert from "node:assert/strict";
import test from "node:test";

import { quotaControlTestUtils } from "@/lib/quota-control";
import type { QuotaProfileRecord } from "@/lib/types";

type QuotaWindows = Parameters<typeof quotaControlTestUtils.buildQuotaEvaluation>[1];
type QuotaWindow = QuotaWindows["rolling5h"];

function createProfile(overrides: Partial<QuotaProfileRecord> = {}): QuotaProfileRecord {
  return {
    id: "profile-1",
    userId: "user-1",
    name: "Coding Plan A",
    profileType: "coding_plan",
    requestLimit5h: 1200,
    requestLimitWeek: 9000,
    requestLimitMonth: 18000,
    pacingMode: "percent",
    pacingValue: 90,
    resetTimezone: "Asia/Shanghai",
    nextRequestNotBeforeAt: null,
    createdAt: "2026-04-24T00:00:00.000Z",
    updatedAt: "2026-04-24T00:00:00.000Z",
    deletedAt: null,
    ...overrides
  };
}

function createWindow(
  windowType: QuotaWindow["windowType"],
  windowStartAt: string | null,
  windowEndAt: string | null,
  internalRequestCount: number,
  manualAdjustmentCount = 0
): QuotaWindow {
  return {
    id: `${windowType}-1`,
    windowType,
    windowStartAt,
    windowEndAt,
    internalRequestCount,
    manualAdjustmentCount
  };
}

test("resolvePacingTarget5h uses 90 percent of the 5h limit by default", () => {
  const profile = createProfile();
  assert.equal(quotaControlTestUtils.resolvePacingTarget5h(profile), 1080);
});

test("computeFixedWindowBounds respects Asia/Shanghai week and month reset boundaries", () => {
  const now = new Date("2026-04-24T10:30:00.000Z");
  const weekBounds = quotaControlTestUtils.computeFixedWindowBounds("week", now, "Asia/Shanghai");
  const monthBounds = quotaControlTestUtils.computeFixedWindowBounds("month", now, "Asia/Shanghai");

  assert.deepEqual(weekBounds, {
    startAt: "2026-04-19T16:00:00.000Z",
    endAt: "2026-04-26T16:00:00.000Z"
  });
  assert.deepEqual(monthBounds, {
    startAt: "2026-03-31T16:00:00.000Z",
    endAt: "2026-04-30T16:00:00.000Z"
  });
});

test("buildQuotaEvaluation lets weekly remaining budget dominate the pacing interval when it is tighter", () => {
  const now = new Date("2026-04-24T10:30:00.000Z");
  const weekBounds = quotaControlTestUtils.computeFixedWindowBounds("week", now, "Asia/Shanghai");
  const monthBounds = quotaControlTestUtils.computeFixedWindowBounds("month", now, "Asia/Shanghai");
  const profile = createProfile({
    requestLimitWeek: 2,
    requestLimitMonth: 1000
  });
  const windows: QuotaWindows = {
    rolling5h: createWindow("rolling_5h", now.toISOString(), "2026-04-24T15:30:00.000Z", 0),
    week: createWindow("week", weekBounds.startAt, weekBounds.endAt, 1),
    month: createWindow("month", monthBounds.startAt, monthBounds.endAt, 1)
  };

  const evaluation = quotaControlTestUtils.buildQuotaEvaluation(profile, windows, now);
  const expectedWeekIntervalMs = new Date(weekBounds.endAt).getTime() - now.getTime();

  assert.equal(evaluation.summary.nextAvailableAt, null);
  assert.equal(evaluation.summary.blockingReason, null);
  assert.equal(evaluation.summary.effectiveIntervalMs, expectedWeekIntervalMs);
});

test("buildQuotaEvaluation blocks until the month reset when the monthly hard limit is exhausted", () => {
  const now = new Date("2026-04-24T10:30:00.000Z");
  const weekBounds = quotaControlTestUtils.computeFixedWindowBounds("week", now, "Asia/Shanghai");
  const monthBounds = quotaControlTestUtils.computeFixedWindowBounds("month", now, "Asia/Shanghai");
  const profile = createProfile({
    requestLimitMonth: 3
  });
  const windows: QuotaWindows = {
    rolling5h: createWindow("rolling_5h", now.toISOString(), "2026-04-24T15:30:00.000Z", 1),
    week: createWindow("week", weekBounds.startAt, weekBounds.endAt, 2),
    month: createWindow("month", monthBounds.startAt, monthBounds.endAt, 3)
  };

  const evaluation = quotaControlTestUtils.buildQuotaEvaluation(profile, windows, now);

  assert.equal(evaluation.summary.blockingReason, "month_limit");
  assert.equal(evaluation.summary.nextAvailableAt, monthBounds.endAt);
  assert.equal(evaluation.summary.remainingMonth, 0);
});
