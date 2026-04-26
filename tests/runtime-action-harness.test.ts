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
    currentPhaseKind: "deliberation",
    pendingDeliverables: [],
    phasePreferredWritablePaths: [],
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
  assert.deepEqual(policy.preferredWritableTargetPaths, []);
});

test("resolveRuntimeActionPolicy prefers write_replace for template phase ledger files", () => {
  const policy = resolveRuntimeActionPolicy({
    roleType: "Analyst",
    currentPhaseKind: "deliberation",
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
    phasePreferredWritablePaths: ["debate/ideas/selected-s-tier.md"],
    openVote: null,
    debateAgentId: "seat-2",
    workingSet: {
      canonicalSourceFiles: [
        {
          path: "debate/ideas/selected-s-tier.md",
          source: "shared",
          version: 3,
          updatedAt: new Date().toISOString(),
          excerpt: "# S-tier ideas\n\n## 当前稳定入选\n\n- 待填写：只写已经有较强共识的大点子。"
        }
      ],
      recentlyReadFiles: [],
      recentlyWrittenFiles: [],
      updatedAt: null
    },
    readableSharedPaths: ["outputs/", "final/", "debate/ideas/selected-s-tier.md"],
    allowedOutputPaths: ["outputs/", "final/", "debate/ideas/selected-s-tier.md"]
  });
  assert.equal(policy.preferredWriteAction, "write_replace");
  assert.deepEqual(policy.allowedActions, ["read", "write_replace"]);
  assert.deepEqual(policy.knownTargetPaths, ["debate/ideas/selected-s-tier.md", "outputs/final-answer.md"]);
  assert.deepEqual(policy.knownWritableTargetPaths, ["debate/ideas/selected-s-tier.md", "outputs/final-answer.md"]);
  assert.deepEqual(policy.preferredWritableTargetPaths, ["debate/ideas/selected-s-tier.md"]);
});

test("resolveRuntimeActionPolicy bootstraps phase ledger targets with write_replace before final deliverables", () => {
  const policy = resolveRuntimeActionPolicy({
    roleType: "Analyst",
    currentPhaseKind: "deliberation",
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
    phasePreferredWritablePaths: ["debate/ideas/current-battlefield.md", "debate/ideas/selected-s-tier.md"],
    openVote: null,
    debateAgentId: "seat-bootstrap",
    workingSet: {
      canonicalSourceFiles: [],
      recentlyReadFiles: [],
      recentlyWrittenFiles: [],
      updatedAt: null
    },
    readableSharedPaths: ["outputs/", "final/"],
    allowedOutputPaths: ["outputs/", "final/", "debate/ideas/current-battlefield.md", "debate/ideas/selected-s-tier.md"]
  });
  assert.equal(policy.preferredWriteAction, "write_replace");
  assert.deepEqual(policy.allowedActions, ["read", "write_replace"]);
  assert.deepEqual(policy.preferredWritableTargetPaths, ["debate/ideas/current-battlefield.md", "debate/ideas/selected-s-tier.md"]);
  assert.deepEqual(policy.knownTargetPaths, [
    "debate/ideas/current-battlefield.md",
    "debate/ideas/selected-s-tier.md",
    "final/01-core-premise.md"
  ]);
  assert.deepEqual(policy.knownWritableTargetPaths, [
    "debate/ideas/current-battlefield.md",
    "debate/ideas/selected-s-tier.md",
    "final/01-core-premise.md"
  ]);
});

test("resolveRuntimeActionPolicy requires a read before write_section on structured phase ledgers", () => {
  const policy = resolveRuntimeActionPolicy({
    roleType: "Analyst",
    currentPhaseKind: "deliberation",
    pendingDeliverables: [],
    phasePreferredWritablePaths: ["debate/ideas/selected-s-tier.md"],
    openVote: null,
    debateAgentId: "seat-structured",
    workingSet: {
      canonicalSourceFiles: [
        {
          path: "debate/ideas/selected-s-tier.md",
          source: "shared",
          version: 4,
          updatedAt: new Date().toISOString(),
          excerpt: "# S-tier ideas\n\n## 当前稳定入选\n\n- 方案 A\n\n## 待验证但高价值\n\n- 方案 B"
        }
      ],
      recentlyReadFiles: [],
      recentlyWrittenFiles: [],
      updatedAt: null
    },
    readableSharedPaths: ["debate/ideas/selected-s-tier.md"],
    allowedOutputPaths: ["debate/ideas/selected-s-tier.md"]
  });
  assert.equal(policy.preferredWriteAction, null);
  assert.deepEqual(policy.allowedActions, ["read"]);
});

