import test from "node:test";
import assert from "node:assert/strict";

import {
  isDatabaseConnectionError,
  parseSummaryWorkerConcurrency
} from "@/lib/summary-job-worker";

function withSummaryWorkerConcurrency(value: string | undefined, run: () => void) {
  const previous = process.env.OPEN_DEBATE_SUMMARY_WORKER_CONCURRENCY;
  try {
    if (value === undefined) {
      delete process.env.OPEN_DEBATE_SUMMARY_WORKER_CONCURRENCY;
    } else {
      process.env.OPEN_DEBATE_SUMMARY_WORKER_CONCURRENCY = value;
    }
    run();
  } finally {
    if (previous === undefined) {
      delete process.env.OPEN_DEBATE_SUMMARY_WORKER_CONCURRENCY;
    } else {
      process.env.OPEN_DEBATE_SUMMARY_WORKER_CONCURRENCY = previous;
    }
  }
}

test("parseSummaryWorkerConcurrency defaults and clamps configured concurrency", () => {
  withSummaryWorkerConcurrency(undefined, () => {
    assert.equal(parseSummaryWorkerConcurrency(), 3);
  });
  withSummaryWorkerConcurrency("0", () => {
    assert.equal(parseSummaryWorkerConcurrency(), 1);
  });
  withSummaryWorkerConcurrency("4.8", () => {
    assert.equal(parseSummaryWorkerConcurrency(), 4);
  });
  withSummaryWorkerConcurrency("99", () => {
    assert.equal(parseSummaryWorkerConcurrency(), 8);
  });
  withSummaryWorkerConcurrency("not-a-number", () => {
    assert.equal(parseSummaryWorkerConcurrency(), 3);
  });
});

test("isDatabaseConnectionError detects nested and aggregate connection failures", () => {
  assert.equal(isDatabaseConnectionError({ code: "ECONNRESET" }), true);
  assert.equal(isDatabaseConnectionError({ cause: { code: "57P03" } }), true);
  assert.equal(isDatabaseConnectionError(new AggregateError([{ code: "08001" }])), true);
});

test("isDatabaseConnectionError keeps job and constraint errors non-connection", () => {
  assert.equal(isDatabaseConnectionError({ code: "23505" }), false);
  assert.equal(isDatabaseConnectionError(new Error("model failed")), false);
});
