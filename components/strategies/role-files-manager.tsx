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
  strategyRoleId: string | null;
};

function normalizeRule(item: any): StrategyFileAccessRule {
  return {
    id: String(item.id ?? ""),
    scope: "seat",
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
        : null,
    strategyRoleId: String(item.strategyRoleId ?? "")
  };
}

function formatRuleBadge(rule: StrategyFileAccessRule | null | undefined) {
  if (!rule) return null;
  return rule.accessMode === "always_read" ? "必读" : rule.accessMode === "read_when_needed" ? "按需" : "阶段";
}

function ruleVersion(rules: StrategyFileAccessRule[]) {
  return rules.map((rule) => `${rule.id}:${rule.targetPath}:${rule.accessMode}:${rule.phaseKind ?? ""}`).join("|");
}

export function RoleFilesManagerColumns({
  strategyId,
  roleId,
  readOnly,
  onRulesChange
}: {
  strategyId: string;
  roleId: string;
  readOnly?: boolean;
  onRulesChange?: () => void;
}) {
  const [rules, setRules] = useState<StrategyFileAccessRule[]>([]);
  const adapter = useMemo(
    () => createHttpFileWorkspaceAdapter(`/api/strategies/${strategyId}/roles/${roleId}/files`),
    [strategyId, roleId]
  );

  const refreshRules = useCallback(
    async (showToast?: FileWorkspaceToast) => {
      if (!strategyId || !roleId) return;
      const response = await fetch(`/api/strategies/${strategyId}/file-access-rules`, { cache: "no-store" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        showToast?.("error", payload.error?.message ?? "加载读取规则失败");
        return;
      }
      const items = Array.isArray(payload.data) ? payload.data : [];
      setRules(
        items
          .filter((item: any) => item.scope === "seat" && String(item.strategyRoleId ?? "") === roleId)
          .map(normalizeRule)
      );
    },
    [strategyId, roleId]
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
    accessMode: "always_read" | "read_when_needed",
    showToast: FileWorkspaceToast
  ) {
    if (readOnly || target.type === "root") return;
    const response = await fetch(`/api/strategies/${strategyId}/file-access-rules`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scope: "seat",
        strategyRoleId: roleId,
        targetType: target.type === "file" ? "file" : "dir",
        targetPath: target.path,
        accessMode
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
    if (readOnly || target.type === "root") return;
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
      resetKey={`${strategyId}:${roleId}`}
      readOnly={readOnly}
      treeTitle="目录"
      editorTitle="编辑"
      treeHeight="auto"
      editorHeight="auto"
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
