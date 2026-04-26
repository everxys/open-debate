import test from "node:test";
import assert from "node:assert/strict";

import {
  mapActualRoundToSpeechRoundIndex,
  mapSpeechRoundIndexToActualRound,
  resolveRequestedMaxTokens
} from "@/lib/runtime/workflow-phase";
import { createAgentSchema } from "@/lib/validation";

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

test("openai requested max tokens clamp to provider-safe ceiling", () => {
  assert.equal(resolveRequestedMaxTokens(262_144, "openai"), 32_768);
  assert.equal(resolveRequestedMaxTokens(null, "openai"), 32_768);
});

test("anthropic requested max tokens keeps larger configured values", () => {
  assert.equal(resolveRequestedMaxTokens(262_144, "anthropic"), 262_144);
  assert.equal(resolveRequestedMaxTokens(null, "anthropic"), 65_535);
});

test("createAgentSchema rejects oversized openai max output tokens", () => {
  const parsed = createAgentSchema.safeParse({
    name: "OpenAI Agent",
    provider: "openai",
    model: "gpt-test",
    contextLength: null,
    maxInputTokens: null,
    maxOutputTokens: 262_144,
    baseUrl: "https://api.openai.com/v1",
    apiKey: "sk-test"
  });
  assert.equal(parsed.success, false);
  assert.match(JSON.stringify(parsed.error?.flatten().fieldErrors.maxOutputTokens ?? []), /32,?768/);
});

test("createAgentSchema still allows larger anthropic max output tokens", () => {
  const parsed = createAgentSchema.safeParse({
    name: "Anthropic Agent",
    provider: "anthropic",
    model: "claude-test",
    contextLength: null,
    maxInputTokens: null,
    maxOutputTokens: 262_144,
    baseUrl: "https://api.anthropic.com",
    apiKey: "sk-test"
  });
  assert.equal(parsed.success, true);
});