test("resolveRuntimeActionPolicy allows write_section after structured phase ledger has been read", () => {
  const policy = resolveRuntimeActionPolicy({
    roleType: "Analyst",
    currentPhaseKind: "deliberation",
    pendingDeliverables: [],
    phasePreferredWritablePaths: ["debate/ideas/selected-s-tier.md"],
    openVote: null,
    debateAgentId: "seat-structured-read",
    workingSet: {
      canonicalSourceFiles: [
        {
          path: "debate/ideas/selected-s-tier.md",
          source: "shared",
          version: 4,
          updatedAt: new Date().toISOString(),
          excerpt: "# S-tier ideas\n\n## 当前稳定入选\n\n- 方案 A\n\n## 待验证但高价值\n\n- 方案 B"
        }
      ],
      recentlyReadFiles: [
        {
          path: "debate/ideas/selected-s-tier.md",
          source: "shared",
          version: 4,
          updatedAt: new Date().toISOString(),
          excerpt: "# S-tier ideas\n\n## 当前稳定入选\n\n- 方案 A\n\n## 待验证但高价值\n\n- 方案 B"
        }
      ],
      recentlyWrittenFiles: [],
      updatedAt: null
    },
    readableSharedPaths: ["debate/ideas/selected-s-tier.md"],
    allowedOutputPaths: ["debate/ideas/selected-s-tier.md"]
  });
  assert.equal(policy.preferredWriteAction, "write_section");
  assert.deepEqual(policy.allowedActions, ["read", "write_section"]);
  assert.deepEqual(policy.preferredWritableHeadingsByPath["debate/ideas/selected-s-tier.md"], [
    "# S-tier ideas",
    "## 当前稳定入选",
    "## 待验证但高价值"
  ]);
});

test("resolveRuntimeActionPolicy downgrades repeated heading-mismatch targets to read or replace", () => {
  const replacePolicy = resolveRuntimeActionPolicy({
    roleType: "Analyst",
    currentPhaseKind: "deliberation",
    pendingDeliverables: [],
    phasePreferredWritablePaths: ["debate/ideas/current-battlefield.md"],
    forcedReplacePaths: ["debate/ideas/current-battlefield.md"],
    openVote: null,
    debateAgentId: "seat-recover-replace",
    workingSet: {
      canonicalSourceFiles: [],
      recentlyReadFiles: [],
      recentlyWrittenFiles: [],
      updatedAt: null
    },
    readableSharedPaths: ["debate/ideas/current-battlefield.md"],
    allowedOutputPaths: ["debate/ideas/current-battlefield.md"]
  });
  assert.equal(replacePolicy.preferredWriteAction, "write_replace");

  const readPolicy = resolveRuntimeActionPolicy({
    roleType: "Analyst",
    currentPhaseKind: "deliberation",
    pendingDeliverables: [],
    phasePreferredWritablePaths: ["debate/ideas/selected-s-tier.md"],
    forcedReadPaths: ["debate/ideas/selected-s-tier.md"],
    suppressedWriteSectionPaths: ["debate/ideas/selected-s-tier.md"],
    openVote: null,
    debateAgentId: "seat-recover-read",
    workingSet: {
      canonicalSourceFiles: [
        {
          path: "debate/ideas/selected-s-tier.md",
          source: "shared",
          version: 4,
          updatedAt: new Date().toISOString(),
          excerpt: "# S-tier ideas\n\n## 当前稳定入选\n\n- 方案 A\n\n## 待验证但高价值\n\n- 方案 B"
        }
      ],
      recentlyReadFiles: [],
      recentlyWrittenFiles: [],
      updatedAt: null
    },
    readableSharedPaths: ["debate/ideas/selected-s-tier.md"],
    allowedOutputPaths: ["debate/ideas/selected-s-tier.md"]
  });
  assert.equal(readPolicy.preferredWriteAction, null);
  assert.deepEqual(readPolicy.allowedActions, ["read"]);
});

test("resolveRuntimeActionPolicy allows read when a read-only shared target is known", () => {
  const policy = resolveRuntimeActionPolicy({
    roleType: "Analyst",
    currentPhaseKind: "analysis",
    pendingDeliverables: [],
    phasePreferredWritablePaths: [],
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
  assert.deepEqual(policy.preferredWritableTargetPaths, []);
});

test("resolveRuntimeActionPolicy allows read when only a seat-file target is known", () => {
  const policy = resolveRuntimeActionPolicy({
    roleType: "Analyst",
    currentPhaseKind: "analysis",
    pendingDeliverables: [],
    phasePreferredWritablePaths: [],
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
  assert.deepEqual(policy.preferredWritableTargetPaths, []);
});

test("buildRuntimeActionInstructions only lists allowed JSON shapes", () => {
  const instructions = buildRuntimeActionInstructions({
    policy: {
      allowedActions: ["read", "write_section"],
      preferredWriteAction: "write_section",
      reason: "Known target is a shared markdown source file.",
      knownTargetPaths: ["debate/ideas/selected-s-tier.md"],
      knownWritableTargetPaths: ["debate/ideas/selected-s-tier.md"],
      preferredWritableTargetPaths: ["debate/ideas/selected-s-tier.md"],
      preferredWritableHeadingsByPath: {
        "debate/ideas/selected-s-tier.md": ["# S-tier ideas", "## 当前稳定入选", "## 待验证但高价值"]
      }
    },
    allowedOutputPaths: ["outputs/", "debate/ideas/selected-s-tier.md"]
  });
  assert.match(instructions, /write_section/);
  assert.match(instructions, /Eligible section headings/i);
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
