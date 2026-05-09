import type { AgentRecord, DebateRecord } from "@/lib/types";
import type {
  NormalizedDebateWorkflow,
  WorkflowContextAccessScope,
  WorkflowContextAccessTargetType,
  WorkflowPhaseKind
} from "@/lib/workflow";

import {
  PROMPT_HARD_MAX_CHARS_ANTHROPIC,
  PROMPT_HARD_MAX_CHARS_OPENAI
} from "@/lib/runtime/constants";

export type ResolvedContextAccessRule = {
  category: "alwaysRead" | "readWhenNeeded" | "unlockAfterPhase";
  scope: WorkflowContextAccessScope;
  targetType: WorkflowContextAccessTargetType;
  pathPrefix: string;
  maxFiles: number;
  maxCharsPerFile: number;
  recursive: boolean;
  phaseKind?: WorkflowPhaseKind;
};

export type PromptSection = {
  key: string;
  priority: 0 | 1 | 2 | 3;
  category: "core" | "recent" | "optional";
  content: string | null;
  preferredMaxChars?: number | null;
};

export function isMemoryPath(path: string) {
  const normalized = path.replace(/\\/g, "/").replace(/^\/+/, "").trim().toLowerCase();
  return normalized.startsWith("memory/");
}

export function normalizeContextPath(path: string) {
  return path.replace(/\\/g, "/").replace(/^\/+/, "").trim();
}

export function isDirectChildPath(prefix: string, path: string) {
  const normalizedPrefix = normalizeContextPath(prefix);
  const normalizedPath = normalizeContextPath(path);
  if (!normalizedPath.startsWith(normalizedPrefix)) return false;
  const rest = normalizedPath.slice(normalizedPrefix.length);
  return rest.length > 0 && !rest.includes("/");
}

export function matchesContextAccessPath(rule: Pick<ResolvedContextAccessRule, "targetType" | "pathPrefix" | "recursive">, path: string) {
  const normalizedPath = normalizeContextPath(path);
  const normalizedPrefix = normalizeContextPath(rule.pathPrefix);
  if (rule.targetType === "file") return normalizedPath === normalizedPrefix;
  if (!normalizedPath.startsWith(normalizedPrefix)) return false;
  return rule.recursive ? true : isDirectChildPath(normalizedPrefix, normalizedPath);
}

export function hasContextAccessRules(workflow: NormalizedDebateWorkflow | null) {
  if (!workflow?.enabled) return false;
  return (
    workflow.contextAccess.alwaysRead.length > 0 ||
    workflow.contextAccess.readWhenNeeded.length > 0 ||
    workflow.contextAccess.unlockAfterPhase.length > 0
  );
}

export function getPhaseRank(phaseKind: WorkflowPhaseKind | null | undefined) {
  switch (phaseKind) {
    case "analysis":
      return 1;
    case "deliberation":
      return 2;
    case "finalization_vote":
      return 3;
    case "finalization":
      return 4;
    default:
      return 0;
  }
}

export function isPhaseUnlocked(currentPhaseKind: WorkflowPhaseKind | null | undefined, requiredPhaseKind: WorkflowPhaseKind) {
  return getPhaseRank(currentPhaseKind) >= getPhaseRank(requiredPhaseKind);
}

export function resolveContextAccessRules(
  workflow: NormalizedDebateWorkflow | null,
  currentPhaseKind: WorkflowPhaseKind | null | undefined
) {
  if (!hasContextAccessRules(workflow)) {
    return {
      autoRead: [] as ResolvedContextAccessRule[],
      readable: [] as ResolvedContextAccessRule[],
      locked: [] as ResolvedContextAccessRule[]
    };
  }

  const activeWorkflow = workflow!;
  const autoRead: ResolvedContextAccessRule[] = activeWorkflow.contextAccess.alwaysRead.map((rule) => ({
    ...rule,
    category: "alwaysRead"
  }));
  const readable: ResolvedContextAccessRule[] = activeWorkflow.contextAccess.readWhenNeeded.map((rule) => ({
    ...rule,
    category: "readWhenNeeded"
  }));
  const locked: ResolvedContextAccessRule[] = [];

  for (const rule of activeWorkflow.contextAccess.unlockAfterPhase) {
    if (isPhaseUnlocked(currentPhaseKind, rule.phaseKind)) {
      readable.push({ ...rule, category: "unlockAfterPhase" });
      continue;
    }
    locked.push({ ...rule, category: "unlockAfterPhase" });
  }

  return { autoRead, readable, locked };
}

