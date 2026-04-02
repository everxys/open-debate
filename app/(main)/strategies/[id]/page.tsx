"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";

import { RoleFilesManagerColumns } from "@/components/strategies/role-files-manager";
import { useAutoDismissToast } from "@/components/ui/use-toast";

type StrategyDetail = {
  id: string;
  name: string;
  description: string | null;
  isShared: boolean;
  forkedFromStrategyId?: string | null;
  isFavorited?: boolean;
  favoriteCount?: number;
  forkCount?: number;
  canEdit: boolean;
  roles: Array<{
    id: string;
    name: string;
    systemPrompt: string | null;
    roleOrder: number;
  }>;
};

type RoleDraft = { clientId: string; id: string; name: string; systemPrompt: string };
type WorkflowPhasePrompt = {
  id: string;
  title: string;
  kind: "analysis" | "deliberation" | "finalization_vote" | "finalization";
  description: string | null;
  minRounds: number | null;
  injectedPrompt: string;
    };

type WorkflowPhaseKind = WorkflowPhasePrompt["kind"];

type WorkflowContextAccessRule = {
  scope: "shared" | "seat";
  pathPrefix: string;
  maxFiles: number;
  maxCharsPerFile: number;
  recursive: boolean;
};

type WorkflowPhaseGateRule = WorkflowContextAccessRule & {
  phaseKind: WorkflowPhaseKind;
};

type WorkflowContextAccess = {
  alwaysRead: WorkflowContextAccessRule[];
  readWhenNeeded: WorkflowContextAccessRule[];
  unlockAfterPhase: WorkflowPhaseGateRule[];
};

type WorkflowSummarizer = {
  enabled: boolean;
  perTurn: boolean;
  perRound: boolean;
  factsBoard: boolean;
  prompts: {
    turnSummary: string;
    roundSummary: string;
    factsBoard: string;
  };
  outputPaths: {
    turnSummaryDir: string;
    roundSummaryDir: string;
    factsBoardPath: string;
  };
};

type WorkflowConfigPayload = {
  workflowVersion?: number;
  enabled?: boolean;
  contextAccess?: WorkflowContextAccess;
  summarizer?: Partial<WorkflowSummarizer> & {
    prompts?: Partial<WorkflowSummarizer["prompts"]>;
    outputPaths?: Partial<WorkflowSummarizer["outputPaths"]>;
  };
  [key: string]: unknown;
};

type WorkflowPromptDialogState =
  | null
  | {
      type: "phase";
      title: string;
      description: string;
      value: string;
      phaseIndex?: number;
    };

type FileWithWebkitRelativePath = File & {
  webkitRelativePath?: string;
};

function createClientId() {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

function summarizePrompt(value: string) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return "未配置";
  return normalized.length > 90 ? `${normalized.slice(0, 90)}...` : normalized;
}

function createContextAccessRule(): WorkflowContextAccessRule {
  return {
    scope: "shared",
    pathPrefix: "",
    maxFiles: 6,
    maxCharsPerFile: 4000,
    recursive: true
  };
}

function createPhaseGateRule(): WorkflowPhaseGateRule {
  return {
    ...createContextAccessRule(),
    phaseKind: "deliberation"
  };
}

