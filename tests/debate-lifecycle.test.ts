import test from "node:test";
import assert from "node:assert/strict";

import {
  DEBATE_LIFECYCLE_RULES,
  canTransitionDebateStatus,
  getDebateLifecycleRule
} from "@/lib/debates";

test("debate lifecycle rules preserve allowed status gates", () => {
  assert.deepEqual(DEBATE_LIFECYCLE_RULES.start.allowedStatuses, ["pending", "paused"]);
  assert.deepEqual(DEBATE_LIFECYCLE_RULES.pause.allowedStatuses, ["running"]);
  assert.deepEqual(DEBATE_LIFECYCLE_RULES.resume.allowedStatuses, ["paused"]);
  assert.deepEqual(DEBATE_LIFECYCLE_RULES.repair.allowedStatuses, ["failed", "paused", "running"]);
  assert.deepEqual(DEBATE_LIFECYCLE_RULES.stop.allowedStatuses, ["pending", "running", "paused"]);
});

test("debate lifecycle rules preserve resulting statuses and conflict messages", () => {
  assert.equal(getDebateLifecycleRule("start").resultStatus, "running");
  assert.equal(getDebateLifecycleRule("pause").resultStatus, "paused");
  assert.equal(getDebateLifecycleRule("resume").resultStatus, "running");
  assert.equal(getDebateLifecycleRule("repair").resultStatus, "paused");
  assert.equal(getDebateLifecycleRule("stop").resultStatus, "stopped");

  assert.equal(getDebateLifecycleRule("pause").conflictMessage, "Only running debates can be paused");
  assert.equal(getDebateLifecycleRule("stop").conflictMessage, "Debate is already finished");
});

test("canTransitionDebateStatus rejects terminal or wrong-state lifecycle actions", () => {
  assert.equal(canTransitionDebateStatus("start", "pending"), true);
  assert.equal(canTransitionDebateStatus("start", "running"), false);
  assert.equal(canTransitionDebateStatus("pause", "running"), true);
  assert.equal(canTransitionDebateStatus("pause", "failed"), false);
  assert.equal(canTransitionDebateStatus("repair", "failed"), true);
  assert.equal(canTransitionDebateStatus("repair", "paused"), true);
  assert.equal(canTransitionDebateStatus("repair", "running"), true);
  assert.equal(canTransitionDebateStatus("repair", "stopped"), false);
  assert.equal(canTransitionDebateStatus("stop", "completed"), false);
});
