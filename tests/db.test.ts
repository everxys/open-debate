import test from "node:test";
import assert from "node:assert/strict";

import { isRecoverablePoolError } from "@/lib/db";

test("isRecoverablePoolError detects transient pg outage codes", () => {
  assert.equal(isRecoverablePoolError({ code: "57P03" }), true);
  assert.equal(isRecoverablePoolError({ code: "08006" }), true);
  assert.equal(isRecoverablePoolError({ errno: "ECONNREFUSED" }), true);
});

test("isRecoverablePoolError follows nested causes", () => {
  assert.equal(
    isRecoverablePoolError({
      code: "WRAPPER",
      cause: { errno: "ECONNRESET" }
    }),
    true
  );
});

test("isRecoverablePoolError ignores non-connection database errors", () => {
  assert.equal(isRecoverablePoolError({ code: "23505" }), false);
  assert.equal(isRecoverablePoolError({ code: "42601" }), false);
  assert.equal(isRecoverablePoolError(new Error("plain failure")), false);
});