export function matchContextAccessRule(
  rules: ResolvedContextAccessRule[],
  scope: WorkflowContextAccessScope,
  path: string
) {
  const normalizedPath = normalizeContextPath(path);
  return (
    rules.find((rule) => {
      if (rule.scope !== scope) return false;
      return matchesContextAccessPath(rule, normalizedPath);
    }) ?? null
  );
}

export function buildContextAccessSummaryLines(input: {
  workflow: NormalizedDebateWorkflow | null;
  currentPhaseKind: WorkflowPhaseKind | null | undefined;
}) {
  if (!hasContextAccessRules(input.workflow)) return [] as string[];
  const resolvedRules = resolveContextAccessRules(input.workflow, input.currentPhaseKind);
  const lines = ["Context access policy:"];

  if (resolvedRules.autoRead.length > 0) {
    lines.push("- Auto-read now:");
    for (const rule of resolvedRules.autoRead) {
      lines.push(`  - [${rule.scope}] ${rule.targetType === "file" ? "file" : "dir"} ${rule.pathPrefix}`);
    }
  }

  if (resolvedRules.readable.length > 0) {
    lines.push("- Readable on demand:");
    for (const rule of resolvedRules.readable) {
      lines.push(`  - [${rule.scope}] ${rule.targetType === "file" ? "file" : "dir"} ${rule.pathPrefix}`);
    }
  }

  if (resolvedRules.locked.length > 0) {
    lines.push("- Locked until phase:");
    for (const rule of resolvedRules.locked) {
      lines.push(
        `  - [${rule.scope}] ${rule.targetType === "file" ? "file" : "dir"} ${rule.pathPrefix} · unlock=${rule.phaseKind}`
      );
    }
    lines.push("- IMPORTANT: Locked paths are unavailable in the current phase. Do not try to read them now; wait until they are unlocked.");
  }

  return lines;
}

export function describeContextAccessDenied(
  workflow: NormalizedDebateWorkflow | null,
  currentPhaseKind: WorkflowPhaseKind | null | undefined,
  scope: WorkflowContextAccessScope,
  path: string
) {
  if (!hasContextAccessRules(workflow)) return null;
  const resolvedRules = resolveContextAccessRules(workflow, currentPhaseKind);
  const lockedRule = matchContextAccessRule(resolvedRules.locked, scope, path);
  if (lockedRule) {
    return `LOCKED_UNTIL_PHASE: ${path} requires phase ${lockedRule.phaseKind}. Do not retry in the current phase.`;
  }
  return `ACCESS_DENIED: ${path} is not allowed by workflow.contextAccess`;
}

export function isContextPathReadable(
  workflow: NormalizedDebateWorkflow | null,
  currentPhaseKind: WorkflowPhaseKind | null | undefined,
  scope: WorkflowContextAccessScope,
  path: string
) {
  if (!hasContextAccessRules(workflow)) return true;
  const resolvedRules = resolveContextAccessRules(workflow, currentPhaseKind);
  return Boolean(matchContextAccessRule([...resolvedRules.autoRead, ...resolvedRules.readable], scope, path));
}

export function clipPromptInlineContent(content: string, maxChars = 18_000) {
  if (content.length <= maxChars) return content;
  return `${content.slice(0, maxChars)}\n\n[Truncated: total ${content.length} chars]`;
}

