import test from "node:test";
import assert from "node:assert/strict";

import {
  PLAYGROUND_CHECKLIST_CASES,
  evaluateChecklistCase,
  getChecklistCasesBySuiteIds,
  normalizeChecklistSuiteIds
} from "@/lib/playground/checklist";
import { buildOpenAiTools } from "@/lib/runtime/provider-shared";
import {
  PLAYGROUND_CHECKLIST_SUITES,
  PLAYGROUND_DEFAULT_CHECKLIST_SUITE_IDS
} from "@/lib/playground/types";

function extractOpenAiToolNames(enableVoting: boolean) {
  return buildOpenAiTools({ enableVoting, allowedOutputPaths: ["sandbox/", "outputs/"] }).map((tool) =>
    String((tool as { function?: { name?: unknown } }).function?.name ?? "")
  );
}

test("playground checklist suites keep base selected by default and voting optional", () => {
  assert.deepEqual(PLAYGROUND_DEFAULT_CHECKLIST_SUITE_IDS, ["base"]);
  const baseSuite = PLAYGROUND_CHECKLIST_SUITES.find((suite) => suite.id === "base");
  const votingSuite = PLAYGROUND_CHECKLIST_SUITES.find((suite) => suite.id === "voting");
  assert.ok(baseSuite);
  assert.ok(votingSuite);
  assert.equal(baseSuite.defaultSelected, true);
  assert.equal(votingSuite.defaultSelected, false);
});

test("normalizeChecklistSuiteIds falls back to base suite", () => {
  assert.deepEqual(normalizeChecklistSuiteIds([]), ["base"]);
  assert.deepEqual(normalizeChecklistSuiteIds(["unknown"]), ["base"]);
  assert.deepEqual(normalizeChecklistSuiteIds(["base", "voting"]), ["base", "voting"]);
});

test("getChecklistCasesBySuiteIds expands selected suites to the expected checklist cases", () => {
  assert.deepEqual(
    getChecklistCasesBySuiteIds(["base"]).map((item) => item.id),
    [
      "agent_files_list",
      "agent_files_read",
      "agent_files_search",
      "debate_files_read",
      "debate_files_stat",
      "debate_files_write",
      "harness_read",
      "harness_write"
    ]
  );
  assert.deepEqual(
    getChecklistCasesBySuiteIds(["voting"]).map((item) => item.id),
    ["debate_vote_open", "debate_vote_cast", "debate_vote_close", "harness_vote_cast"]
  );
});

test("selected suite coverage stays aligned with runtime tools", () => {
  const baseSuiteToolNames = getChecklistCasesBySuiteIds(["base"])
    .map((item) => item.id)
    .filter((item) => !item.startsWith("harness_"));
  assert.deepEqual(baseSuiteToolNames, extractOpenAiToolNames(false));

  const allSuiteToolNames = getChecklistCasesBySuiteIds(["base", "voting"])
    .map((item) => item.id)
    .filter((item) => !item.startsWith("harness_"));
  assert.deepEqual(allSuiteToolNames, extractOpenAiToolNames(true));
});

test("all checklist cases are assigned to a known suite", () => {
  const knownSuites = new Set(PLAYGROUND_CHECKLIST_SUITES.map((suite) => suite.id));
  for (const item of PLAYGROUND_CHECKLIST_CASES) {
    assert.equal(knownSuites.has(item.suiteId), true, `${item.id} should belong to a known suite`);
  }
});

test("evaluateChecklistCase passes agent_files_list when expected path is listed", () => {
  const item = PLAYGROUND_CHECKLIST_CASES.find((entry) => entry.id === "agent_files_list");
  assert.ok(item);
  const result = evaluateChecklistCase({
    item,
    finalText: "sandbox/reports/list-alpha.md\nsandbox/reports/list-beta.md",
    toolExecutions: [
      {
        id: "1",
        toolName: "agent_files_list",
        parsedArguments: { prefix: "sandbox/reports/" },
        result: ["sandbox/reports/list-alpha.md", "sandbox/reports/list-beta.md"],
        ok: true,
        at: new Date().toISOString()
      }
    ],
    sandboxFilesAfter: []
  });
  assert.equal(result.passed, true);
});

