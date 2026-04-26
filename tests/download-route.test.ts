import test from "node:test";
import assert from "node:assert/strict";

import { POST as downloadDebateFiles } from "@/app/api/debates/[id]/download/route";

test("debate download route rejects empty selections before file lookup", async () => {
  const response = await downloadDebateFiles(
    new Request("http://unit.test/api/debates/debate-1/download", {
      method: "POST",
      body: JSON.stringify({ paths: [] })
    }),
    { params: Promise.resolve({ id: "debate-1" }) }
  );

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    success: false,
    error: {
      code: "VALIDATION_ERROR",
      message: "At least one file or folder must be selected"
    }
  });
});
