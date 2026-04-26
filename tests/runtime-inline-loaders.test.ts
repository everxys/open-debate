import test from "node:test";
import assert from "node:assert/strict";

import { resolveDebateIdeaBankPaths } from "@/lib/runtime/runtime-inline-loaders";

test("resolveDebateIdeaBankPaths does not infer workspace-specific defaults", async () => {
  const result = await resolveDebateIdeaBankPaths({
    workflow: {
      enabled: true,
      ideaBank: {
        rawIdeaBankPath: null,
        derivedFiles: {
          currentBattlefieldPath: null,
          selectedSTierPath: null,
          selectedATierPath: null,
          rejectedOrMergedPath: null,
          eventMappingsPath: null,
          newlyInventedIdeasPath: null
        }
      }
    } as any,
    userId: "user-1",
    debateId: "debate-1"
  });

  assert.equal(result.rawIdeaBankPath, null);
  assert.deepEqual(result.derivedFiles, {
    currentBattlefieldPath: null,
    selectedSTierPath: null,
    selectedATierPath: null,
    rejectedOrMergedPath: null,
    eventMappingsPath: null,
    newlyInventedIdeasPath: null
  });
});