function normalizeContextAccessPayload(value: unknown): WorkflowContextAccess {
  const obj = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  const normalizeRule = (item: unknown): WorkflowContextAccessRule => {
    const rule = typeof item === "object" && item !== null ? (item as Record<string, unknown>) : null;
    return {
      scope: rule?.scope === "seat" ? "seat" : "shared",
      pathPrefix: typeof rule?.pathPrefix === "string" ? rule.pathPrefix : "",
      maxFiles:
        typeof rule?.maxFiles === "number" && Number.isFinite(rule.maxFiles) && rule.maxFiles > 0
          ? Math.floor(rule.maxFiles)
          : 6,
      maxCharsPerFile:
        typeof rule?.maxCharsPerFile === "number" && Number.isFinite(rule.maxCharsPerFile) && rule.maxCharsPerFile > 0
          ? Math.floor(rule.maxCharsPerFile)
          : 4000,
      recursive: rule?.recursive === undefined ? true : Boolean(rule.recursive)
    };
  };

  const alwaysRead = Array.isArray(obj?.alwaysRead) ? obj.alwaysRead.map((item) => normalizeRule(item)) : [];
  const readWhenNeeded = Array.isArray(obj?.readWhenNeeded) ? obj.readWhenNeeded.map((item) => normalizeRule(item)) : [];
  const unlockAfterPhase = Array.isArray(obj?.unlockAfterPhase)
    ? obj.unlockAfterPhase.map((item) => {
        const rule = normalizeRule(item);
        const raw = typeof item === "object" && item !== null ? (item as Record<string, unknown>) : null;
        const phaseKind: WorkflowPhaseKind =
          raw?.phaseKind === "analysis" ||
          raw?.phaseKind === "deliberation" ||
          raw?.phaseKind === "finalization_vote" ||
          raw?.phaseKind === "finalization"
            ? raw.phaseKind
            : "deliberation";
        return { ...rule, phaseKind };
      })
    : [];

  return { alwaysRead, readWhenNeeded, unlockAfterPhase };
}

function normalizeSummarizerPayload(value: unknown): WorkflowSummarizer {
  const obj = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  const prompts = typeof obj?.prompts === "object" && obj.prompts !== null ? (obj.prompts as Record<string, unknown>) : null;
  const outputPaths =
    typeof obj?.outputPaths === "object" && obj.outputPaths !== null
      ? (obj.outputPaths as Record<string, unknown>)
      : null;
  return {
    enabled: Boolean(obj?.enabled),
    perTurn: obj?.perTurn === undefined ? true : Boolean(obj?.perTurn),
    perRound: obj?.perRound === undefined ? true : Boolean(obj?.perRound),
    factsBoard: obj?.factsBoard === undefined ? true : Boolean(obj?.factsBoard),
    prompts: {
      turnSummary: typeof prompts?.turnSummary === "string" ? prompts.turnSummary : "",
      roundSummary: typeof prompts?.roundSummary === "string" ? prompts.roundSummary : "",
      factsBoard: typeof prompts?.factsBoard === "string" ? prompts.factsBoard : ""
    },
    outputPaths: {
      turnSummaryDir: typeof outputPaths?.turnSummaryDir === "string" ? outputPaths.turnSummaryDir : "debate/turn_summaries/",
      roundSummaryDir:
        typeof outputPaths?.roundSummaryDir === "string" ? outputPaths.roundSummaryDir : "debate/round_summaries/",
      factsBoardPath: typeof outputPaths?.factsBoardPath === "string" ? outputPaths.factsBoardPath : "facts/board.md"
    }
  };
}

