import test from "node:test";
import assert from "node:assert/strict";

import { mapActualRoundToSpeechRoundIndex, mapSpeechRoundIndexToActualRound } from "@/lib/runtime/workflow-phase";

test("mapActualRoundToSpeechRoundIndex skips closed vote rounds", () => {
  assert.equal(mapActualRoundToSpeechRoundIndex(1, [2, 5]), 1);
  assert.equal(mapActualRoundToSpeechRoundIndex(3, [2, 5]), 2);
  assert.equal(mapActualRoundToSpeechRoundIndex(6, [2, 5]), 4);
});

test("mapActualRoundToSpeechRoundIndex returns null for vote-only rounds", () => {
  assert.equal(mapActualRoundToSpeechRoundIndex(2, [2, 5]), null);
  assert.equal(mapActualRoundToSpeechRoundIndex(5, [2, 5]), null);
});

test("speech round and actual round mapping stay inverse for speaking rounds", () => {
  const closedVoteRounds = [2, 5, 9];
  for (const speechRoundIndex of [1, 2, 3, 4, 5, 6]) {
    const actualRound = mapSpeechRoundIndexToActualRound(speechRoundIndex, closedVoteRounds);
    assert.equal(mapActualRoundToSpeechRoundIndex(actualRound, closedVoteRounds), speechRoundIndex);
  }
});
