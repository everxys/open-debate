import type { DebateWorkflowConfig } from "@/lib/workflow";

type Phase2LedgerKey =
  | "currentBattlefieldPath"
  | "selectedSTierPath"
  | "selectedATierPath"
  | "rejectedOrMergedPath"
  | "eventMappingsPath"
  | "newlyInventedIdeasPath";

type Phase2LedgerTemplateDefinition = {
  path: string;
  headings: string[];
  content: string;
};

export const DEFAULT_PHASE2_LEDGER_PATHS: Record<Phase2LedgerKey, string> = {
  currentBattlefieldPath: "debate/ideas/current-battlefield.md",
  selectedSTierPath: "debate/ideas/selected-s-tier.md",
  selectedATierPath: "debate/ideas/selected-a-tier.md",
  rejectedOrMergedPath: "debate/ideas/rejected-or-merged.md",
  eventMappingsPath: "debate/ideas/event-mappings.md",
  newlyInventedIdeasPath: "debate/ideas/newly-invented-ideas.md"
};

const PLACEHOLDER_MARKER_PATTERN =
  /待筛选|待填写|建议结构|请在首轮真实写入后替换本节|请在形成真实结论后替换本节|本文件用于 Phase 3 之后/;

const TEMPLATE_DEFINITIONS: Phase2LedgerTemplateDefinition[] = [
  {
    path: DEFAULT_PHASE2_LEDGER_PATHS.currentBattlefieldPath,
    headings: [
      "# Current Battlefield",
      "## 当前唯一子任务",
      "## 当前最强候选",
      "## 当前最弱一笔",
      "## 下一轮必须继续推进的点"
    ],
    content: `# Current Battlefield

## 当前唯一子任务

- 待填写：把本轮唯一需要推进的压缩任务写在这里。

## 当前最强候选

- 待填写：只保留当前最值得继续打磨的 1-3 个候选。

## 当前最弱一笔

- 待填写：写清当前最大漏洞、最虚的一笔或最该被推翻的方案。

## 下一轮必须继续推进的点

- 待填写：请在首轮真实写入后替换本节。
`
  },
  {
    path: DEFAULT_PHASE2_LEDGER_PATHS.selectedSTierPath,
    headings: ["# S-tier ideas", "## 当前稳定入选", "## 待验证但高价值"],
    content: `# S-tier ideas

## 当前稳定入选

- 待填写：只写已经有较强共识的大点子。

## 待验证但高价值

- 待填写：请在形成真实结论后替换本节。
`
  },
  {
    path: DEFAULT_PHASE2_LEDGER_PATHS.selectedATierPath,
    headings: ["# A-tier ideas", "## 候选A级点子"],
    content: `# A-tier ideas

## 候选A级点子

- 待填写：保留值得继续观察、可能升入 S-tier 的候选。
`
  },
  {
    path: DEFAULT_PHASE2_LEDGER_PATHS.eventMappingsPath,
    headings: ["# Event mappings", "## 核心事件挂接"],
    content: `# Event mappings

## 核心事件挂接

- 待填写：按核心事件整理对应点子、人物、误导与回收关系。
`
  },
  {
    path: DEFAULT_PHASE2_LEDGER_PATHS.rejectedOrMergedPath,
    headings: ["# Rejected or merged", "## 已淘汰", "## 已合并"],
    content: `# Rejected or merged

## 已淘汰

- 待填写：记录为什么删掉，避免同一坏点子反复回流。

## 已合并

- 待填写：记录被并入哪个更强方案。
`
  },
  {
    path: DEFAULT_PHASE2_LEDGER_PATHS.newlyInventedIdeasPath,
    headings: ["# Newly invented ideas", "## 新增原创点子"],
    content: `# Newly invented ideas

## 新增原创点子

- 待填写：记录本场辩论中新发明、且值得后续继续评估的点子。
`
  }
];

