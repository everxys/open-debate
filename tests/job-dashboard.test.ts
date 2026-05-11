import test from "node:test";
import assert from "node:assert/strict";

import {
  formatDurationMs,
  normalizeJobSourceFilter,
  normalizeJobStatusFilter,
  parseJobLimit
} from "@/lib/job-dashboard";

test("job dashboard limit parsing clamps to the supported range", () => {
  assert.equal(parseJobLimit(null), 80);
  assert.equal(parseJobLimit("0"), 1);
  assert.equal(parseJobLimit("12.8"), 12);
  assert.equal(parseJobLimit("9999"), 200);
  assert.equal(parseJobLimit("not-a-number"), 80);
});

test("job dashboard filters normalize invalid values to all", () => {
  assert.equal(normalizeJobSourceFilter("summary"), "summary");
  assert.equal(normalizeJobSourceFilter("resume"), "resume");
  assert.equal(normalizeJobSourceFilter("other"), "all");
  assert.equal(normalizeJobStatusFilter("active"), "active");
  assert.equal(normalizeJobStatusFilter("failed"), "failed");
  assert.equal(normalizeJobStatusFilter("completed"), "completed");
  assert.equal(normalizeJobStatusFilter("queued"), "all");
});

test("job dashboard duration formatter uses compact readable units", () => {
  assert.equal(formatDurationMs(0), "0s");
  assert.equal(formatDurationMs(59_900), "59s");
  assert.equal(formatDurationMs(65_000), "1m 5s");
  assert.equal(formatDurationMs(3_900_000), "1h 5m");
});
