import test from "node:test";
import assert from "node:assert/strict";

import {
  buildRuntimeActionInstructions,
  detectRuntimeActionLoop,
  makeRuntimeActionLoopRecord,
  parseRuntimeHarnessAction,
  pushRuntimeActionLoopRecord,
  resolveRuntimeActionPolicy,
  type RuntimeActionLoopState
} from "@/lib/runtime/runtime-action-harness";

test("parseRuntimeHarnessAction reads fenced harness JSON", () => {
  const parsed = parseRuntimeHarnessAction(
    '```debate-action\n{ "action": "read", "path": "outputs/outline.md" }\n```',
    ["read"]
  );
  assert.ok("action" in parsed);
  assert.deepEqual(parsed.action, { action: "read", path: "outputs/outline.md" });
});

test("resolveRuntimeActionPolicy gates to vote_cast when seat has not voted", () => {
  const policy = resolveRuntimeActionPolicy({
    roleType: "Analyst",
    pendingDeliverables: [],
    openVote: {
      status: "open",
      kind: "custom",
      roundNumber: 3,
      title: "Vote",
      prompt: "Pick one",
      options: ["A", "B"],
      ballots: [],
      createdAt: new Date().toISOString()
    },
    debateAgentId: "seat-1",
    workingSet: {
      canonicalSourceFiles: [],
      recentlyReadFiles: [],
      recentlyWrittenFiles: [],
      updatedAt: null
    },
    readableSharedPaths: ["outputs/"],
    allowedOutputPaths: ["outputs/"]
  });
  assert.deepEqual(policy.allowedActions, ["vote_cast"]);
});

test("resolveRuntimeActionPolicy prefers write_section for known markdown source files", () => {
  const policy = resolveRuntimeActionPolicy({
    roleType: "Analyst",
    pendingDeliverables: [
      {
        path: "outputs/final-answer.md",
        minChars: null,
        minMarkdownHeadings: null,
        requiredSnippets: [],
        qualityChecks: {
          requiredTerms: [],
          requiredSections: [],
          minBulletItems: null,
          counters: []
        }
      }
    ],
    openVote: null,
    debateAgentId: "seat-2",
    workingSet: {
      canonicalSourceFiles: [
        {
          path: "debate/ideas/selected-s-tier.md",
          source: "shared",
          version: 3,
          updatedAt: new Date().toISOString(),
          excerpt: "Known writable source"
        }
      ],
      recentlyReadFiles: [],
      recentlyWrittenFiles: [],
      updatedAt: null
    },
    readableSharedPaths: ["outputs/", "final/", "debate/ideas/selected-s-tier.md"],
    allowedOutputPaths: ["outputs/", "final/", "debate/ideas/selected-s-tier.md"]
  });
  assert.equal(policy.preferredWriteAction, "write_section");
  assert.deepEqual(policy.allowedActions, ["read", "write_section"]);
  assert.deepEqual(policy.knownTargetPaths, ["debate/ideas/selected-s-tier.md", "outputs/final-answer.md"]);
  assert.deepEqual(policy.knownWritableTargetPaths, ["debate/ideas/selected-s-tier.md", "outputs/final-answer.md"]);
});

test("resolveRuntimeActionPolicy bootstraps concrete writable targets from workflow paths", () => {
  const policy = resolveRuntimeActionPolicy({
    roleType: "Analyst",
    pendingDeliverables: [
      {
        path: "final/01-core-premise.md",
        minChars: null,
        minMarkdownHeadings: null,
        requiredSnippets: [],
        qualityChecks: {
          requiredTerms: [],
          requiredSections: [],
          minBulletItems: null,
          counters: []
        }
      }
    ],
    openVote: null,
    debateAgentId: "seat-bootstrap",
    workingSet: {
      canonicalSourceFiles: [],
      recentlyReadFiles: [],
      recentlyWrittenFiles: [],
      updatedAt: null
    },
    readableSharedPaths: ["outputs/", "final/"],
    allowedOutputPaths: ["outputs/", "final/"]
  });
  assert.equal(policy.preferredWriteAction, "write_replace");
  assert.deepEqual(policy.allowedActions, ["read", "write_replace"]);
  assert.deepEqual(policy.knownTargetPaths, ["final/01-core-premise.md"]);
  assert.deepEqual(policy.knownWritableTargetPaths, ["final/01-core-premise.md"]);
});

test("resolveRuntimeActionPolicy allows read when a read-only shared target is known", () => {
  const policy = resolveRuntimeActionPolicy({
    roleType: "Analyst",
    pendingDeliverables: [],
    openVote: null,
    debateAgentId: "seat-3",
    workingSet: {
      canonicalSourceFiles: [],
      recentlyReadFiles: [
        {
          path: "facts/board.md",
          source: "shared",
          version: 2,
          updatedAt: new Date().toISOString(),
          excerpt: "Shared but read-only"
        },
        {
          path: "memory/summary.md",
          source: "seat",
          version: null,
          updatedAt: new Date().toISOString(),
          excerpt: "Seat file"
        }
      ],
      recentlyWrittenFiles: [],
      updatedAt: null
    },
    readableSharedPaths: ["facts/board.md"],
    allowedOutputPaths: ["outputs/", "final/"]
  });
  assert.deepEqual(policy.allowedActions, ["read"]);
  assert.deepEqual(policy.knownTargetPaths, ["facts/board.md", "memory/summary.md"]);
  assert.deepEqual(policy.knownWritableTargetPaths, []);
});

test("resolveRuntimeActionPolicy allows read when only a seat-file target is known", () => {
  const policy = resolveRuntimeActionPolicy({
    roleType: "Analyst",
    pendingDeliverables: [],
    openVote: null,
    debateAgentId: "seat-4",
    workingSet: {
      canonicalSourceFiles: [],
      recentlyReadFiles: [
        {
          path: "memory/notes.md",
          source: "seat",
          version: null,
          updatedAt: new Date().toISOString(),
          excerpt: "Seat notes"
        }
      ],
      recentlyWrittenFiles: [],
      updatedAt: null
    },
    readableSharedPaths: ["facts/board.md"],
    allowedOutputPaths: ["outputs/", "final/"]
  });
  assert.deepEqual(policy.allowedActions, ["read"]);
  assert.deepEqual(policy.knownTargetPaths, ["memory/notes.md"]);
  assert.deepEqual(policy.knownWritableTargetPaths, []);
});

test("buildRuntimeActionInstructions only lists allowed JSON shapes", () => {
  const instructions = buildRuntimeActionInstructions({
    policy: {
      allowedActions: ["read", "write_section"],
      preferredWriteAction: "write_section",
      reason: "Known target is a shared markdown source file.",
      knownTargetPaths: ["debate/ideas/selected-s-tier.md"],
      knownWritableTargetPaths: ["debate/ideas/selected-s-tier.md"]
    },
    allowedOutputPaths: ["outputs/", "debate/ideas/selected-s-tier.md"]
  });
  assert.match(instructions, /write_section/);
  assert.doesNotMatch(instructions, /write_append/);
  assert.doesNotMatch(instructions, /vote_cast/);
  assert.match(instructions, /Only the latest HARNESS_ACTION_RESULT is authoritative/i);
});

test("detectRuntimeActionLoop catches repeated identical search", () => {
  let state: RuntimeActionLoopState = { records: [] };
  const record = makeRuntimeActionLoopRecord({ action: "search", query: "marker" });
  state = pushRuntimeActionLoopRecord(state, record);
  state = pushRuntimeActionLoopRecord(state, record);
  assert.match(detectRuntimeActionLoop(state, record) ?? "", /repeated/i);
});
