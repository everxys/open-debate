import test from "node:test";
import assert from "node:assert/strict";

import { sanitizeLogFields, stringifyLogFields } from "@/lib/logger/shared";

test("sanitizeLogFields keeps context when error is an empty object", () => {
  const fields = sanitizeLogFields({
    debateId: "debate-1",
    turnNumber: 21,
    error: {}
  });

  assert.deepEqual(fields, {
    debateId: "debate-1",
    turnNumber: 21,
    error: {
      message: "{}",
      raw: {}
    }
  });
  assert.match(stringifyLogFields(fields), /"debateId":"debate-1"/);
  assert.match(stringifyLogFields(fields), /"message":"\{\}"/);
});

test("sanitizeLogFields preserves non-enumerable browser error details", () => {
  const browserError = {};
  Object.defineProperty(browserError, "name", { value: "AbortError" });
  Object.defineProperty(browserError, "message", { value: "The operation was aborted." });

  const fields = sanitizeLogFields({ error: browserError });

  assert.deepEqual(fields, {
    error: {
      name: "AbortError",
      message: "The operation was aborted."
    }
  });
});
