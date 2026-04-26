import test from "node:test";
import assert from "node:assert/strict";

import { normalizeNullableTimestampString, normalizeTimestampString } from "@/lib/timestamps";

test("normalizeTimestampString converts Date instances to ISO strings", () => {
  const value = new Date("2026-04-26T04:43:35.503Z");
  assert.equal(normalizeTimestampString(value), "2026-04-26T04:43:35.503Z");
});

test("normalizeNullableTimestampString preserves nullish values", () => {
  assert.equal(normalizeNullableTimestampString(null), null);
  assert.equal(normalizeNullableTimestampString(undefined), null);
});

test("normalizeTimestampString leaves ISO strings unchanged", () => {
  const value = "2026-04-26T04:43:35.503Z";
  assert.equal(normalizeTimestampString(value), value);
});
