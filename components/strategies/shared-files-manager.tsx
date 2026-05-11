"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import type { FileWorkspaceTarget, FileWorkspaceToast } from "@/components/file-workspace/file-workspace";
import { FileWorkspace } from "@/components/file-workspace/file-workspace";
import { createHttpFileWorkspaceAdapter } from "@/components/file-workspace/http-adapter";

type StrategyFileAccessRule = {
  id: string;
  scope: "shared" | "seat";
  targetType: "file" | "dir";
  targetPath: string;
  accessMode: "always_read" | "read_when_needed" | "unlock_after_phase";
  phaseKind: "analysis" | "deliberation" | "finalization_vote" | "finalization" | null;
};

function normalizeRule(item: any): StrategyFileAccessRule {
  return {
    id: String(item.id ?? ""),
    scope: "shared",
    targetType: item.targetType === "file" ? "file" : "dir",
    targetPath: String(item.targetPath ?? ""),
    accessMode:
      item.accessMode === "unlock_after_phase"
        ? "unlock_after_phase"
        : item.accessMode === "read_when_needed"
          ? "read_when_needed"
          : "always_read",
    phaseKind:
      item.phaseKind === "analysis" ||
      item.phaseKind === "deliberation" ||
      item.phaseKind === "finalization_vote" ||
      item.phaseKind === "finalization"
        ? item.phaseKind
        : null
  };
}

function formatRuleBadge(rule: StrategyFileAccessRule | null | undefined) {
  if (!rule) return null;
  if (rule.accessMode === "always_read") return "必读";
  if (rule.accessMode === "read_when_needed") return "按需";
  return rule.phaseKind ? `阶段:${rule.phaseKind}` : "阶段解锁";
}

function ruleVersion(rules: StrategyFileAccessRule[]) {
  return rules.map((rule) => `${rule.id}:${rule.targetPath}:${rule.accessMode}:${rule.phaseKind ?? ""}`).join("|");
}

export function StrategySharedFilesManagerColumns({
  strategyId,
  readOnly,
  onRulesChange
}: {
  strategyId: string;
  readOnly?: boolean;
  onRulesChange?: () => void;
}) {
  const [rules, setRules] = useState<StrategyFileAccessRule[]>([]);
  const adapter = useMemo(
    () => createHttpFileWorkspaceAdapter(`/api/strategies/${strategyId}/shared-files`),
    [strategyId]
  );

  const refreshRules = useCallback(
    async (showToast?: FileWorkspaceToast) => {
      if (!strategyId) return;
      const response = await fetch(`/api/strategies/${strategyId}/file-access-rules`, { cache: "no-store" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        showToast?.("error", payload.error?.message ?? "加载读取规则失败");
        return;
      }
      const items = Array.isArray(payload.data) ? payload.data : [];
      setRules(items.filter((item: any) => item.scope === "shared").map(normalizeRule));
    },
    [strategyId]
  );

  useEffect(() => {
    void refreshRules();
  }, [refreshRules]);

  const ruleByPath = useMemo(() => {
    const next: Record<string, StrategyFileAccessRule | undefined> = {};
    for (const rule of rules) next[rule.targetPath] = rule;
    return next;
  }, [rules]);

  async function applyRule(
    target: FileWorkspaceTarget,
    accessMode: StrategyFileAccessRule["accessMode"],
    showToast: FileWorkspaceToast
  ) {
    if (readOnly || !strategyId || target.type === "root") return;
    const existing = ruleByPath[target.path];
    const phaseKind =
      accessMode === "unlock_after_phase"
        ? window.prompt(
            "输入解锁阶段：analysis / deliberation / finalization_vote / finalization",
            existing?.phaseKind ?? "deliberation"
          )
        : null;
    if (
      accessMode === "unlock_after_phase" &&
      phaseKind !== "analysis" &&
      phaseKind !== "deliberation" &&
      phaseKind !== "finalization_vote" &&
      phaseKind !== "finalization"
    ) {
      showToast("error", "阶段无效");
      return;
    }

    const response = await fetch(`/api/strategies/${strategyId}/file-access-rules`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scope: "shared",
        targetType: target.type === "file" ? "file" : "dir",
        targetPath: target.path,
        accessMode,
        phaseKind
      })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      showToast("error", payload.error?.message ?? "设置读取规则失败");
      return;
    }
    await refreshRules(showToast);
    onRulesChange?.();
    showToast("success", "读取规则已更新");
  }

  async function clearRule(target: FileWorkspaceTarget, showToast: FileWorkspaceToast) {
    if (readOnly || !strategyId || target.type === "root") return;
    const existing = ruleByPath[target.path];
    if (!existing) {
      showToast("success", "当前未设置读取规则");
      return;
    }
    const response = await fetch(`/api/strategies/${strategyId}/file-access-rules/${existing.id}`, { method: "DELETE" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      showToast("error", payload.error?.message ?? "清除读取规则失败");
      return;
    }
    await refreshRules(showToast);
    onRulesChange?.();
    showToast("success", "读取规则已清除");
  }

  return (
    <FileWorkspace
      adapter={adapter}
      resetKey={strategyId}
      readOnly={readOnly}
      treeTitle="目录"
      treeEmptyText="暂无共享文件"
      editorTitle="共享文件编辑"
      editorEmptyPathText="请选择一个文件进行编辑"
      showCreateFileButton
      treeHeight={360}
      editorHeight={360}
      treeIndent={16}
      rowHeight={30}
      badgeVersion={ruleVersion(rules)}
      renderPathBadge={(target) => {
        const label = formatRuleBadge(ruleByPath[target.path]);
        return label ? (
          <span className="badge badge-completed" style={{ marginLeft: "auto" }}>
            {label}
          </span>
        ) : null;
      }}
      renderContextItems={({ target, close, readOnly: targetReadOnly, showToast }) =>
        target.type !== "root" ? (
          <>
            <button
              className="contextMenuItem"
              disabled={targetReadOnly}
              onClick={() => {
                close();
                void applyRule(target, "always_read", showToast);
              }}
            >
              标记为每会话必读
            </button>
            <button
              className="contextMenuItem"
              disabled={targetReadOnly}
              onClick={() => {
                close();
                void applyRule(target, "read_when_needed", showToast);
              }}
            >
              标记为按需可读
            </button>
            <button
              className="contextMenuItem"
              disabled={targetReadOnly}
              onClick={() => {
                close();
                void applyRule(target, "unlock_after_phase", showToast);
              }}
            >
              标记为阶段解锁
            </button>
            <button
              className="contextMenuItem"
              disabled={targetReadOnly}
              onClick={() => {
                close();
                void clearRule(target, showToast);
              }}
            >
              清除规则
            </button>
          </>
        ) : null
      }
    />
  );
}