async function readPayload(response: Response) {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      return await response.json();
    } catch {
    }
  }

  let text = "";
  try {
    text = await response.text();
  } catch {
  }

  return {
    success: false,
    error: { message: text || `${response.status} ${response.statusText}`.trim() }
  };
}

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
      const [workflowResponse, workflowConfigResponse] = await Promise.all([
        fetch(`/api/strategies/${id}/workflow-phase-prompts`),
        fetch(`/api/strategies/${id}/workflow-config`)
      ]);
      const workflowPayload = await readPayload(workflowResponse);
      const workflowConfigPayload = await readPayload(workflowConfigResponse);
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
    } finally {
      setWorkflowPhasePromptsLoading(false);
      setWorkflowContextAccessLoading(false);
    }
  }, [id, showToast]);

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

    const ok = window.confirm("确认用所选文件夹覆盖当前策略？这会替换当前策略的角色、System Prompt、workflow 和所有角色文件。");
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
      const contextOk = await saveWorkflowContextAccess({ silent: true });
      if (!contextOk) return;
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
      {workflowPromptDialog ? (
        <div
          role="dialog"
          aria-modal="true"
          onClick={() => setWorkflowPromptDialog(null)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(15, 23, 42, 0.45)",
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "center",
            padding: 24,
            zIndex: 1000
          }}
        >
          <div
            className="panel stack"
            onClick={(event) => event.stopPropagation()}
            style={{ width: "min(980px, 100%)" }}
          >
            <div className="row" style={{ justifyContent: "space-between" }}>
              <div className="stack" style={{ gap: 4 }}>
                <strong>{workflowPromptDialog.title}</strong>
                <div className="muted">{workflowPromptDialog.description}</div>
              </div>
              <button className="btn" type="button" onClick={() => setWorkflowPromptDialog(null)}>
                关闭
              </button>
            </div>
            <textarea
              className="strategyPrompt"
              value={workflowPromptDialog.value}
              disabled={!detail?.canEdit}
              onChange={(event) => updateWorkflowPromptDialogValue(event.target.value)}
              style={{ height: "60vh", resize: "none", overflowY: "auto" }}
              autoFocus
            />
            <div className="row" style={{ justifyContent: "space-between" }}>
              <span className="muted">{workflowPromptDialog.value.length.toLocaleString()} 字符</span>
              <div className="row">
                <button className="btn" type="button" onClick={() => setWorkflowPromptDialog(null)}>
                  取消
                </button>
                {detail?.canEdit ? (
                  <button className="btn btn-primary" type="button" onClick={applyWorkflowPromptDialog}>
                    应用修改
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <section className="panel">
        <input
          ref={folderImportInputRef}
          type="file"
          multiple
          onChange={(event) => void onStrategyFolderPicked(event)}
          style={{ display: "none" }}
          {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
        />
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div>
            <h2 style={{ margin: 0 }}>策略</h2>
            <div className="muted">{detail.canEdit ? "可编辑" : "只读（来自社区分享）"}</div>
          </div>
          <div className="row">
            <Link className="btn btn-primary" href={`/debates/new?strategyId=${detail.id}`}>
              使用策略
            </Link>
            <button className="btn" disabled={isExportingFolder} onClick={() => void downloadStrategyFolder()}>
              {isExportingFolder ? "导出中..." : "下载文件夹"}
            </button>
            {detail.canEdit ? (
              <button className="btn" disabled={isImportingFolder} onClick={openStrategyFolderImport}>
                {isImportingFolder ? "导入中..." : "上传文件夹覆盖"}
              </button>
            ) : null}
            {!detail.canEdit ? (
              <>
                <button className="btn" disabled={isFavoriting} onClick={() => void toggleFavorite()}>
                  {isFavoriting ? "处理中..." : detail.isFavorited ? "取消收藏" : "收藏"}
                </button>
                <button className="btn" disabled={isForking} onClick={() => void forkOne()}>
                  {isForking ? "Fork 中..." : "Fork"}
                </button>
              </>
            ) : null}
            <Link className="btn" href="/strategies">
              返回
            </Link>
          </div>
        </div>
      </section>

      <section className="panel stack">
        <div className="row">
          <div className="field" style={{ flex: 1 }}>
            <label>策略名称</label>
            <input value={name} disabled={!detail.canEdit} onChange={(event) => setName(event.target.value)} />
          </div>
          <label className="row" style={{ alignItems: "center", gap: 8, marginTop: 22 }}>
            <input
              type="checkbox"
              checked={isShared}
              disabled={!detail.canEdit}
              onChange={(event) => setIsShared(event.target.checked)}
            />
            <span>分享到社区</span>
          </label>
          {detail.canEdit ? (
            <>
              <button
                className="btn btn-primary"
                disabled={
                  !canSave ||
                  isSavingAll ||
                  isSaving ||
                  workflowPhasePromptsSaving ||
                  workflowContextAccessSaving ||
                  workflowSummarizerSaving
                }
                onClick={() => void saveAll()}
              >
                {isSavingAll || isSaving || workflowPhasePromptsSaving || workflowContextAccessSaving || workflowSummarizerSaving
                  ? "保存中..."
                  : "保存全部"}
              </button>
              <button className="btn btn-danger" disabled={isDeleting} onClick={() => void deleteOne()}>
                {isDeleting ? "删除中..." : "删除"}
              </button>
            </>
          ) : null}
        </div>

        <div className="field">
          <label>描述（可选）</label>
          <textarea value={description} disabled={!detail.canEdit} onChange={(event) => setDescription(event.target.value)} />
        </div>
      </section>

      <section className="panel stack">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div>
            <strong>独立总结器（可选）</strong>
            <div className="muted">策略可以声明一台独立总结器，用于每回摘要、每轮摘要和结构化事实板。真正绑定哪台 AI，会在“使用策略”创建辩论时再选择。</div>
          </div>
        </div>

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
      </section>

      <section className="panel stack">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div>
            <strong>讨论增强提示词（可选）</strong>
            <div className="muted">默认不需要复杂 workflow；只有当你希望某些讨论阶段带特殊规则时，才需要在这里补充开局提示词或阶段提示词。</div>
          </div>
        </div>

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
                        description: phase.description ?? "只有当 workflow 进入该阶段时，系统才会自动把这里的提示词注入到运行时 Prompt 中。",
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
      </section>

      <section className="panel stack">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div>
            <strong>上下文读取规则（可选）</strong>
            <div className="muted">默认可以完全不配。只有当某些目录需要“每次都读 / 按需读 / 到特定阶段再解锁”时，才需要在这里加规则。</div>
          </div>
        </div>

        {workflowContextAccessLoading ? (
          <div className="muted">加载中...</div>
        ) : (
          <div className="grid" style={{ gap: 16 }}>
            <div className="softBox stack">
              <div className="row" style={{ justifyContent: "space-between" }}>
                <strong>每会话必读目录</strong>
                {detail.canEdit ? (
                  <button className="btn" type="button" onClick={() => addContextAccessRule("alwaysRead")}>
                    新增目录
                  </button>
                ) : null}
              </div>
              <div className="muted">这些目录会在每次生成时自动注入，所以切新会话后模型也能重新看到。</div>
              {workflowContextAccess.alwaysRead.length <= 0 ? <div className="muted">未配置</div> : null}
              {workflowContextAccess.alwaysRead.map((rule, index) => (
                <div key={`always-${index}`} className="softBox stack">
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <strong>目录 #{index + 1}</strong>
                    {detail.canEdit ? (
                      <button className="btn btn-danger" type="button" onClick={() => removeContextAccessRule("alwaysRead", index)}>
                        删除
                      </button>
                    ) : null}
                  </div>
                  <div className="grid grid-2" style={{ gap: 12 }}>
                    <div className="field">
                      <label>范围</label>
                      <select value={rule.scope} disabled={!detail.canEdit} onChange={(event) => updateContextAccessRule("alwaysRead", index, { scope: event.target.value === "seat" ? "seat" : "shared" })}>
                        <option value="shared">shared</option>
                        <option value="seat">seat</option>
                      </select>
                    </div>
                    <div className="field">
                      <label>目录前缀</label>
                      <input value={rule.pathPrefix} disabled={!detail.canEdit} onChange={(event) => updateContextAccessRule("alwaysRead", index, { pathPrefix: event.target.value })} placeholder="例如 prompts/ 或 final/" />
                    </div>
                    <div className="field">
                      <label>单目录最多自动读几个文件</label>
                      <input type="number" min={1} value={rule.maxFiles} disabled={!detail.canEdit} onChange={(event) => updateContextAccessRule("alwaysRead", index, { maxFiles: Number(event.target.value) || 1 })} />
                    </div>
                    <div className="field">
                      <label>单文件最大字符</label>
                      <input type="number" min={200} value={rule.maxCharsPerFile} disabled={!detail.canEdit} onChange={(event) => updateContextAccessRule("alwaysRead", index, { maxCharsPerFile: Number(event.target.value) || 200 })} />
                    </div>
                    <label className="row" style={{ alignItems: "center", gap: 8, marginTop: 22 }}>
                      <input type="checkbox" checked={rule.recursive} disabled={!detail.canEdit} onChange={(event) => updateContextAccessRule("alwaysRead", index, { recursive: event.target.checked })} />
                      <span>递归子目录</span>
                    </label>
                  </div>
                </div>
              ))}
            </div>

            <div className="softBox stack">
              <div className="row" style={{ justifyContent: "space-between" }}>
                <strong>按需可读目录</strong>
                {detail.canEdit ? (
                  <button className="btn" type="button" onClick={() => addContextAccessRule("readWhenNeeded")}>
                    新增目录
                  </button>
                ) : null}
              </div>
              <div className="muted">这些目录不会自动进 prompt，但模型可以通过 `agent_files_read` / `debate_files_read` 在需要时读取。</div>
              {workflowContextAccess.readWhenNeeded.length <= 0 ? <div className="muted">未配置</div> : null}
              {workflowContextAccess.readWhenNeeded.map((rule, index) => (
                <div key={`optional-${index}`} className="softBox stack">
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <strong>目录 #{index + 1}</strong>
                    {detail.canEdit ? (
                      <button className="btn btn-danger" type="button" onClick={() => removeContextAccessRule("readWhenNeeded", index)}>
                        删除
                      </button>
                    ) : null}
                  </div>
                  <div className="grid grid-2" style={{ gap: 12 }}>
                    <div className="field">
                      <label>范围</label>
                      <select value={rule.scope} disabled={!detail.canEdit} onChange={(event) => updateContextAccessRule("readWhenNeeded", index, { scope: event.target.value === "seat" ? "seat" : "shared" })}>
                        <option value="shared">shared</option>
                        <option value="seat">seat</option>
                      </select>
                    </div>
                    <div className="field">
                      <label>目录前缀</label>
                      <input value={rule.pathPrefix} disabled={!detail.canEdit} onChange={(event) => updateContextAccessRule("readWhenNeeded", index, { pathPrefix: event.target.value })} placeholder="例如 references/ 或 facts/" />
                    </div>
                    <div className="field">
                      <label>单目录最多自动读几个文件</label>
                      <input type="number" min={1} value={rule.maxFiles} disabled={!detail.canEdit} onChange={(event) => updateContextAccessRule("readWhenNeeded", index, { maxFiles: Number(event.target.value) || 1 })} />
                    </div>
                    <div className="field">
                      <label>单文件最大字符</label>
                      <input type="number" min={200} value={rule.maxCharsPerFile} disabled={!detail.canEdit} onChange={(event) => updateContextAccessRule("readWhenNeeded", index, { maxCharsPerFile: Number(event.target.value) || 200 })} />
                    </div>
                    <label className="row" style={{ alignItems: "center", gap: 8, marginTop: 22 }}>
                      <input type="checkbox" checked={rule.recursive} disabled={!detail.canEdit} onChange={(event) => updateContextAccessRule("readWhenNeeded", index, { recursive: event.target.checked })} />
                      <span>递归子目录</span>
                    </label>
                  </div>
                </div>
              ))}
            </div>

            <div className="softBox stack">
              <div className="row" style={{ justifyContent: "space-between" }}>
                <strong>阶段后解锁目录</strong>
                {detail.canEdit ? (
                  <button className="btn" type="button" onClick={addPhaseGateRule}>
                    新增目录
                  </button>
                ) : null}
              </div>
              <div className="muted">这些目录在指定阶段之前既不会自动注入，也不允许工具读取；一旦到达该阶段，就会自动解锁并自动注入。</div>
              {workflowContextAccess.unlockAfterPhase.length <= 0 ? <div className="muted">未配置</div> : null}
              {workflowContextAccess.unlockAfterPhase.map((rule, index) => (
                <div key={`gate-${index}`} className="softBox stack">
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <strong>目录 #{index + 1}</strong>
                    {detail.canEdit ? (
                      <button className="btn btn-danger" type="button" onClick={() => removePhaseGateRule(index)}>
                        删除
                      </button>
                    ) : null}
                  </div>
                  <div className="grid grid-2" style={{ gap: 12 }}>
                    <div className="field">
                      <label>解锁阶段</label>
                      <select value={rule.phaseKind} disabled={!detail.canEdit} onChange={(event) => updatePhaseGateRule(index, { phaseKind: event.target.value as WorkflowPhasePrompt["kind"] })}>
                        <option value="analysis">analysis</option>
                        <option value="deliberation">deliberation</option>
                        <option value="finalization_vote">finalization_vote</option>
                        <option value="finalization">finalization</option>
                      </select>
                    </div>
                    <div className="field">
                      <label>范围</label>
                      <select value={rule.scope} disabled={!detail.canEdit} onChange={(event) => updatePhaseGateRule(index, { scope: event.target.value === "seat" ? "seat" : "shared" })}>
                        <option value="shared">shared</option>
                        <option value="seat">seat</option>
                      </select>
                    </div>
                    <div className="field">
                      <label>目录前缀</label>
                      <input value={rule.pathPrefix} disabled={!detail.canEdit} onChange={(event) => updatePhaseGateRule(index, { pathPrefix: event.target.value })} placeholder="例如 final/ 或 playbook/" />
                    </div>
                    <div className="field">
                      <label>单目录最多自动读几个文件</label>
                      <input type="number" min={1} value={rule.maxFiles} disabled={!detail.canEdit} onChange={(event) => updatePhaseGateRule(index, { maxFiles: Number(event.target.value) || 1 })} />
                    </div>
                    <div className="field">
                      <label>单文件最大字符</label>
                      <input type="number" min={200} value={rule.maxCharsPerFile} disabled={!detail.canEdit} onChange={(event) => updatePhaseGateRule(index, { maxCharsPerFile: Number(event.target.value) || 200 })} />
                    </div>
                    <label className="row" style={{ alignItems: "center", gap: 8, marginTop: 22 }}>
                      <input type="checkbox" checked={rule.recursive} disabled={!detail.canEdit} onChange={(event) => updatePhaseGateRule(index, { recursive: event.target.checked })} />
                      <span>递归子目录</span>
                    </label>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      <div className="grid" style={{ gap: 16, alignItems: "start" }}>
        <section className="panel stack">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <strong>角色（{roles.length}）</strong>
            {detail.canEdit ? (
              <div className="row">
                <button className="btn" type="button" disabled={selectedCount === 0} onClick={clearRoleSelection}>
                  清空选择
                </button>
                <button className="btn" type="button" onClick={selectAllRoles}>
                  全选
                </button>
                <button className="btn btn-danger" type="button" disabled={!canDeleteSelected} onClick={deleteSelectedRoles}>
                  删除选中
                </button>
                <button className="btn btn-primary" type="button" onClick={addRole}>
                  新增角色
                </button>
              </div>
            ) : (
              <button className="btn btn-primary" disabled={!detail.canEdit} onClick={addRole}>
                新增角色
              </button>
            )}
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

          {activeRole ? (
            <div className="softBox stack">
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
                <input value={activeRole.name} disabled={!detail.canEdit} onChange={(event) => updateRole(activeRoleIndex, { name: event.target.value })} />
              </div>

              <div className="field">
                <label>System Prompt</label>
                <textarea className="strategyPrompt" value={activeRole.systemPrompt} disabled={!detail.canEdit} onChange={(event) => updateRole(activeRoleIndex, { systemPrompt: event.target.value })} />
              </div>

              {!activeRole.id ? <div className="muted">新角色需要先点击保存后，才能编辑文件。</div> : null}
            </div>
          ) : (
            <div className="muted">请选择一个角色</div>
          )}
        </section>

        <div className="grid grid-2" style={{ gap: 16, alignItems: "start" }}>
          {activeRole?.id ? (
            <RoleFilesManagerColumns
              strategyId={detail.id}
              roleId={activeRole.id}
              readOnly={!detail.canEdit}
            />
          ) : (
            <>
              <section className="panel stack">
                <div className="muted">新角色需先保存后才能编辑文件。</div>
              </section>
              <section className="panel stack">
                <div className="muted">新角色需先保存后才能编辑文件。</div>
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
