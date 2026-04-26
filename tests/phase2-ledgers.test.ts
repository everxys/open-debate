import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_PHASE2_LEDGER_PATHS,
  applyPhase2LedgerWorkflowDefaults,
  getPhase2LedgerTemplate,
  isPhase2LedgerPlaceholderContent,
  listConfiguredPhase2LedgerSeeds
} from "@/lib/phase2-ledgers";
import { createDefaultDebateWorkflowConfig } from "@/lib/workflow";

test("applyPhase2LedgerWorkflowDefaults fills missing derived ledger paths when idea bank is enabled", () => {
  const workflow = createDefaultDebateWorkflowConfig();
  assert.ok(workflow.ideaBank?.derivedFiles);
  workflow.ideaBank.rawIdeaBankPath = "debate/ideas/raw-idea-bank.md";
  workflow.ideaBank.derivedFiles.selectedSTierPath = "debate/ideas/selected-s-tier.md";

  const patched = applyPhase2LedgerWorkflowDefaults(workflow);
  assert.ok(patched.ideaBank?.derivedFiles);

  assert.equal(patched.ideaBank.derivedFiles.currentBattlefieldPath, DEFAULT_PHASE2_LEDGER_PATHS.currentBattlefieldPath);
  assert.equal(patched.ideaBank.derivedFiles.eventMappingsPath, DEFAULT_PHASE2_LEDGER_PATHS.eventMappingsPath);
  assert.equal(patched.ideaBank.derivedFiles.selectedSTierPath, "debate/ideas/selected-s-tier.md");
});

test("listConfiguredPhase2LedgerSeeds returns current Phase 2 templates", () => {
  const workflow = createDefaultDebateWorkflowConfig();
  assert.ok(workflow.ideaBank);
  workflow.ideaBank.rawIdeaBankPath = "debate/ideas/raw-idea-bank.md";

  const seeds = listConfiguredPhase2LedgerSeeds(applyPhase2LedgerWorkflowDefaults(workflow));

  assert.equal(seeds.length, 6);
  assert.ok(seeds.some((item) => item.path === DEFAULT_PHASE2_LEDGER_PATHS.currentBattlefieldPath));
  assert.match(
    seeds.find((item) => item.path === DEFAULT_PHASE2_LEDGER_PATHS.selectedSTierPath)?.content ?? "",
    /# S-tier ideas/
  );
});

test("isPhase2LedgerPlaceholderContent detects both old and new placeholder templates", () => {
  const selectedSTierTemplate = getPhase2LedgerTemplate(DEFAULT_PHASE2_LEDGER_PATHS.selectedSTierPath);
  assert.ok(selectedSTierTemplate);
  assert.equal(
    isPhase2LedgerPlaceholderContent(DEFAULT_PHASE2_LEDGER_PATHS.selectedSTierPath, selectedSTierTemplate?.content ?? ""),
    true
  );
  assert.equal(
    isPhase2LedgerPlaceholderContent(
      DEFAULT_PHASE2_LEDGER_PATHS.selectedSTierPath,
      "# S 级核心点子（待筛选）\n\n本文件用于 Phase 3 之后沉淀最关键的大点子。"
    ),
    true
  );
  assert.equal(
    isPhase2LedgerPlaceholderContent(
      DEFAULT_PHASE2_LEDGER_PATHS.selectedSTierPath,
      "# S-tier ideas\n\n## 当前稳定入选\n\n- 方案 A：已形成明确机制。\n\n## 待验证但高价值\n\n- 方案 B：需要补终局代价。"
    ),
    false
  );
});