const TEMPLATE_BY_PATH = new Map(
  TEMPLATE_DEFINITIONS.map((item) => [normalizeLedgerPath(item.path), item] as const)
);

function normalizeLedgerPath(path: string | null | undefined) {
  return String(path ?? "").replace(/\\/g, "/").replace(/^\/+/, "").trim();
}

function normalizeTemplateText(content: string | null | undefined) {
  return String(content ?? "").replace(/\r\n/g, "\n").trim();
}

export function shouldMaterializePhase2Ledgers(workflow: DebateWorkflowConfig | null | undefined) {
  const ideaBank = workflow?.ideaBank;
  if (!ideaBank) return false;
  if (ideaBank.rawIdeaBankPath) return true;
  return Object.values(ideaBank.derivedFiles ?? {}).some((value) => Boolean(value));
}

export function applyPhase2LedgerWorkflowDefaults(workflow: DebateWorkflowConfig): DebateWorkflowConfig {
  if (!shouldMaterializePhase2Ledgers(workflow)) return workflow;
  const derived = workflow.ideaBank?.derivedFiles ?? {};
  return {
    ...workflow,
    ideaBank: {
      ...workflow.ideaBank,
      derivedFiles: {
        currentBattlefieldPath: derived.currentBattlefieldPath ?? DEFAULT_PHASE2_LEDGER_PATHS.currentBattlefieldPath,
        selectedSTierPath: derived.selectedSTierPath ?? DEFAULT_PHASE2_LEDGER_PATHS.selectedSTierPath,
        selectedATierPath: derived.selectedATierPath ?? DEFAULT_PHASE2_LEDGER_PATHS.selectedATierPath,
        rejectedOrMergedPath: derived.rejectedOrMergedPath ?? DEFAULT_PHASE2_LEDGER_PATHS.rejectedOrMergedPath,
        eventMappingsPath: derived.eventMappingsPath ?? DEFAULT_PHASE2_LEDGER_PATHS.eventMappingsPath,
        newlyInventedIdeasPath: derived.newlyInventedIdeasPath ?? DEFAULT_PHASE2_LEDGER_PATHS.newlyInventedIdeasPath
      }
    }
  };
}

export function getPhase2LedgerTemplate(path: string | null | undefined) {
  return TEMPLATE_BY_PATH.get(normalizeLedgerPath(path)) ?? null;
}

export function getPhase2LedgerHeadings(path: string | null | undefined) {
  return getPhase2LedgerTemplate(path)?.headings ?? [];
}

export function isPhase2LedgerPath(path: string | null | undefined) {
  return TEMPLATE_BY_PATH.has(normalizeLedgerPath(path));
}

export function isPhase2LedgerPlaceholderContent(path: string | null | undefined, content: string | null | undefined) {
  const normalizedContent = normalizeTemplateText(content);
  if (!normalizedContent) return true;
  const template = getPhase2LedgerTemplate(path);
  if (template && normalizeTemplateText(template.content) === normalizedContent) {
    return true;
  }
  if (normalizedContent.length > 1_600) return false;
  return PLACEHOLDER_MARKER_PATTERN.test(normalizedContent);
}

export function listConfiguredPhase2LedgerSeeds(workflow: DebateWorkflowConfig | null | undefined) {
  if (!workflow) return [] as Phase2LedgerTemplateDefinition[];
  const patched = applyPhase2LedgerWorkflowDefaults(workflow);
  const derived = patched.ideaBank?.derivedFiles;
  if (!derived) return [] as Phase2LedgerTemplateDefinition[];
  return [
    derived.currentBattlefieldPath,
    derived.selectedSTierPath,
    derived.selectedATierPath,
    derived.rejectedOrMergedPath,
    derived.eventMappingsPath,
    derived.newlyInventedIdeasPath
  ]
    .map((path) => getPhase2LedgerTemplate(path))
    .filter((item): item is Phase2LedgerTemplateDefinition => Boolean(item));
}