export function getPromptHardMaxChars(agent: Pick<AgentRecord, "provider" | "maxInputTokens" | "contextLength">) {
  const declaredInputLimit = agent.maxInputTokens ?? agent.contextLength;
  const tokenBudget =
    typeof declaredInputLimit === "number" && Number.isFinite(declaredInputLimit)
      ? Math.max(20_000, Math.floor(Number(declaredInputLimit) * 4 * 0.82))
      : agent.provider === "openai"
        ? PROMPT_HARD_MAX_CHARS_OPENAI
        : PROMPT_HARD_MAX_CHARS_ANTHROPIC;
  const providerHardCap = agent.provider === "openai" ? PROMPT_HARD_MAX_CHARS_OPENAI : PROMPT_HARD_MAX_CHARS_ANTHROPIC;
  return Math.min(tokenBudget, providerHardCap);
}

export function planPromptContext(sections: PromptSection[], hardMaxChars: number) {
  const normalizedSections = sections
    .map((section) => ({
      ...section,
      content: section.content?.trim() || null
    }))
    .filter((section): section is PromptSection & { content: string } => Boolean(section.content));

  const totalBudget = Math.max(2_000, hardMaxChars);
  const categoryBudgets = {
    core: Math.max(14_000, Math.floor(totalBudget * 0.72)),
    recent: Math.max(2_500, Math.floor(totalBudget * 0.12)),
    optional: Math.max(2_000, Math.floor(totalBudget * 0.16))
  };
  let remainingBudget = totalBudget;
  const chosenSections: string[] = [];
  const buckets = new Map<string, Array<PromptSection & { content: string }>>();

  for (const section of normalizedSections) {
    const bucketKey = `${section.category}:${section.priority}`;
    const bucket = buckets.get(bucketKey) ?? [];
    bucket.push(section);
    buckets.set(bucketKey, bucket);
  }

  function appendCategory(category: PromptSection["category"], budgetCap: number, ensureCoverage: boolean) {
    const categorySize = [0, 1, 2, 3]
      .map((priority) => buckets.get(`${category}:${priority}`)?.length ?? 0)
      .reduce((sum, count) => sum + count, 0);
    if (categorySize <= 0 || remainingBudget <= 0) return;

    const categoryBudget = Math.min(remainingBudget, Math.max(0, budgetCap));
    if (categoryBudget <= 0) return;

    let categoryRemaining = categoryBudget;
    for (const priority of [0, 1, 2, 3] as const) {
      const priorityBucket = buckets.get(`${category}:${priority}`) ?? [];
      for (let index = 0; index < priorityBucket.length; index += 1) {
        const section = priorityBucket[index];
        if (categoryRemaining <= 0) break;
        const remainingSections = priorityBucket.length - index - 1;
        const reserveForRemaining = ensureCoverage ? remainingSections * 400 : 0;
        const preferredBudget =
          typeof section.preferredMaxChars === "number" && Number.isFinite(section.preferredMaxChars) && section.preferredMaxChars > 0
            ? Math.floor(section.preferredMaxChars)
            : categoryRemaining;
        const minimumBudget = ensureCoverage ? 400 : 600;
        const allowedBudget = Math.max(minimumBudget, categoryRemaining - reserveForRemaining);
        const sectionBudget = Math.max(minimumBudget, Math.min(preferredBudget, allowedBudget));
        const clippedContent = clipPromptInlineContent(section.content, sectionBudget).trim();
        if (!clippedContent) continue;
        chosenSections.push(clippedContent);
        const consumedChars = clippedContent.length + 2;
        categoryRemaining = Math.max(0, categoryRemaining - consumedChars);
        remainingBudget = Math.max(0, remainingBudget - consumedChars);
      }
    }
  }

  appendCategory("core", categoryBudgets.core, true);
  appendCategory("recent", Math.min(categoryBudgets.recent + remainingBudget, totalBudget), false);
  appendCategory("optional", Math.min(categoryBudgets.optional + remainingBudget, totalBudget), false);

  return chosenSections.join("\n\n").trim();
}

export function getPhaseSnapshot(
  currentPhase: { kind: DebateRecord["workflowPhaseKind"]; title: string } | null,
  roundNumber: number
) {
  return {
    workflowPhaseKind: currentPhase?.kind ?? null,
    workflowPhaseTitle: currentPhase?.title ?? null,
    workflowPhaseRound: roundNumber
  };
}
