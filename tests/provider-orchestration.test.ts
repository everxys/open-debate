import test from "node:test";
import assert from "node:assert/strict";

import { AppError } from "@/lib/http";
import {
  assertNonEmptyProviderText,
  assertProviderApiKeyEnabled
} from "@/lib/runtime/provider-orchestration";
import { isNonRetryableSummaryJobError } from "@/lib/runtime-main";

test("assertNonEmptyProviderText returns trimmed text when content exists", () => {
  const result = assertNonEmptyProviderText("  hello world  ", {
    provider: "openai",
    model: "test-model",
    stage: "unit"
  });
  assert.equal(result, "hello world");
});

test("assertNonEmptyProviderText throws AI_EMPTY_RESPONSE for empty content", () => {
  assert.throws(
    () =>
      assertNonEmptyProviderText("   ", {
        provider: "openai",
        model: "test-model",
        stage: "unit",
        finishReason: "stop",
        toolCallsCount: 0
      }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, "AI_EMPTY_RESPONSE");
      assert.equal(error.status, 502);
      assert.match(error.message, /empty content/i);
      return true;
    }
  );
});

test("assertProviderApiKeyEnabled rejects demo keys", () => {
  assert.throws(
    () => assertProviderApiKeyEnabled("demo-local-key"),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, "AI_DEMO_KEY_DISABLED");
      assert.equal(error.status, 400);
      return true;
    }
  );
});

test("assertProviderApiKeyEnabled allows normal keys", () => {
  assert.doesNotThrow(() => assertProviderApiKeyEnabled("sk-live-key"));
});

test("isNonRetryableSummaryJobError detects invalid api key payloads", () => {
  assert.equal(
    isNonRetryableSummaryJobError(
      new AppError(
        "AI_INVALID_API_KEY",
        401,
        '{"error":{"code":"invalid_api_key","message":"invalid access token or token expired"}}'
      )
    ),
    true
  );
});

test("isNonRetryableSummaryJobError keeps network interruptions retryable", () => {
  assert.equal(isNonRetryableSummaryJobError(new AppError("AI_NETWORK_ERROR", 502, "fetch failed")), false);
});
