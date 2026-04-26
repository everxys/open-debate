import test from "node:test";
import assert from "node:assert/strict";

import { AppError, apiRoute, jsonSuccess, readJsonBody } from "@/lib/http";

test("jsonSuccess returns the standard success envelope", async () => {
  const response = jsonSuccess({ value: 42 }, 201);
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), {
    success: true,
    data: { value: 42 }
  });
});

test("readJsonBody returns fallback only when one is provided", async () => {
  const fallback = { empty: true };
  const response = await readJsonBody(
    new Request("http://unit.test/body", { method: "POST", body: "not-json" }),
    fallback
  );
  assert.equal(response, fallback);

  await assert.rejects(() =>
    readJsonBody(new Request("http://unit.test/body", { method: "POST", body: "not-json" }))
  );
});

test("apiRoute resolves params and returns handler responses", async () => {
  const route = apiRoute<{ id: string }>(
    { route: "/unit/[id]", method: "GET", logMeta: ({ params }) => ({ id: params.id }) },
    async ({ params, setLogMeta }) => {
      setLogMeta({ unit: "http" });
      return jsonSuccess({ id: params.id });
    }
  );

  const response = await route(new Request("http://unit.test/unit/abc"), {
    params: Promise.resolve({ id: "abc" })
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    success: true,
    data: { id: "abc" }
  });
});

test("apiRoute converts thrown AppError to standard error envelope", async () => {
  const route = apiRoute(
    { route: "/unit/error", method: "POST" },
    async () => {
      throw new AppError("UNIT_ERROR", 418, "short and stout");
    }
  );

  const response = await route(new Request("http://unit.test/unit/error", { method: "POST" }), {
    params: Promise.resolve({})
  });

  assert.equal(response.status, 418);
  assert.deepEqual(await response.json(), {
    success: false,
    error: {
      code: "UNIT_ERROR",
      message: "short and stout"
    }
  });
});

test("apiRoute includes AppError details when provided", async () => {
  const route = apiRoute(
    { route: "/unit/quota", method: "POST" },
    async () => {
      const error = new AppError("QUOTA_THROTTLED", 429, "slow down");
      error.details = {
        profileId: "profile-1",
        nextAvailableAt: "2026-04-24T12:00:00.000Z"
      };
      throw error;
    }
  );

  const response = await route(new Request("http://unit.test/unit/quota", { method: "POST" }), {
    params: Promise.resolve({})
  });

  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), {
    success: false,
    error: {
      code: "QUOTA_THROTTLED",
      message: "slow down",
      details: {
        profileId: "profile-1",
        nextAvailableAt: "2026-04-24T12:00:00.000Z"
      }
    }
  });
});