test("evaluateChecklistCase requires final answer to mention the searched target path", () => {
  const item = PLAYGROUND_CHECKLIST_CASES.find((entry) => entry.id === "agent_files_search");
  assert.ok(item);
  const result = evaluateChecklistCase({
    item,
    finalText: "SEARCH_MARKER_2049",
    toolExecutions: [
      {
        id: "search-1",
        toolName: "agent_files_search",
        parsedArguments: { query: "SEARCH_MARKER_2049" },
        result: [{ path: "sandbox/search-target.md", snippet: "SEARCH_MARKER_2049 is here." }],
        ok: true,
        at: new Date().toISOString()
      }
    ],
    sandboxFilesAfter: []
  });
  assert.equal(result.passed, false);
  assert.match(result.errorMessage ?? "", /目标路径/);
});

test("evaluateChecklistCase fails debate_files_write when target file was not created", () => {
  const item = PLAYGROUND_CHECKLIST_CASES.find((entry) => entry.id === "debate_files_write");
  assert.ok(item);
  const result = evaluateChecklistCase({
    item,
    finalText: "I wrote the file.",
    toolExecutions: [
      {
        id: "2",
        toolName: "debate_files_write",
        parsedArguments: { path: "outputs/write-check.md" },
        result: { ok: true },
        ok: true,
        at: new Date().toISOString()
      }
    ],
    sandboxFilesAfter: []
  });
  assert.equal(result.passed, false);
  assert.match(result.errorMessage ?? "", /目标输出文件/);
});

test("evaluateChecklistCase passes debate_files_write only when sandbox contains the persisted marker", () => {
  const item = PLAYGROUND_CHECKLIST_CASES.find((entry) => entry.id === "debate_files_write");
  assert.ok(item);
  const result = evaluateChecklistCase({
    item,
    finalText: "",
    toolExecutions: [
      {
        id: "3",
        toolName: "debate_files_write",
        parsedArguments: { path: "outputs/write-check.md" },
        result: { ok: true, path: "outputs/write-check.md" },
        ok: true,
        at: new Date().toISOString()
      }
    ],
    sandboxFilesAfter: [
      {
        scope: "debate",
        path: "outputs/write-check.md",
        content: "TITLE: Sandbox Summary\nBODY: WRITE_MARKER_391",
        size: 46,
        version: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    ]
  });
  assert.equal(result.passed, true);
});

test("evaluateChecklistCase passes debate_vote_close only when result winner and vote files are persisted", () => {
  const item = PLAYGROUND_CHECKLIST_CASES.find((entry) => entry.id === "debate_vote_close");
  assert.ok(item);
  const result = evaluateChecklistCase({
    item,
    finalText: "VOTE_CLOSED | Option Beta",
    toolExecutions: [
      {
        id: "vote-open",
        toolName: "debate_vote_open",
        parsedArguments: {},
        result: { ok: true },
        ok: true,
        at: new Date().toISOString()
      },
      {
        id: "vote-cast",
        toolName: "debate_vote_cast",
        parsedArguments: {},
        result: { ok: true },
        ok: true,
        at: new Date().toISOString()
      },
      {
        id: "vote-close",
        toolName: "debate_vote_close",
        parsedArguments: {},
        result: { ok: true, closed: { result: { winner: "Option Beta" } } },
        ok: true,
        at: new Date().toISOString()
      }
    ],
    sandboxFilesAfter: [
      {
        scope: "debate",
        path: "outputs/vote-result.md",
        content: "# Sandbox Vote Result",
        size: 22,
        version: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      {
        scope: "debate",
        path: "outputs/vote-result.json",
        content: "{\"status\":\"closed\"}",
        size: 19,
        version: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    ]
  });
  assert.equal(result.passed, true);
});

test("evaluateChecklistCase passes harness_write only when sandbox contains the persisted marker", () => {
  const item = PLAYGROUND_CHECKLIST_CASES.find((entry) => entry.id === "harness_write");
  assert.ok(item);
  const result = evaluateChecklistCase({
    item,
    finalText: "HARNESS_WRITE_DONE",
    toolExecutions: [
      {
        id: "hw-1",
        toolName: "harness_write",
        parsedArguments: { action: "write_replace", path: "outputs/harness-write.md" },
        result: { ok: true, path: "outputs/harness-write.md" },
        ok: true,
        at: new Date().toISOString()
      }
    ],
    sandboxFilesAfter: [
      {
        scope: "debate",
        path: "outputs/harness-write.md",
        content: "TITLE: Harness Summary\nBODY: HARNESS_WRITE_MARKER_443",
        size: 54,
        version: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    ]
  });
  assert.equal(result.passed, true);
});
