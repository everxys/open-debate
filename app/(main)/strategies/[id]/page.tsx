"use client";

import { useParams, useRouter } from "next/navigation";
import { startTransition, useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";

import { RoleFilesManagerColumns } from "@/components/strategies/role-files-manager";
import { StrategySharedFilesManagerColumns } from "@/components/strategies/shared-files-manager";
import { useAutoDismissToast } from "@/components/ui/use-toast";
import type {
  FileWithWebkitRelativePath,
  ImportedStrategyManifestPreview,
  RoleDraft,
  StrategyDetail,
  StrategyPanel,
  WorkflowConfigPayload,
  WorkflowContextAccess,
  WorkflowContextAccessRule,
  WorkflowPhaseGateRule,
  WorkflowPhasePrompt,
  WorkflowPromptDialogState,
  WorkflowSummarizer
} from "./strategy-detail-types";
import {
  createClientId,
  createContextAccessRule,
  createPhaseGateRule,
  normalizeContextAccessPayload,
  normalizeStrategyFileAccessRules,
  normalizeSummarizerPayload,
  readPayload,
  stripImportedRootPrefix,
  summarizePrompt,
  summarizeRoles
} from "./strategy-detail-utils";
import { StrategyAdvancedSection, StrategyOverviewSection, WorkflowPromptDialog } from "./strategy-detail-sections";
import { useMountedStrategyPanels, useStrategyFileAccessRules } from "./use-strategy-detail-panels";

export default function StrategyDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const router = useRouter();
  const { toast, showToast } = useAutoDismissToast(1200);

  const [detail, setDetail] = useState<StrategyDetail | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [isShared, setIsShared] = useState(false);
  const [roles, setRoles] = useState<RoleDraft[]>([]);
  const [activeRoleIndex, setActiveRoleIndex] = useState<number>(0);
  const [selectedRoleIds, setSelectedRoleIds] = useState<Set<string>>(() => new Set());
  const roleSelectionAnchorIndexRef = useRef<number | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isSavingAll, setIsSavingAll] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isDuplicatingRole, setIsDuplicatingRole] = useState(false);
  const [isFavoriting, setIsFavoriting] = useState(false);
  const [isForking, setIsForking] = useState(false);
  const [isExportingFolder, setIsExportingFolder] = useState(false);
  const [isImportingFolder, setIsImportingFolder] = useState(false);
  const [workflowPhasePrompts, setWorkflowPhasePrompts] = useState<WorkflowPhasePrompt[]>([]);
  const [workflowPhasePromptsLoading, setWorkflowPhasePromptsLoading] = useState(false);
  const [workflowPhasePromptsSaving, setWorkflowPhasePromptsSaving] = useState(false);
  const [workflowPromptDialog, setWorkflowPromptDialog] = useState<WorkflowPromptDialogState>(null);
  const [workflowConfig, setWorkflowConfig] = useState<WorkflowConfigPayload | null>(null);
  const [workflowContextAccess, setWorkflowContextAccess] = useState<WorkflowContextAccess>({
    alwaysRead: [],
    readWhenNeeded: [],
    unlockAfterPhase: []
  });
  const [workflowSummarizer, setWorkflowSummarizer] = useState<WorkflowSummarizer>({
    enabled: false,
    perTurn: true,
    perRound: true,
    factsBoard: true,
    prompts: {
      turnSummary: "",
      roundSummary: "",
      factsBoard: ""
    },
    outputPaths: {
      turnSummaryDir: "debate/turn_summaries/",
      roundSummaryDir: "debate/round_summaries/",
      factsBoardPath: "facts/board.md"
    }
  });
  const [workflowContextAccessLoading, setWorkflowContextAccessLoading] = useState(false);
  const [workflowContextAccessSaving, setWorkflowContextAccessSaving] = useState(false);
  const [workflowSummarizerSaving, setWorkflowSummarizerSaving] = useState(false);
  const folderImportInputRef = useRef<HTMLInputElement | null>(null);
  const [strategyPanel, setStrategyPanel] = useState<StrategyPanel>("shared");
  const mountedPanels = useMountedStrategyPanels(strategyPanel);
  const {
    fileAccessRules,
    setFileAccessRules,
    fileAccessRulesLoading,
    refreshFileAccessRules
  } = useStrategyFileAccessRules({ strategyId: id, showToast });

  const load = useCallback(async () => {
    if (!id) return;
    const response = await fetch(`/api/strategies/${id}`);
    const payload = await readPayload(response);
    if (!response.ok) {
      showToast("error", payload.error?.message ?? "加载失败");
      return;
    }
    const data = payload.data as StrategyDetail;
    setDetail(data);
    setName(data.name);
    setDescription(data.description ?? "");
    setIsShared(data.isShared);
    const nextRoles = (data.roles ?? [])
      .slice()
      .sort((a, b) => a.roleOrder - b.roleOrder)
      .map((role) => ({ clientId: role.id, id: role.id, name: role.name, systemPrompt: role.systemPrompt ?? "" }));
    setRoles(nextRoles);
    setSelectedRoleIds(new Set());
    setActiveRoleIndex((current) => {
      if (current >= 0 && current < nextRoles.length) return current;
      return 0;
    });
    roleSelectionAnchorIndexRef.current = null;

    setWorkflowPhasePromptsLoading(true);
    setWorkflowContextAccessLoading(true);
    try {
      const [workflowResponse, workflowConfigResponse, fileAccessRulesResponse] = await Promise.all([
        fetch(`/api/strategies/${id}/workflow-phase-prompts`),
        fetch(`/api/strategies/${id}/workflow-config`),
        fetch(`/api/strategies/${id}/file-access-rules`, { cache: "no-store" })
      ]);
      const workflowPayload = await readPayload(workflowResponse);
      const workflowConfigPayload = await readPayload(workflowConfigResponse);
      const fileAccessRulesPayload = await readPayload(fileAccessRulesResponse);
      if (!workflowResponse.ok) {
        showToast("error", workflowPayload.error?.message ?? "加载阶段注入提示词失败");
      } else {
        const phases = Array.isArray(workflowPayload.data?.phases) ? workflowPayload.data.phases : [];
        setWorkflowPhasePrompts(
          phases.map((phase: Record<string, unknown>) => ({
            id: String(phase.id ?? ""),
            title: String(phase.title ?? ""),
            kind:
              phase.kind === "analysis" ||
              phase.kind === "deliberation" ||
              phase.kind === "finalization_vote" ||
              phase.kind === "finalization"
                ? phase.kind
                : "analysis",
            description: typeof phase.description === "string" ? phase.description : null,
            minRounds: typeof phase.minRounds === "number" ? phase.minRounds : null,
            injectedPrompt: typeof phase.injectedPrompt === "string" ? phase.injectedPrompt : ""
          }))
        );
      }
      if (!workflowConfigResponse.ok) {
        showToast("error", workflowConfigPayload.error?.message ?? "加载上下文读取策略失败");
      } else {
        const nextWorkflowConfig =
          workflowConfigPayload.data?.workflowConfig && typeof workflowConfigPayload.data.workflowConfig === "object"
            ? (workflowConfigPayload.data.workflowConfig as WorkflowConfigPayload)
            : null;
        setWorkflowConfig(nextWorkflowConfig);
        setWorkflowContextAccess(normalizeContextAccessPayload(nextWorkflowConfig?.contextAccess));
        setWorkflowSummarizer(normalizeSummarizerPayload(nextWorkflowConfig?.summarizer));
      }
      if (!fileAccessRulesResponse.ok) {
        showToast("error", fileAccessRulesPayload.error?.message ?? "加载文件读取规则失败");
      } else {
        setFileAccessRules(normalizeStrategyFileAccessRules(fileAccessRulesPayload.data));
      }
    } finally {
      setWorkflowPhasePromptsLoading(false);
      setWorkflowContextAccessLoading(false);
    }
  }, [id, setFileAccessRules, showToast]);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggleFavorite() {
    if (!detail || detail.canEdit) return;
    if (isFavoriting) return;
    setIsFavoriting(true);
    try {
      const response = await fetch(`/api/strategies/${detail.id}/favorite`, {
        method: detail.isFavorited ? "DELETE" : "POST"
      });
      const payload = await readPayload(response);
      if (!response.ok) {
        showToast("error", payload.error?.message ?? "操作失败");
        return;
      }
      showToast("success", detail.isFavorited ? "已取消收藏" : "已收藏");
      await load();
    } finally {
      setIsFavoriting(false);
    }
  }

  async function forkOne() {
    if (!detail || detail.canEdit) return;
    if (isForking) return;
    setIsForking(true);
    try {
      const response = await fetch(`/api/strategies/${detail.id}/fork`, { method: "POST" });
      const payload = await readPayload(response);
      if (!response.ok) {
        showToast("error", payload.error?.message ?? "Fork 失败");
        return;
      }
      showToast("success", "已 Fork 到我的策略");
      const newId = payload.data?.id as string | undefined;
      if (newId) {
        router.push(`/strategies/${newId}`);
      } else {
        router.push("/strategies");
      }
    } finally {
      setIsForking(false);
    }
  }

  async function downloadStrategyFolder() {
    if (!id || isExportingFolder) return;
    setIsExportingFolder(true);
    try {
      const response = await fetch(`/api/strategies/${id}/download`, { method: "GET" });
      if (!response.ok) {
        const payload = await readPayload(response);
        showToast("error", payload.error?.message ?? "下载失败");
        return;
      }
      const blob = await response.blob();
      const disposition = response.headers.get("content-disposition") ?? "";
      const matched = disposition.match(/filename="([^"]+)"/i);
      const filename = matched?.[1] ?? `strategy-${id}.zip`;
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
    } finally {
      setIsExportingFolder(false);
    }
  }

  function openStrategyFolderImport() {
    folderImportInputRef.current?.click();
  }

  async function onStrategyFolderPicked(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []) as FileWithWebkitRelativePath[];
    event.target.value = "";
    if (!id || files.length <= 0 || isImportingFolder) return;

    const normalizedFiles = files
      .map((file) => ({
        file,
        relativePath: String(file.webkitRelativePath?.trim() || file.name).replace(/\\/g, "/").replace(/^\/+/, "")
      }))
      .filter((item) => item.relativePath.length > 0);
    const strippedPaths = stripImportedRootPrefix(normalizedFiles.map((item) => item.relativePath));
    const manifestIndex = strippedPaths.findIndex((item) => item === "manifest.json");
    if (manifestIndex < 0) {
      showToast("error", "导入失败：所选文件夹根目录缺少 manifest.json");
      return;
    }

    let manifestRaw = "";
    try {
      manifestRaw = await normalizedFiles[manifestIndex]!.file.text();
    } catch {
      showToast("error", "导入失败：读取 manifest.json 失败");
      return;
    }

    let preview: ImportedStrategyManifestPreview;
    try {
      const parsed = JSON.parse(manifestRaw) as {
        strategy?: { name?: unknown };
        roles?: Array<{ name?: unknown; roleOrder?: unknown; sourceRoleId?: unknown }>;
      };
      const manifestRoles = Array.isArray(parsed.roles)
        ? parsed.roles
            .map((role) => ({
              sourceRoleId: typeof role.sourceRoleId === "string" ? role.sourceRoleId : "",
              name: typeof role.name === "string" ? role.name : "",
              roleOrder: typeof role.roleOrder === "number" ? Math.floor(role.roleOrder) : 0
            }))
            .filter((role) => role.name && role.roleOrder > 0)
        : [];
      if (manifestRoles.length < 2) {
        showToast("error", "导入失败：manifest.json 至少需要包含 2 个角色");
        return;
      }
      const currentRoles = detail?.roles ?? [];
      const currentById = new Map(currentRoles.map((role) => [role.id, role] as const));
      const nextRoleIds = new Set(manifestRoles.map((role) => role.sourceRoleId).filter(Boolean));
      preview = {
        strategyName: typeof parsed.strategy?.name === "string" ? parsed.strategy.name : detail?.name ?? "未命名策略",
        roleCount: manifestRoles.length,
        keepRoles: currentRoles
          .filter((role) => nextRoleIds.has(role.id))
          .map((role) => ({ id: role.id, name: role.name, roleOrder: role.roleOrder })),
        deleteRoles: currentRoles
          .filter((role) => !nextRoleIds.has(role.id))
          .map((role) => ({ id: role.id, name: role.name, roleOrder: role.roleOrder })),
        newRoles: manifestRoles
          .filter((role) => !role.sourceRoleId || !currentById.has(role.sourceRoleId))
          .map((role) => ({ sourceRoleId: role.sourceRoleId, name: role.name, roleOrder: role.roleOrder }))
      };
    } catch {
      showToast("error", "导入失败：manifest.json 格式无效");
      return;
    }

    const deleteLines =
      preview.deleteRoles.length > 0
        ? `\n将删除的角色：\n${preview.deleteRoles.map((role) => `- #${role.roleOrder} ${role.name}`).join("\n")}`
        : "\n将删除的角色：无";
    const newLines =
      preview.newRoles.length > 0
        ? `\n将新增的角色：\n${preview.newRoles.map((role) => `- #${role.roleOrder} ${role.name}`).join("\n")}`
        : "\n将新增的角色：无";
    const keepLines =
      preview.keepRoles.length > 0
        ? `\n将保留并覆盖的角色：\n${preview.keepRoles.map((role) => `- #${role.roleOrder} ${role.name}`).join("\n")}`
        : "\n将保留并覆盖的角色：无";
    const ok = window.confirm(
      `即将用文件夹覆盖当前策略：${preview.strategyName}\n导入后角色数：${preview.roleCount}${keepLines}${newLines}${deleteLines}\n\n确认继续覆盖？`
    );
    if (!ok) return;

    setIsImportingFolder(true);
    try {
      const formData = new FormData();
      for (const file of files) {
        const relativePath = file.webkitRelativePath?.trim() || file.name;
        formData.append("files", file);
        formData.append("paths", relativePath);
      }
      const response = await fetch(`/api/strategies/${id}/import-folder`, {
        method: "POST",
        body: formData
      });
      const payload = await readPayload(response);
      if (!response.ok) {
        showToast("error", payload.error?.message ?? "导入失败");
        return;
      }
      showToast("success", "已用文件夹覆盖当前策略");
      await load();
    } finally {
      setIsImportingFolder(false);
    }
  }

  const canSave = useMemo(() => {
    if (!detail?.canEdit) return false;
    if (name.trim().length === 0) return false;
    if (roles.length < 2) return false;
    if (roles.some((role) => role.name.trim().length === 0)) return false;
    return true;
  }, [name, roles, detail?.canEdit]);

  function updateRole(index: number, next: Partial<RoleDraft>) {
    setRoles((current) => current.map((role, i) => (i === index ? { ...role, ...next } : role)));
  }

  function addRole() {
    if (!detail?.canEdit) return;
    setRoles((current) => {
      const next = [...current, { clientId: createClientId(), id: "", name: `角色 ${current.length + 1}`, systemPrompt: "" }];
      setActiveRoleIndex(next.length - 1);
      return next;
    });
  }

  function toggleRoleSelected(roleId: string) {
    if (!detail?.canEdit) return;
    setSelectedRoleIds((current) => {
      const next = new Set(current);
      if (next.has(roleId)) next.delete(roleId);
      else next.add(roleId);
      return next;
    });
  }

  function applyRangeSelection(fromIndex: number, toIndex: number, mode: "replace" | "add") {
    const start = Math.max(0, Math.min(fromIndex, toIndex));
    const end = Math.max(0, Math.max(fromIndex, toIndex));
    const ids = roles.slice(start, end + 1).map((role) => role.clientId);
    setSelectedRoleIds((current) => {
      if (mode === "add") {
        const next = new Set(current);
        for (const id of ids) next.add(id);
        return next;
      }
      return new Set(ids);
    });
  }

  function onRoleSelect(index: number, event: { ctrlKey: boolean; shiftKey: boolean }) {
    if (!detail?.canEdit) return;
    const hit = roles[index];
    if (!hit) return;

    const anchor = roleSelectionAnchorIndexRef.current ?? index;
    if (event.shiftKey) {
      applyRangeSelection(anchor, index, event.ctrlKey ? "add" : "replace");
      setActiveRoleIndex(index);
      return;
    }

    roleSelectionAnchorIndexRef.current = index;
    if (event.ctrlKey) {
      toggleRoleSelected(hit.clientId);
      setActiveRoleIndex(index);
      return;
    }

    setSelectedRoleIds(new Set([hit.clientId]));
    setActiveRoleIndex(index);
  }

  function selectAllRoles() {
    if (!detail?.canEdit) return;
    setSelectedRoleIds(new Set(roles.map((role) => role.clientId)));
  }

  function clearRoleSelection() {
    setSelectedRoleIds(new Set());
    roleSelectionAnchorIndexRef.current = null;
  }

  function deleteSelectedRoles() {
    if (!detail?.canEdit) return;
    if (selectedRoleIds.size === 0) return;
    if (roles.length - selectedRoleIds.size < 2) {
      showToast("error", "至少需要保留 2 个角色");
      return;
    }

    const ok = window.confirm(`确认删除选中的 ${selectedRoleIds.size} 个角色？（保存后生效，会同时删除这些角色下的文件）`);
    if (!ok) return;

    const activeClientId = roles[activeRoleIndex]?.clientId ?? "";
    const nextRoles = roles.filter((role) => !selectedRoleIds.has(role.clientId));
    
    setRoles(nextRoles);
    roleSelectionAnchorIndexRef.current = null;
    
    const idx = nextRoles.findIndex((role) => role.clientId === activeClientId);
    if (idx >= 0) {
      setActiveRoleIndex(idx);
    } else {
      setActiveRoleIndex(Math.max(0, Math.min(activeRoleIndex, nextRoles.length - 1)));
    }
    
    clearRoleSelection();
  }

  function removeRole(index: number) {
    if (!detail?.canEdit) return;
    setRoles((current) => {
      if (current.length <= 2) return current;
      const ok = window.confirm("确认删除该角色？（保存后生效，会同时删除该角色下的文件）");
      if (!ok) return current;
      const removed = current[index];
      const next = current.filter((_, i) => i !== index);
      setActiveRoleIndex((active) => Math.max(0, Math.min(active, next.length - 1)));
      if (removed) {
        setSelectedRoleIds((selected) => {
          if (!selected.has(removed.clientId)) return selected;
          const nextSelected = new Set(selected);
          nextSelected.delete(removed.clientId);
          return nextSelected;
        });
      }
      return next;
    });
  }

  function moveRole(index: number, direction: -1 | 1) {
    if (!detail?.canEdit) return;
    setRoles((current) => {
      const nextIndex = index + direction;
      if (nextIndex < 0 || nextIndex >= current.length) return current;
      const next = [...current];
      const temp = next[index];
      next[index] = next[nextIndex];
      next[nextIndex] = temp;
      return next;
    });
  }

  async function duplicateActiveRole() {
    if (!detail?.canEdit || !id) return;
    const role = roles[activeRoleIndex] ?? null;
    if (!role) return;

    if (!role.id) {
      const insertAt = activeRoleIndex + 1;
      setRoles((current) => {
        const source = current[activeRoleIndex];
        if (!source) return current;
        const copy = {
          clientId: createClientId(),
          id: "",
          name: source.name || `角色 ${activeRoleIndex + 1}`,
          systemPrompt: source.systemPrompt ?? ""
        };
        const next = [...current.slice(0, insertAt), copy, ...current.slice(insertAt)];
        return next;
      });
      setActiveRoleIndex(insertAt);
      roleSelectionAnchorIndexRef.current = insertAt;
      return;
    }

    if (isDuplicatingRole) return;
    setIsDuplicatingRole(true);
    try {
      const response = await fetch(`/api/strategies/${id}/roles/${role.id}/duplicate`, { method: "POST" });
      const payload = await readPayload(response);
      if (!response.ok) {
        showToast("error", payload.error?.message ?? "复制失败");
        return;
      }
      const created = payload.data as { id?: unknown; name?: unknown };
      const createdId = typeof created?.id === "string" ? created.id : "";
      if (!createdId) {
        showToast("error", "复制失败：缺少角色 ID");
        return;
      }

      const insertAt = activeRoleIndex + 1;
      setRoles((current) => {
        const source = current[activeRoleIndex];
        if (!source) return current;
        const nextRole: RoleDraft = {
          clientId: createdId,
          id: createdId,
          name: source.name,
          systemPrompt: source.systemPrompt ?? ""
        };
        return [...current.slice(0, insertAt), nextRole, ...current.slice(insertAt)];
      });
      setActiveRoleIndex(insertAt);
      roleSelectionAnchorIndexRef.current = insertAt;
      showToast("success", "已复制角色");
    } finally {
      setIsDuplicatingRole(false);
    }
  }

  async function save(options?: { silent?: boolean }) {
    if (!id || !canSave || isSaving) return;
    setIsSaving(true);
    try {
      const response = await fetch(`/api/strategies/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          description: description.trim() ? description : null,
          isShared,
          roles: roles.map((role) => ({
            ...(role.id ? { id: role.id } : {}),
            name: role.name,
            systemPrompt: role.systemPrompt.trim() ? role.systemPrompt : null
          }))
        })
      });
      const payload = await readPayload(response);
      if (!response.ok) {
        showToast("error", payload.error?.message ?? "保存失败");
        return false;
      }
      if (!options?.silent) showToast("success", "已保存");
      await load();
      return true;
    } finally {
      setIsSaving(false);
    }
  }

  async function deleteOne() {
    if (!id || !detail?.canEdit || isDeleting) return;
    const ok = window.confirm("确认删除该策略？此操作不可恢复。");
    if (!ok) return;
    setIsDeleting(true);
    try {
      const response = await fetch(`/api/strategies/${id}`, { method: "DELETE" });
      const payload = await readPayload(response);
      if (!response.ok) {
        showToast("error", payload.error?.message ?? "删除失败");
        return;
      }
      showToast("success", "已删除");
      router.push("/strategies");
    } finally {
      setIsDeleting(false);
    }
  }

  function updateWorkflowPhasePrompt(index: number, injectedPrompt: string) {
    setWorkflowPhasePrompts((current) =>
      current.map((phase, phaseIndex) => (phaseIndex === index ? { ...phase, injectedPrompt } : phase))
    );
  }

  function openWorkflowPromptDialog(input: WorkflowPromptDialogState) {
    setWorkflowPromptDialog(input);
  }

  function updateWorkflowPromptDialogValue(nextValue: string) {
    setWorkflowPromptDialog((current) => (current ? { ...current, value: nextValue } : current));
  }

  function applyWorkflowPromptDialog() {
    if (!workflowPromptDialog) return;
    if (typeof workflowPromptDialog.phaseIndex === "number") {
      updateWorkflowPhasePrompt(workflowPromptDialog.phaseIndex, workflowPromptDialog.value);
    }
    setWorkflowPromptDialog(null);
  }

  async function saveWorkflowPhasePrompts(options?: { silent?: boolean }) {
    if (!id || !detail?.canEdit || workflowPhasePromptsSaving) return;
    setWorkflowPhasePromptsSaving(true);
    try {
      const response = await fetch(`/api/strategies/${id}/workflow-phase-prompts`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phases: workflowPhasePrompts.map((phase) => ({
            id: phase.id,
            injectedPrompt: phase.injectedPrompt.trim() ? phase.injectedPrompt : null
          }))
        })
      });
      const payload = await readPayload(response);
      if (!response.ok) {
        showToast("error", payload.error?.message ?? "保存阶段注入提示词失败");
        return false;
      }
      const phases = Array.isArray(payload.data?.phases) ? payload.data.phases : [];
      setWorkflowPhasePrompts(
        phases.map((phase: Record<string, unknown>) => ({
          id: String(phase.id ?? ""),
          title: String(phase.title ?? ""),
          kind:
            phase.kind === "analysis" ||
            phase.kind === "deliberation" ||
            phase.kind === "finalization_vote" ||
            phase.kind === "finalization"
              ? phase.kind
              : "analysis",
          description: typeof phase.description === "string" ? phase.description : null,
          minRounds: typeof phase.minRounds === "number" ? phase.minRounds : null,
          injectedPrompt: typeof phase.injectedPrompt === "string" ? phase.injectedPrompt : ""
        }))
      );
      setWorkflowConfig((current) => {
        if (!current) return current;
        return {
          ...current,
          phaseMachine: {
            ...(typeof current.phaseMachine === "object" && current.phaseMachine !== null ? (current.phaseMachine as Record<string, unknown>) : {}),
            phases
          }
        };
      });
      if (!options?.silent) showToast("success", "已保存阶段注入提示词");
      return true;
    } finally {
      setWorkflowPhasePromptsSaving(false);
    }
  }

  function updateContextAccessRule(
    category: "alwaysRead" | "readWhenNeeded",
    index: number,
    next: Partial<WorkflowContextAccessRule>
  ) {
    setWorkflowContextAccess((current) => ({
      ...current,
      [category]: current[category].map((rule, ruleIndex) => (ruleIndex === index ? { ...rule, ...next } : rule))
    }));
  }

  function updatePhaseGateRule(index: number, next: Partial<WorkflowPhaseGateRule>) {
    setWorkflowContextAccess((current) => ({
      ...current,
      unlockAfterPhase: current.unlockAfterPhase.map((rule, ruleIndex) => (ruleIndex === index ? { ...rule, ...next } : rule))
    }));
  }

  function addContextAccessRule(category: "alwaysRead" | "readWhenNeeded") {
    setWorkflowContextAccess((current) => ({
      ...current,
      [category]: [...current[category], createContextAccessRule()]
    }));
  }

  function addPhaseGateRule() {
    setWorkflowContextAccess((current) => ({
      ...current,
      unlockAfterPhase: [...current.unlockAfterPhase, createPhaseGateRule()]
    }));
  }

  function removeContextAccessRule(category: "alwaysRead" | "readWhenNeeded", index: number) {
    setWorkflowContextAccess((current) => ({
      ...current,
      [category]: current[category].filter((_, ruleIndex) => ruleIndex !== index)
    }));
  }

  function removePhaseGateRule(index: number) {
    setWorkflowContextAccess((current) => ({
      ...current,
      unlockAfterPhase: current.unlockAfterPhase.filter((_, ruleIndex) => ruleIndex !== index)
    }));
  }

  async function saveWorkflowContextAccess(options?: { silent?: boolean }) {
    if (!id || !detail?.canEdit || workflowContextAccessSaving) return;
    if (!workflowConfig) {
      showToast("error", "workflow 配置尚未加载完成");
      return false;
    }

    setWorkflowContextAccessSaving(true);
    try {
      const response = await fetch(`/api/strategies/${id}/workflow-config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workflowConfig: {
            ...workflowConfig,
            contextAccess: {
              alwaysRead: workflowContextAccess.alwaysRead.map((rule) => ({
                scope: rule.scope,
                pathPrefix: rule.pathPrefix.trim(),
                maxFiles: Math.max(1, Math.floor(rule.maxFiles || 1)),
                maxCharsPerFile: Math.max(200, Math.floor(rule.maxCharsPerFile || 200)),
                recursive: rule.recursive
              })),
              readWhenNeeded: workflowContextAccess.readWhenNeeded.map((rule) => ({
                scope: rule.scope,
                pathPrefix: rule.pathPrefix.trim(),
                maxFiles: Math.max(1, Math.floor(rule.maxFiles || 1)),
                maxCharsPerFile: Math.max(200, Math.floor(rule.maxCharsPerFile || 200)),
                recursive: rule.recursive
              })),
              unlockAfterPhase: workflowContextAccess.unlockAfterPhase.map((rule) => ({
                phaseKind: rule.phaseKind,
                scope: rule.scope,
                pathPrefix: rule.pathPrefix.trim(),
                maxFiles: Math.max(1, Math.floor(rule.maxFiles || 1)),
                maxCharsPerFile: Math.max(200, Math.floor(rule.maxCharsPerFile || 200)),
                recursive: rule.recursive
              }))
            }
          }
        })
      });
      const payload = await readPayload(response);
      if (!response.ok) {
        showToast("error", payload.error?.message ?? "保存上下文读取策略失败");
        return false;
      }
      const nextWorkflowConfig =
        payload.data?.workflowConfig && typeof payload.data.workflowConfig === "object"
          ? (payload.data.workflowConfig as WorkflowConfigPayload)
          : workflowConfig;
      setWorkflowConfig(nextWorkflowConfig);
      setWorkflowContextAccess(normalizeContextAccessPayload(nextWorkflowConfig.contextAccess));
      if (!options?.silent) showToast("success", "已保存上下文读取策略");
      return true;
    } finally {
      setWorkflowContextAccessSaving(false);
    }
  }

  async function saveWorkflowSummarizer(options?: { silent?: boolean }) {
    if (!id || !detail?.canEdit || workflowSummarizerSaving) return;
    if (!workflowConfig) {
      showToast("error", "workflow 配置尚未加载完成");
      return false;
    }

    setWorkflowSummarizerSaving(true);
    try {
      const response = await fetch(`/api/strategies/${id}/workflow-config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workflowConfig: {
            ...workflowConfig,
            summarizer: {
              enabled: workflowSummarizer.enabled,
              aiAgentId: null,
              perTurn: workflowSummarizer.perTurn,
              perRound: workflowSummarizer.perRound,
              factsBoard: workflowSummarizer.factsBoard,
              prompts: {
                turnSummary: workflowSummarizer.prompts.turnSummary.trim() || null,
                roundSummary: workflowSummarizer.prompts.roundSummary.trim() || null,
                factsBoard: workflowSummarizer.prompts.factsBoard.trim() || null
              },
              outputPaths: {
                turnSummaryDir: workflowSummarizer.outputPaths.turnSummaryDir.trim() || "debate/turn_summaries/",
                roundSummaryDir: workflowSummarizer.outputPaths.roundSummaryDir.trim() || "debate/round_summaries/",
                factsBoardPath: workflowSummarizer.outputPaths.factsBoardPath.trim() || "facts/board.md"
              }
            }
          }
        })
      });
      const payload = await readPayload(response);
      if (!response.ok) {
        showToast("error", payload.error?.message ?? "保存独立总结器失败");
        return false;
      }
      const nextWorkflowConfig =
        payload.data?.workflowConfig && typeof payload.data.workflowConfig === "object"
          ? (payload.data.workflowConfig as WorkflowConfigPayload)
          : workflowConfig;
      setWorkflowConfig(nextWorkflowConfig);
      setWorkflowSummarizer(normalizeSummarizerPayload(nextWorkflowConfig.summarizer));
      if (!options?.silent) showToast("success", "已保存独立总结器");
      return true;
    } finally {
      setWorkflowSummarizerSaving(false);
    }
  }

  async function saveAll() {
    if (!id || !detail?.canEdit || !canSave || isSavingAll) return;
    setIsSavingAll(true);
    try {
      const basicOk = await save({ silent: true });
      if (!basicOk) return;
      const phaseOk = await saveWorkflowPhasePrompts({ silent: true });
      if (!phaseOk) return;
      const summarizerOk = await saveWorkflowSummarizer({ silent: true });
      if (!summarizerOk) return;
      showToast("success", "已保存全部修改");
    } finally {
      setIsSavingAll(false);
    }
  }

  if (!detail) {
    return <div className="panel">加载中...</div>;
  }

  const activeRole = roles[activeRoleIndex] ?? null;
  const selectedCount = selectedRoleIds.size;
  const canDeleteSelected = detail.canEdit && selectedCount > 0 && roles.length - selectedCount >= 2;
  const roleSummary = summarizeRoles(roles);
  const phaseSummary = workflowPhasePromptsLoading
    ? "加载中..."
    : workflowPhasePrompts.length > 0
      ? `已配置 ${workflowPhasePrompts.length} 个阶段`
      : "未配置阶段";
  const contextRuleCount = fileAccessRules.length;
  const contextSummary = fileAccessRulesLoading
    ? "加载中..."
    : contextRuleCount > 0
      ? `已配置 ${contextRuleCount} 条规则`
      : "未配置规则";
  const summarizerSummary = workflowSummarizer.enabled
    ? [
        workflowSummarizer.perTurn ? "每回摘要" : null,
        workflowSummarizer.perRound ? "每轮摘要" : null,
        workflowSummarizer.factsBoard ? "事实板" : null
      ]
        .filter(Boolean)
        .join(" / ") || "已启用"
    : "未启用";
  const workflowSummary = [phaseSummary, summarizerSummary, contextSummary].join(" · ");

  return (
    <div className="grid" style={{ gap: 20 }}>
      {toast ? (
        <div
          className={`toast ${toast.type === "success" ? "toast-success" : "toast-error"}`}
          role="status"
          aria-live="polite"
        >
          {toast.text}
        </div>
      ) : null}
      <WorkflowPromptDialog
        dialog={workflowPromptDialog}
        canEdit={detail.canEdit}
        onClose={() => setWorkflowPromptDialog(null)}
        onChangeValue={updateWorkflowPromptDialogValue}
        onApply={applyWorkflowPromptDialog}
      />

      <input
        ref={folderImportInputRef}
        type="file"
        multiple
        onChange={(event) => void onStrategyFolderPicked(event)}
        style={{ display: "none" }}
        {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
      />

      <StrategyOverviewSection
        detail={detail}
        name={name}
        description={description}
        isShared={isShared}
        canSave={canSave}
        isSavingAll={isSavingAll}
        isSaving={isSaving}
        workflowPhasePromptsSaving={workflowPhasePromptsSaving}
        workflowContextAccessSaving={workflowContextAccessSaving}
        workflowSummarizerSaving={workflowSummarizerSaving}
        isFavoriting={isFavoriting}
        isForking={isForking}
        onChangeName={setName}
        onChangeDescription={setDescription}
        onChangeShared={setIsShared}
        onSaveAll={() => void saveAll()}
        onToggleFavorite={() => void toggleFavorite()}
        onFork={() => void forkOne()}
      />

      <details className="panel" open>
        <summary
          className="row"
          style={{ cursor: "pointer", justifyContent: "space-between", alignItems: "center", gap: 12 }}
        >
          <div className="row" style={{ gap: 8, alignItems: "center" }}>
            <strong>Workflow 规则</strong>
            <span className="muted">{workflowSummary}</span>
          </div>
          <span className="muted">{detail.canEdit ? "查看 / 编辑" : "查看"}</span>
        </summary>
        <div className="stack" style={{ marginTop: 12 }}>
          <details className="softBox">
            <summary className="row" style={{ cursor: "pointer", justifyContent: "space-between", alignItems: "center" }}>
              <div className="row" style={{ gap: 8, alignItems: "center" }}>
                <strong>独立总结器</strong>
                <span className="muted">{summarizerSummary}</span>
              </div>
              <span className="muted">{detail.canEdit ? "查看 / 编辑" : "查看"}</span>
            </summary>
            <div className="stack" style={{ marginTop: 12 }}>
              <div className="muted">声明摘要能力与输出位置。</div>
              <label className="row" style={{ alignItems: "center", gap: 8 }}>
                <input
                  type="checkbox"
                  checked={workflowSummarizer.enabled}
                  disabled={!detail.canEdit}
                  onChange={(event) =>
                    setWorkflowSummarizer((current) => ({
                      ...current,
                      enabled: event.target.checked
                    }))
                  }
                />
                <span>启用独立总结器</span>
              </label>

              <div className="row" style={{ gap: 16, flexWrap: "wrap" }}>
                <label className="row" style={{ alignItems: "center", gap: 8 }}>
                  <input
                    type="checkbox"
                    checked={workflowSummarizer.perTurn}
                    disabled={!detail.canEdit || !workflowSummarizer.enabled}
                    onChange={(event) =>
                      setWorkflowSummarizer((current) => ({ ...current, perTurn: event.target.checked }))
                    }
                  />
                  <span>每回摘要</span>
                </label>
                <label className="row" style={{ alignItems: "center", gap: 8 }}>
                  <input
                    type="checkbox"
                    checked={workflowSummarizer.perRound}
                    disabled={!detail.canEdit || !workflowSummarizer.enabled}
                    onChange={(event) =>
                      setWorkflowSummarizer((current) => ({ ...current, perRound: event.target.checked }))
                    }
                  />
                  <span>每轮摘要</span>
                </label>
                <label className="row" style={{ alignItems: "center", gap: 8 }}>
                  <input
                    type="checkbox"
                    checked={workflowSummarizer.factsBoard}
                    disabled={!detail.canEdit || !workflowSummarizer.enabled}
                    onChange={(event) =>
                      setWorkflowSummarizer((current) => ({ ...current, factsBoard: event.target.checked }))
                    }
                  />
                  <span>结构化事实板</span>
                </label>
              </div>

              <div className="grid" style={{ gap: 12 }}>
                <div className="field">
                  <label>回摘要 Prompt</label>
                  <textarea
                    value={workflowSummarizer.prompts.turnSummary}
                    disabled={!detail.canEdit || !workflowSummarizer.enabled}
                    onChange={(event) =>
                      setWorkflowSummarizer((current) => ({
                        ...current,
                        prompts: { ...current.prompts, turnSummary: event.target.value }
                      }))
                    }
                  />
                </div>
                <div className="field">
                  <label>轮摘要 Prompt</label>
                  <textarea
                    value={workflowSummarizer.prompts.roundSummary}
                    disabled={!detail.canEdit || !workflowSummarizer.enabled}
                    onChange={(event) =>
                      setWorkflowSummarizer((current) => ({
                        ...current,
                        prompts: { ...current.prompts, roundSummary: event.target.value }
                      }))
                    }
                  />
                </div>
                <div className="field">
                  <label>事实板 Prompt</label>
                  <textarea
                    value={workflowSummarizer.prompts.factsBoard}
                    disabled={!detail.canEdit || !workflowSummarizer.enabled}
                    onChange={(event) =>
                      setWorkflowSummarizer((current) => ({
                        ...current,
                        prompts: { ...current.prompts, factsBoard: event.target.value }
                      }))
                    }
                  />
                </div>
              </div>

              <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
                <div className="field" style={{ flex: 1, minWidth: 220 }}>
                  <label>回摘要目录</label>
                  <input
                    value={workflowSummarizer.outputPaths.turnSummaryDir}
                    disabled={!detail.canEdit || !workflowSummarizer.enabled}
                    onChange={(event) =>
                      setWorkflowSummarizer((current) => ({
                        ...current,
                        outputPaths: { ...current.outputPaths, turnSummaryDir: event.target.value }
                      }))
                    }
                  />
                </div>
                <div className="field" style={{ flex: 1, minWidth: 220 }}>
                  <label>轮摘要目录</label>
                  <input
                    value={workflowSummarizer.outputPaths.roundSummaryDir}
                    disabled={!detail.canEdit || !workflowSummarizer.enabled}
                    onChange={(event) =>
                      setWorkflowSummarizer((current) => ({
                        ...current,
                        outputPaths: { ...current.outputPaths, roundSummaryDir: event.target.value }
                      }))
                    }
                  />
                </div>
                <div className="field" style={{ flex: 1, minWidth: 220 }}>
                  <label>事实板路径</label>
                  <input
                    value={workflowSummarizer.outputPaths.factsBoardPath}
                    disabled={!detail.canEdit || !workflowSummarizer.enabled}
                    onChange={(event) =>
                      setWorkflowSummarizer((current) => ({
                        ...current,
                        outputPaths: { ...current.outputPaths, factsBoardPath: event.target.value }
                      }))
                    }
                  />
                </div>
              </div>
            </div>
          </details>

          <details className="softBox">
            <summary className="row" style={{ cursor: "pointer", justifyContent: "space-between", alignItems: "center" }}>
              <div className="row" style={{ gap: 8, alignItems: "center" }}>
                <strong>阶段机 / 投票 / 共识 / 交付</strong>
                <span className="muted">{phaseSummary}</span>
              </div>
              <span className="muted">{detail.canEdit ? "查看 / 编辑" : "查看"}</span>
            </summary>
            <div className="stack" style={{ marginTop: 12 }}>
              <div className="muted">按阶段补充提示词。</div>
              {workflowPhasePromptsLoading ? (
                <div className="muted">加载中...</div>
              ) : (
                <div className="grid" style={{ gap: 12 }}>
                  {workflowPhasePrompts.length <= 0 ? (
                    <div className="muted">当前策略没有额外流程阶段，默认直接按普通讨论方式运行。</div>
                  ) : null}
                  {workflowPhasePrompts.map((phase, index) => (
                    <div key={phase.id} className="softBox stack">
                      <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
                        <strong>{phase.title}</strong>
                        <span className="muted">
                          {phase.kind}
                          {phase.minRounds ? ` · minRounds=${phase.minRounds}` : ""}
                        </span>
                      </div>
                      {phase.description ? <div className="muted">{phase.description}</div> : null}
                      <div className="softBox" style={{ whiteSpace: "pre-wrap" }}>
                        {summarizePrompt(phase.injectedPrompt)}
                      </div>
                      <div className="row" style={{ justifyContent: "flex-end" }}>
                        <button
                          className="btn"
                          type="button"
                          onClick={() =>
                            openWorkflowPromptDialog({
                              type: "phase",
                              title: `${phase.title} · 阶段提示词`,
                              description:
                                phase.description ?? "只有当 workflow 进入该阶段时，系统才会自动把这里的提示词注入到运行时 Prompt 中。",
                              value: phase.injectedPrompt,
                              phaseIndex: index
                            })
                          }
                        >
                          {detail.canEdit ? "查看 / 编辑" : "查看"}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </details>

          <details className="softBox">
            <summary className="row" style={{ cursor: "pointer", justifyContent: "space-between", alignItems: "center" }}>
              <div className="row" style={{ gap: 8, alignItems: "center" }}>
                <strong>上下文读取规则</strong>
                <span className="muted">{contextSummary}</span>
              </div>
              <span className="muted">{detail.canEdit ? "查看 / 编辑" : "查看"}</span>
            </summary>
            <div className="stack" style={{ marginTop: 12 }}>
              <div className="muted">上下文读取规则已迁移到文件管理打标。请在“共享文件 / 角色文件”里直接对文件或文件夹右键标记为每会话必读、按需可读或阶段解锁。</div>
              <div className="softBox stack">
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <strong>当前规则概览</strong>
                  <span className="muted">{contextSummary}</span>
                </div>
                <div className="muted">运行时仍会保留内部预算与裁剪逻辑，但不再需要手动维护 pathPrefix、maxFiles、maxCharsPerFile。</div>
              </div>
            </div>
          </details>
        </div>
      </details>

      <details className="panel">
        <summary
          className="row"
          style={{ cursor: "pointer", justifyContent: "space-between", alignItems: "center", gap: 12 }}
        >
          <div className="row" style={{ gap: 8, alignItems: "center" }}>
            <strong>角色管理</strong>
            <span className="muted">{roleSummary}</span>
          </div>
          <span className="muted">{detail.canEdit ? "查看 / 编辑" : "查看"}</span>
        </summary>
        <div className="strategySplit" style={{ marginTop: 12 }}>
          <aside className="panel strategySidebar">
            <div className="stack">
              <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
                <strong>角色导航</strong>
                <span className="muted">{roles.length} 个</span>
              </div>
              <div className="muted">切换角色会同步右侧文件视图。</div>
              <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                <button
                  className={`btn strategyTab ${strategyPanel === "shared" ? "btn-primary strategyTabActive" : "btn-muted"}`}
                  type="button"
                  onClick={() => startTransition(() => setStrategyPanel("shared"))}
                >
                  <span className="strategyTabLabel">共享文件</span>
                </button>
                <button
                  className={`btn strategyTab ${strategyPanel === "roleFiles" ? "btn-primary strategyTabActive" : "btn-muted"}`}
                  type="button"
                  onClick={() => startTransition(() => setStrategyPanel("roleFiles"))}
                >
                  <span className="strategyTabLabel">角色文件</span>
                </button>
                <button
                  className={`btn strategyTab ${strategyPanel === "roleEditor" ? "btn-primary strategyTabActive" : "btn-muted"}`}
                  type="button"
                  onClick={() => startTransition(() => setStrategyPanel("roleEditor"))}
                >
                  <span className="strategyTabLabel">角色编辑</span>
                </button>
                <button
                  className={`btn strategyTab ${strategyPanel === "phaseUnlock" ? "btn-primary strategyTabActive" : "btn-muted"}`}
                  type="button"
                  onClick={() => startTransition(() => setStrategyPanel("phaseUnlock"))}
                >
                  <span className="strategyTabLabel">阶段解锁</span>
                </button>
              </div>

              <div className="roleList">
                {roles.map((role, index) => {
                  const selected = selectedRoleIds.has(role.clientId);
                  return (
                    <div key={role.clientId} className="row" style={{ gap: 8 }}>
                      <button
                        className={`btn roleButton ${index === activeRoleIndex ? "btn-primary" : ""}`}
                        onClick={(event) => {
                          if (!detail.canEdit) {
                            roleSelectionAnchorIndexRef.current = index;
                            setActiveRoleIndex(index);
                            return;
                          }
                          if (event.ctrlKey || event.shiftKey) {
                            event.preventDefault();
                            event.stopPropagation();
                            onRoleSelect(index, { ctrlKey: event.ctrlKey, shiftKey: event.shiftKey });
                            return;
                          }
                          roleSelectionAnchorIndexRef.current = index;
                          setSelectedRoleIds(new Set([role.clientId]));
                          setActiveRoleIndex(index);
                        }}
                        type="button"
                        style={{
                          flex: 1,
                          textAlign: "left",
                          boxShadow: selected ? "0 0 0 2px rgba(59, 130, 246, 0.55) inset" : undefined
                        }}
                      >
                        #{index + 1} {role.name || "(未命名)"}
                      </button>
                    </div>
                  );
                })}
              </div>

              {detail.canEdit ? (
                <div className="row" style={{ flexWrap: "wrap" }}>
                  <button className="btn" type="button" disabled={selectedCount === 0} onClick={clearRoleSelection}>
                    清空选择
                  </button>
                  <button className="btn" type="button" onClick={selectAllRoles}>
                    全选
                  </button>
                  <button
                    className="btn btn-danger"
                    type="button"
                    disabled={!canDeleteSelected}
                    onClick={deleteSelectedRoles}
                  >
                    删除选中
                  </button>
                  <button className="btn btn-primary" type="button" onClick={addRole}>
                    新增角色
                  </button>
                </div>
              ) : null}
            </div>
          </aside>

          <section className="strategyMain stack">
            <div className="strategyPanelStack">
              {mountedPanels.shared ? (
                <section
                  id="strategy-shared-files"
                  className={`softBox stack strategyPanelBox strategyPanelLayer ${strategyPanel === "shared" ? "isActive" : ""}`}
                  aria-hidden={strategyPanel !== "shared"}
                >
                <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
                  <strong>共享文件</strong>
                  <span className="muted">{detail.canEdit ? "查看 / 编辑" : "查看"}</span>
                </div>
                <div className="grid grid-2 strategyPanelFill" style={{ gap: 16, alignItems: "start" }}>
                  <StrategySharedFilesManagerColumns
                    strategyId={detail.id}
                    readOnly={!detail.canEdit}
                    onRulesChange={() => void refreshFileAccessRules()}
                  />
                </div>
                </section>
              ) : null}

              {mountedPanels.roleFiles ? (
                <section
                  id="strategy-role-files"
                  className={`softBox stack strategyPanelBox strategyPanelLayer ${strategyPanel === "roleFiles" ? "isActive" : ""}`}
                  aria-hidden={strategyPanel !== "roleFiles"}
                >
                <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline", gap: 16, flexWrap: "wrap" }}>
                  <div>
                    <strong>当前角色文件</strong>
                    <div className="muted">切换角色同步视图。</div>
                  </div>
                  <div className="field" style={{ minWidth: 220 }}>
                    <label>选择角色</label>
                    <select
                      value={activeRoleIndex}
                      onChange={(event) => {
                        const nextIndex = Number(event.target.value);
                        if (!Number.isFinite(nextIndex)) return;
                        roleSelectionAnchorIndexRef.current = nextIndex;
                        const target = roles[nextIndex];
                        if (target) setSelectedRoleIds(new Set([target.clientId]));
                        setActiveRoleIndex(nextIndex);
                      }}
                      disabled={roles.length <= 0}
                    >
                      {roles.map((role, index) => (
                        <option key={role.id} value={index}>
                          #{index + 1} {role.name || "(未命名)"}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                {activeRole?.id ? (
                  <div className="grid grid-2 strategyPanelFill" style={{ gap: 16, alignItems: "start" }}>
                    <RoleFilesManagerColumns
                      strategyId={detail.id}
                      roleId={activeRole.id}
                      readOnly={!detail.canEdit}
                      onRulesChange={() => void refreshFileAccessRules()}
                    />
                  </div>
                ) : (
                  <section className="panel stack">
                    <div className="muted">新角色先保存后才能编辑文件。</div>
                  </section>
                )}
                </section>
              ) : null}

              {mountedPanels.roleEditor ? (
                <section
                  id="strategy-role-editor"
                  className={`softBox stack strategyPanelBox strategyPanelLayer strategyRoleEditorPanel ${strategyPanel === "roleEditor" ? "isActive" : ""}`}
                  aria-hidden={strategyPanel !== "roleEditor"}
                >
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <strong>角色编辑</strong>
                  <span className="muted">{detail.canEdit ? "查看 / 编辑" : "查看"}</span>
                </div>

                  {activeRole ? (
                    <div className="stack strategyRoleEditorBody">
                      <div className="row" style={{ justifyContent: "space-between" }}>
                        <strong>编辑角色 #{activeRoleIndex + 1}</strong>
                        {detail.canEdit ? (
                          <div className="row">
                            <button className="btn" disabled={activeRoleIndex === 0} onClick={() => moveRole(activeRoleIndex, -1)}>
                              上移
                            </button>
                            <button className="btn" disabled={activeRoleIndex === roles.length - 1} onClick={() => moveRole(activeRoleIndex, 1)}>
                              下移
                            </button>
                            <button className="btn" disabled={isDuplicatingRole} onClick={() => void duplicateActiveRole()}>
                              {isDuplicatingRole ? "复制中..." : "复制"}
                            </button>
                            <button className="btn btn-danger" disabled={roles.length <= 2} onClick={() => removeRole(activeRoleIndex)}>
                              删除
                            </button>
                          </div>
                        ) : null}
                      </div>

                      <div className="field">
                        <label>角色名称</label>
                        <input
                          value={activeRole.name}
                          disabled={!detail.canEdit}
                          onChange={(event) => updateRole(activeRoleIndex, { name: event.target.value })}
                        />
                      </div>

                    <div className="field strategyPromptField">
                      <label>System Prompt</label>
                      <textarea
                        className="strategyPrompt"
                          value={activeRole.systemPrompt}
                          disabled={!detail.canEdit}
                          onChange={(event) => updateRole(activeRoleIndex, { systemPrompt: event.target.value })}
                        />
                      </div>

                      {!activeRole.id ? <div className="muted">新角色先保存后才能编辑文件。</div> : null}
                    </div>
                ) : (
                  <div className="muted">请选择一个角色</div>
                )}
                </section>
              ) : null}

              {mountedPanels.phaseUnlock ? (
                <section
                  id="strategy-phase-unlock"
                  className={`softBox stack strategyPanelBox strategyPanelLayer ${strategyPanel === "phaseUnlock" ? "isActive" : ""}`}
                  aria-hidden={strategyPanel !== "phaseUnlock"}
                >
                  <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
                    <strong>阶段解锁（共享）</strong>
                    <span className="muted">只展示 shared 规则</span>
                  </div>
                  <div className="muted">这些文件或文件夹会在进入对应阶段后自动解锁并注入上下文。首版仅支持共享文件。</div>
                  {fileAccessRulesLoading ? (
                    <div className="muted">加载中...</div>
                  ) : fileAccessRules.filter((rule) => rule.scope === "shared" && rule.accessMode === "unlock_after_phase").length <= 0 ? (
                    <div className="softBox muted">未配置阶段解锁规则</div>
                  ) : (
                    <div className="stack">
                      {fileAccessRules
                        .filter((rule) => rule.scope === "shared" && rule.accessMode === "unlock_after_phase")
                        .sort((left, right) => left.targetPath.localeCompare(right.targetPath))
                        .map((rule) => (
                          <div key={rule.id} className="softBox row" style={{ justifyContent: "space-between", gap: 16, alignItems: "center" }}>
                            <div className="stack" style={{ gap: 4 }}>
                              <strong>{rule.targetPath}</strong>
                              <span className="muted">{rule.targetType === "file" ? "文件" : "文件夹"}</span>
                            </div>
                            <span className="tag">{rule.phaseKind ?? "未配置阶段"}</span>
                          </div>
                        ))}
                    </div>
                  )}
                </section>
              ) : null}
            </div>
          </section>
        </div>
      </details>

      <StrategyAdvancedSection
        canEdit={detail.canEdit}
        isExportingFolder={isExportingFolder}
        isImportingFolder={isImportingFolder}
        isDeleting={isDeleting}
        onDownloadFolder={() => void downloadStrategyFolder()}
        onOpenFolderImport={openStrategyFolderImport}
        onDelete={() => void deleteOne()}
      />
    </div>
  );
}
