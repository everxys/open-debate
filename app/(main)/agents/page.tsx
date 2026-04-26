"use client";
import { useCallback, useEffect, useRef, useState } from "react";

import { useAutoDismissToast } from "@/components/ui/use-toast";

type Agent = {
  id: string;
  name: string;
  provider: string;
  model: string;
  contextLength: number | null;
  maxInputTokens: number | null;
  maxOutputTokens: number | null;
  baseUrl: string;
  apiKeyMasked: string;
  lastConnectivityCheckStatus: "reachable" | "failed" | null;
  lastConnectivityCheckAt: string | null;
  lastConnectivityCheckMessage: string | null;
  usageControlMode: "none" | "coding_plan";
  quotaProfileId: string | null;
  isActive: boolean;
};

type QuotaProfileSummary = {
  profileId: string;
  profileName: string;
  limit5h: number;
  used5h: number;
  remaining5h: number;
  window5hStartAt: string | null;
  window5hEndAt: string | null;
  limitWeek: number;
  usedWeek: number;
  remainingWeek: number;
  weekWindowStartAt: string;
  weekWindowEndAt: string;
  limitMonth: number;
  usedMonth: number;
  remainingMonth: number;
  monthWindowStartAt: string;
  monthWindowEndAt: string;
  pacingMode: "percent" | "absolute";
  pacingValue: number;
  pacingTarget5h: number;
  nextAvailableAt: string | null;
  blockingReason: "pacing" | "rolling_5h_limit" | "week_limit" | "month_limit" | null;
  effectiveIntervalMs: number;
};

type QuotaProfile = {
  id: string;
  name: string;
  profileType: "coding_plan";
  requestLimit5h: number;
  requestLimitWeek: number;
  requestLimitMonth: number;
  pacingMode: "percent" | "absolute";
  pacingValue: number;
  resetTimezone: string;
  nextRequestNotBeforeAt: string | null;
  referencedAgentCount: number;
  summary: QuotaProfileSummary;
};

type OpenRouterModel = {
  id: string;
  name: string;
  contextLength: number | null;
  maxOutputTokens: number | null;
};

type AgentFilterTab = "all" | "enabled" | "disabled";

const initialForm = {
  name: "",
  provider: "openai",
  model: "gpt-4.1-mini",
  contextLength: "",
  maxInputTokens: "",
  maxOutputTokens: "",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "",
  usageControlMode: "none" as "none" | "coding_plan",
  quotaProfileId: ""
};

const initialQuotaProfileForm = {
  name: "",
  requestLimit5h: "1200",
  requestLimitWeek: "9000",
  requestLimitMonth: "18000",
  pacingMode: "percent" as "percent" | "absolute",
  pacingValue: "90",
  resetTimezone: "Asia/Shanghai"
};

const initialAdjustmentForm = {
  profileId: "",
  windowType: "rolling_5h" as "rolling_5h" | "week" | "month",
  delta: "",
  note: ""
};

export default function AgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [quotaProfiles, setQuotaProfiles] = useState<QuotaProfile[]>([]);
  const [filterTab, setFilterTab] = useState<AgentFilterTab>("all");
  const [form, setForm] = useState(initialForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingOriginal, setEditingOriginal] = useState<{
    name: string;
    provider: string;
    model: string;
    contextLength: number | null;
    maxInputTokens: number | null;
    maxOutputTokens: number | null;
    baseUrl: string;
    usageControlMode: "none" | "coding_plan";
    quotaProfileId: string | null;
  } | null>(null);
  const { toast, showToast } = useAutoDismissToast(1200);
  const [isTestingDraft, setIsTestingDraft] = useState(false);
  const [testingAgentId, setTestingAgentId] = useState<string | null>(null);
  const [duplicatingAgentId, setDuplicatingAgentId] = useState<string | null>(null);
  const [togglingAgentId, setTogglingAgentId] = useState<string | null>(null);
  const [selectedAgentIds, setSelectedAgentIds] = useState<string[]>([]);
  const [ioOpen, setIoOpen] = useState(false);
  const [ioPassphrase, setIoPassphrase] = useState("");
  const [ioFile, setIoFile] = useState<File | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const ioFileInputRef = useRef<HTMLInputElement | null>(null);
  const [openRouterModels, setOpenRouterModels] = useState<OpenRouterModel[]>([]);
  const [openRouterLoading, setOpenRouterLoading] = useState(false);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [modelSearch, setModelSearch] = useState("");
  const [debugOpen, setDebugOpen] = useState(false);
  const [debugLoading, setDebugLoading] = useState(false);
  const [debugTitle, setDebugTitle] = useState("");
  const [debugText, setDebugText] = useState("");
  const [toggleDialogAgent, setToggleDialogAgent] = useState<Agent | null>(null);
  const [quotaProfileForm, setQuotaProfileForm] = useState(initialQuotaProfileForm);
  const [editingQuotaProfileId, setEditingQuotaProfileId] = useState<string | null>(null);
  const [quotaActionLoading, setQuotaActionLoading] = useState<string>("");
  const [adjustmentForm, setAdjustmentForm] = useState(initialAdjustmentForm);
  const agentEditorRef = useRef<HTMLElement | null>(null);
  const [syncedAgentsPanelsHeight, setSyncedAgentsPanelsHeight] = useState<number | null>(null);

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
      error: {
        message: text || `${response.status} ${response.statusText}`.trim()
      }
    };
  }

  const loadAgents = useCallback(async () => {
    let response: Response;
    try {
      // Avoid stale list after create/update/delete (browser/proxy caching can keep GET results).
      response = await fetch("/api/agents", { cache: "no-store" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showToast("error", `Failed to fetch: ${message}`);
      return;
    }

    const payload = await readPayload(response);
    if (!response.ok) {
      showToast("error", payload.error?.message ?? "加载失败");
      return;
    }
    setAgents(payload.data ?? []);
  }, [showToast]);

  const loadQuotaProfiles = useCallback(async () => {
    let response: Response;
    try {
      response = await fetch("/api/quota-profiles", { cache: "no-store" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showToast("error", `Failed to fetch: ${message}`);
      return;
    }

    const payload = await readPayload(response);
    if (!response.ok) {
      showToast("error", payload.error?.message ?? "Coding Plan 加载失败");
      return;
    }
    setQuotaProfiles(payload.data ?? []);
  }, [showToast]);

  const reloadAll = useCallback(async () => {
    await Promise.all([loadAgents(), loadQuotaProfiles()]);
  }, [loadAgents, loadQuotaProfiles]);

  useEffect(() => {
    void reloadAll();
  }, [reloadAll]);

  async function loadCatalogModels() {
    if (openRouterLoading) return;
    setOpenRouterLoading(true);
    try {
      const response = await fetch("/api/model-catalog/models?source=openrouter", { cache: "no-store" });
      const payload = await readPayload(response);
      if (!response.ok) return;
      setOpenRouterModels(Array.isArray(payload.data) ? (payload.data as OpenRouterModel[]) : []);
    } finally {
      setOpenRouterLoading(false);
    }
  }

  useEffect(() => {
    void loadCatalogModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const element = agentEditorRef.current;
    if (!element) return;

    const syncHeight = () => {
      if (window.innerWidth < 900) {
        setSyncedAgentsPanelsHeight(null);
        return;
      }
      const next = Math.ceil(element.getBoundingClientRect().height);
      setSyncedAgentsPanelsHeight((current) => (current === next ? current : next));
    };

    syncHeight();
    const observer = new ResizeObserver(() => syncHeight());
    observer.observe(element);
    window.addEventListener("resize", syncHeight);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", syncHeight);
    };
  }, []);

  function parseContextLengthInput(value: string) {
    const raw = String(value ?? "").trim();
    if (!raw) return null;
    const n = Number(raw);
    if (!Number.isFinite(n)) return null;
    const v = Math.floor(n);
    return v > 0 ? v : null;
  }

  function parseMaxOutputTokensInput(value: string) {
    const raw = String(value ?? "").trim();
    if (!raw) return null;
    const n = Number(raw);
    if (!Number.isFinite(n)) return null;
    const v = Math.floor(n);
    return v > 0 ? v : null;
  }

  function parseMaxInputTokensInput(value: string) {
    const raw = String(value ?? "").trim();
    if (!raw) return null;
    const n = Number(raw);
    if (!Number.isFinite(n)) return null;
    const v = Math.floor(n);
    return v > 0 ? v : null;
  }

  const catalogSelectedModel = openRouterModels.find((item) => item.id === form.model.trim()) ?? null;

  const filteredOpenRouterModels = (() => {
    const q = modelSearch.trim().toLowerCase();
    if (!q) return openRouterModels.slice(0, 200);
    const out: OpenRouterModel[] = [];
    for (const m of openRouterModels) {
      if (out.length >= 200) break;
      if (m.id.toLowerCase().includes(q) || (m.name ?? "").toLowerCase().includes(q)) out.push(m);
    }
    return out;
  })();

  const enabledAgentsCount = agents.filter((agent) => agent.isActive).length;
  const disabledAgentsCount = agents.length - enabledAgentsCount;
  const editingAgent = editingId ? agents.find((agent) => agent.id === editingId) ?? null : null;
  const selectedQuotaProfile =
    form.usageControlMode === "coding_plan"
      ? quotaProfiles.find((profile) => profile.id === form.quotaProfileId) ?? null
      : null;
  const filteredAgents = agents.filter((agent) => {
    if (filterTab === "enabled") return agent.isActive;
    if (filterTab === "disabled") return !agent.isActive;
    return true;
  });

  function formatLocalTime(value: string | null) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString("zh-CN", { hour12: false });
  }

  function getConnectivityCheckText(agent: Agent) {
    if (agent.lastConnectivityCheckStatus === "reachable") return "最近连通性校验：通过";
    if (agent.lastConnectivityCheckStatus === "failed") return "最近连通性校验：失败";
    return "最近连通性校验：未校验";
  }

  function getQuotaBlockingReasonText(reason: QuotaProfileSummary["blockingReason"]) {
    if (reason === "rolling_5h_limit") return "5 小时硬上限";
    if (reason === "week_limit") return "周硬上限";
    if (reason === "month_limit") return "月硬上限";
    if (reason === "pacing") return "节流";
    return "正常";
  }

  const canTestDraft =
    form.model.trim().length > 0 &&
    form.baseUrl.trim().length > 0 &&
    form.apiKey.trim().length > 0;
  const hasValidQuotaBinding = form.usageControlMode !== "coding_plan" || form.quotaProfileId.trim().length > 0;
  const canSave = canTestDraft && form.name.trim().length > 0 && hasValidQuotaBinding;
  const canUpdate =
    form.name.trim().length > 0 &&
    form.model.trim().length > 0 &&
    form.baseUrl.trim().length > 0 &&
    hasValidQuotaBinding;

  async function createAgent() {
    let response: Response;
    try {
      const body = {
        ...form,
        contextLength: parseContextLengthInput(form.contextLength),
        maxInputTokens: parseMaxInputTokensInput(form.maxInputTokens),
        maxOutputTokens: parseMaxOutputTokensInput(form.maxOutputTokens),
        quotaProfileId: form.usageControlMode === "coding_plan" ? form.quotaProfileId || null : null
      };
      response = await fetch("/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showToast("error", `Failed to fetch: ${message}`);
      return;
    }

    const payload = await readPayload(response);

    if (!response.ok) {
      showToast("error", payload.error?.message ?? "创建失败");
      return;
    }

    setForm(initialForm);
    showToast("success", "创建成功");
    await reloadAll();
  }

  function startEdit(agent: Agent) {
    setEditingId(agent.id);
    setEditingOriginal({
      name: agent.name,
      provider: agent.provider,
      model: agent.model,
      contextLength: agent.contextLength ?? null,
      maxInputTokens: agent.maxInputTokens ?? null,
      maxOutputTokens: agent.maxOutputTokens ?? null,
      baseUrl: agent.baseUrl,
      usageControlMode: agent.usageControlMode,
      quotaProfileId: agent.quotaProfileId
    });
    setForm({
      name: agent.name,
      provider: agent.provider,
      model: agent.model,
      contextLength: agent.contextLength ? String(agent.contextLength) : "",
      maxInputTokens: agent.maxInputTokens ? String(agent.maxInputTokens) : "",
      maxOutputTokens: agent.maxOutputTokens ? String(agent.maxOutputTokens) : "",
      baseUrl: agent.baseUrl,
      apiKey: "",
      usageControlMode: agent.usageControlMode,
      quotaProfileId: agent.quotaProfileId ?? ""
    });
  }

  function cancelEdit() {
    setEditingId(null);
    setEditingOriginal(null);
    setForm(initialForm);
  }

  function getChanges() {
    if (!editingOriginal) return [];
    const changes: string[] = [];
    if (form.name !== editingOriginal.name) changes.push("名称");
    if (form.provider !== editingOriginal.provider) changes.push("Provider");
    if (form.model !== editingOriginal.model) changes.push("模型");
    if (parseContextLengthInput(form.contextLength) !== (editingOriginal.contextLength ?? null)) changes.push("上下文长度");
    if (parseMaxInputTokensInput(form.maxInputTokens) !== (editingOriginal.maxInputTokens ?? null)) {
      changes.push("最大输入");
    }
    if (parseMaxOutputTokensInput(form.maxOutputTokens) !== (editingOriginal.maxOutputTokens ?? null)) {
      changes.push("最大输出");
    }
    if (form.baseUrl !== editingOriginal.baseUrl) changes.push("Base URL");
    if (form.usageControlMode !== editingOriginal.usageControlMode) changes.push("限额模式");
    if ((form.quotaProfileId || null) !== (editingOriginal.quotaProfileId ?? null)) changes.push("Coding Plan");
    if (form.apiKey.trim()) changes.push("API Key");
    return changes;
  }

  async function updateAgent() {
    if (!editingId) return;
    const changes = getChanges();
    if (changes.length === 0) {
      showToast("error", "没有修改内容");
      return;
    }
    const ok = window.confirm(`确认保存修改？\n将更新：${changes.join("、")}`);
    if (!ok) return;

    const body: Record<string, unknown> = {
      name: form.name,
      provider: form.provider,
      model: form.model,
      contextLength: parseContextLengthInput(form.contextLength),
      maxInputTokens: parseMaxInputTokensInput(form.maxInputTokens),
      maxOutputTokens: parseMaxOutputTokensInput(form.maxOutputTokens),
      baseUrl: form.baseUrl,
      usageControlMode: form.usageControlMode,
      quotaProfileId: form.usageControlMode === "coding_plan" ? form.quotaProfileId || null : null
    };
    if (form.apiKey.trim()) body.apiKey = form.apiKey;

    let response: Response;
    try {
      response = await fetch(`/api/agents/${editingId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showToast("error", `Failed to fetch: ${message}`);
      return;
    }

    const payload = await readPayload(response);
    if (!response.ok) {
      showToast("error", payload.error?.message ?? "更新失败");
      return;
    }

    showToast("success", "已更新");
    setEditingId(null);
    setEditingOriginal(null);
    setForm(initialForm);
    await reloadAll();
  }

  async function testDraftConfig() {
    if (isTestingDraft) return;
    setIsTestingDraft(true);
    let response: Response;
    try {
      response = await fetch("/api/agents/test-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          quotaProfileId: form.usageControlMode === "coding_plan" ? form.quotaProfileId || null : null
        })
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showToast("error", `Failed to fetch: ${message}`);
      setIsTestingDraft(false);
      return;
    }

    const payload = await readPayload(response);
    const text =
      payload.data?.message ??
      payload.error?.message ??
      `${response.status} ${response.statusText}`.trim();
    showToast(response.ok ? "success" : "error", text);
    await loadQuotaProfiles();
    setIsTestingDraft(false);
  }

  async function testAgent(id: string) {
    if (testingAgentId === id) return;
    setTestingAgentId(id);
    let response: Response;
    try {
      response = await fetch(`/api/agents/${id}/test`, { method: "POST" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showToast("error", `Failed to fetch: ${message}`);
      setTestingAgentId(null);
      return;
    }

    const payload = await readPayload(response);
    const text =
      payload.data?.message ??
      payload.error?.message ??
      `${response.status} ${response.statusText}`.trim();
    showToast(response.ok ? "success" : "error", text);
    await reloadAll();
    setTestingAgentId(null);
  }

  async function debugAgent(id: string, name: string) {
    if (debugLoading) return;
    setDebugOpen(true);
    setDebugLoading(true);
    setDebugTitle(`${name} · 返回 JSON`);
    setDebugText("加载中...");

    let response: Response;
    try {
      response = await fetch(`/api/agents/${id}/test?debug=1`, { method: "POST" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setDebugText(`Failed to fetch: ${message}`);
      setDebugLoading(false);
      return;
    }

    const payload = await readPayload(response);
    if (!response.ok) {
      setDebugText(payload.error?.message ?? "读取失败");
      setDebugLoading(false);
      return;
    }

    try {
      setDebugText(JSON.stringify(payload.data ?? null, null, 2));
    } catch {
      setDebugText(String(payload.data ?? ""));
    }
    await reloadAll();
    setDebugLoading(false);
  }

  function startQuotaProfileEdit(profile: QuotaProfile) {
    setEditingQuotaProfileId(profile.id);
    setQuotaProfileForm({
      name: profile.name,
      requestLimit5h: String(profile.requestLimit5h),
      requestLimitWeek: String(profile.requestLimitWeek),
      requestLimitMonth: String(profile.requestLimitMonth),
      pacingMode: profile.pacingMode,
      pacingValue: String(profile.pacingValue),
      resetTimezone: profile.resetTimezone
    });
    setAdjustmentForm((current) => ({
      ...current,
      profileId: profile.id
    }));
  }

  function cancelQuotaProfileEdit() {
    setEditingQuotaProfileId(null);
    setQuotaProfileForm(initialQuotaProfileForm);
  }

  async function saveQuotaProfile() {
    const requestLimit5h = parseContextLengthInput(quotaProfileForm.requestLimit5h);
    const requestLimitWeek = parseContextLengthInput(quotaProfileForm.requestLimitWeek);
    const requestLimitMonth = parseContextLengthInput(quotaProfileForm.requestLimitMonth);
    const pacingValue = parseContextLengthInput(quotaProfileForm.pacingValue);
    if (!quotaProfileForm.name.trim() || !requestLimit5h || !requestLimitWeek || !requestLimitMonth || !pacingValue) {
      showToast("error", "请完整填写 Coding Plan 配置");
      return;
    }
    setQuotaActionLoading("save-profile");
    let response: Response;
    try {
      response = await fetch(editingQuotaProfileId ? `/api/quota-profiles/${editingQuotaProfileId}` : "/api/quota-profiles", {
        method: editingQuotaProfileId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: quotaProfileForm.name.trim(),
          requestLimit5h,
          requestLimitWeek,
          requestLimitMonth,
          pacingMode: quotaProfileForm.pacingMode,
          pacingValue,
          resetTimezone: quotaProfileForm.resetTimezone.trim() || "Asia/Shanghai"
        })
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showToast("error", `Failed to fetch: ${message}`);
      setQuotaActionLoading("");
      return;
    }
    const payload = await readPayload(response);
    if (!response.ok) {
      showToast("error", payload.error?.message ?? "Coding Plan 保存失败");
      setQuotaActionLoading("");
      return;
    }
    showToast("success", editingQuotaProfileId ? "Coding Plan 已更新" : "Coding Plan 已创建");
    cancelQuotaProfileEdit();
    await reloadAll();
    setQuotaActionLoading("");
  }

  async function deleteQuotaProfile(profile: QuotaProfile) {
    const ok = window.confirm(`确认删除 Coding Plan“${profile.name}”？如果仍被 AI 配置引用，将无法删除。`);
    if (!ok) return;
    setQuotaActionLoading(`delete:${profile.id}`);
    let response: Response;
    try {
      response = await fetch(`/api/quota-profiles/${profile.id}`, { method: "DELETE" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showToast("error", `Failed to fetch: ${message}`);
      setQuotaActionLoading("");
      return;
    }
    const payload = await readPayload(response);
    if (!response.ok) {
      showToast("error", payload.error?.message ?? "Coding Plan 删除失败");
      setQuotaActionLoading("");
      return;
    }
    if (editingQuotaProfileId === profile.id) {
      cancelQuotaProfileEdit();
    }
    if (form.quotaProfileId === profile.id) {
      setForm((current) => ({ ...current, usageControlMode: "none", quotaProfileId: "" }));
    }
    showToast("success", "Coding Plan 已删除");
    await reloadAll();
    setQuotaActionLoading("");
  }

  async function applyQuotaAdjustment() {
    if (!adjustmentForm.profileId) {
      showToast("error", "请选择需要校正的 Coding Plan");
      return;
    }
    const delta = Number(adjustmentForm.delta);
    if (!Number.isFinite(delta) || Math.trunc(delta) === 0) {
      showToast("error", "请输入非 0 的校正次数");
      return;
    }
    setQuotaActionLoading("adjust-profile");
    let response: Response;
    try {
      response = await fetch(`/api/quota-profiles/${adjustmentForm.profileId}/adjustments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          windowType: adjustmentForm.windowType,
          delta: Math.trunc(delta),
          note: adjustmentForm.note.trim() || null
        })
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showToast("error", `Failed to fetch: ${message}`);
      setQuotaActionLoading("");
      return;
    }
    const payload = await readPayload(response);
    if (!response.ok) {
      showToast("error", payload.error?.message ?? "校正失败");
      setQuotaActionLoading("");
      return;
    }
    showToast("success", "Coding Plan 已校正");
    setAdjustmentForm((current) => ({ ...current, delta: "", note: "" }));
    await loadQuotaProfiles();
    setQuotaActionLoading("");
  }

  async function deleteAgent(id: string) {
    const ok = window.confirm("确认删除该 AI 配置？（如果正被进行中的辩论使用，将无法删除）");
    if (!ok) return;

    let response: Response;
    try {
      response = await fetch(`/api/agents/${id}`, { method: "DELETE" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showToast("error", `Failed to fetch: ${message}`);
      return;
    }

    const payload = await readPayload(response);
    if (!response.ok) {
      showToast("error", payload.error?.message ?? "删除失败");
      return;
    }

    showToast("success", "已删除");
    await reloadAll();
  }

  async function duplicateAgent(id: string) {
    if (duplicatingAgentId === id) return;
    setDuplicatingAgentId(id);
    let response: Response;
    try {
      response = await fetch(`/api/agents/${id}/duplicate`, { method: "POST" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showToast("error", `Failed to fetch: ${message}`);
      setDuplicatingAgentId(null);
      return;
    }

    const payload = await readPayload(response);
    if (!response.ok) {
      showToast("error", payload.error?.message ?? "复制失败");
      setDuplicatingAgentId(null);
      return;
    }

    showToast("success", "已复制");
    await reloadAll();
    setDuplicatingAgentId(null);
  }

  async function toggleAgentActive(agent: Agent) {
    if (togglingAgentId === agent.id) return;
    setTogglingAgentId(agent.id);
    const nextActive = !agent.isActive;
    let response: Response;
    try {
      response = await fetch(`/api/agents/${agent.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: nextActive })
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showToast("error", `Failed to fetch: ${message}`);
      setTogglingAgentId(null);
      return;
    }
    const payload = await readPayload(response);
    if (!response.ok) {
      showToast("error", payload.error?.message ?? `${nextActive ? "启用" : "禁用"}失败`);
      setTogglingAgentId(null);
      return;
    }
    showToast("success", nextActive ? "已启用" : "已禁用");
    await reloadAll();
    setTogglingAgentId(null);
    setToggleDialogAgent(null);
  }

  function openToggleDialog(agent: Agent) {
    if (togglingAgentId === agent.id) return;
    setToggleDialogAgent(agent);
  }

  function toggleSelected(id: string) {
    setSelectedAgentIds((current) => (current.includes(id) ? current.filter((x) => x !== id) : [...current, id]));
  }

  function encodeBase64(bytes: Uint8Array) {
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function decodeBase64(text: string) {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  async function deriveAesKey(passphrase: string, salt: Uint8Array, iterations: number) {
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
      keyMaterial,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  }

  async function encryptPack(passphrase: string, pack: unknown) {
    const iterations = 200_000;
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveAesKey(passphrase, salt, iterations);
    const enc = new TextEncoder();
    const plaintext = enc.encode(JSON.stringify(pack));
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext));
    return {
      type: "open-debate-agent-pack",
      v: 1,
      kdf: { name: "PBKDF2", hash: "SHA-256", iterations, salt: encodeBase64(salt) },
      cipher: { name: "AES-GCM", iv: encodeBase64(iv) },
      data: encodeBase64(ciphertext)
    };
  }

  async function decryptPack(passphrase: string, envelope: any) {
    if (!envelope || envelope.type !== "open-debate-agent-pack" || envelope.v !== 1) {
      throw new Error("invalid envelope");
    }
    const salt = decodeBase64(String(envelope.kdf?.salt ?? ""));
    const iterations = Number(envelope.kdf?.iterations ?? 0);
    const iv = decodeBase64(String(envelope.cipher?.iv ?? ""));
    const ciphertext = decodeBase64(String(envelope.data ?? ""));
    if (!iterations || salt.length === 0 || iv.length === 0 || ciphertext.length === 0) {
      throw new Error("invalid envelope");
    }
    const key = await deriveAesKey(passphrase, salt, iterations);
    const plaintextBytes = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext));
    const dec = new TextDecoder();
    return JSON.parse(dec.decode(plaintextBytes));
  }

  function downloadJson(filename: string, data: unknown) {
    const text = JSON.stringify(data, null, 2);
    const blob = new Blob([text], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function exportSelectedEncrypted() {
    if (isExporting) return;
    if (selectedAgentIds.length === 0) {
      showToast("error", "请先勾选要导出的 AI 配置");
      return;
    }
    if (!ioPassphrase.trim()) {
      showToast("error", "请填写加密口令");
      return;
    }
    if (!crypto?.subtle) {
      showToast("error", "当前环境不支持 WebCrypto");
      return;
    }

    setIsExporting(true);
    try {
      const response = await fetch("/api/agents/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentIds: selectedAgentIds })
      });
      const payload = await readPayload(response);
      if (!response.ok) {
        showToast("error", payload.error?.message ?? "导出失败");
        return;
      }
      const pack = payload.data;
      const envelope = await encryptPack(ioPassphrase, pack);
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      downloadJson(`open-debate-agents-${stamp}.json`, envelope);
      showToast("success", "已导出（加密）");
      setIoOpen(false);
    } finally {
      setIsExporting(false);
    }
  }

  async function importEncryptedFile() {
    if (isImporting) return;
    if (!ioFile) {
      showToast("error", "请选择要导入的文件");
      return;
    }
    if (!ioPassphrase.trim()) {
      showToast("error", "请填写解密口令");
      return;
    }
    if (!crypto?.subtle) {
      showToast("error", "当前环境不支持 WebCrypto");
      return;
    }

    setIsImporting(true);
    try {
      const raw = await ioFile.text();
      const envelope = JSON.parse(raw);
      const pack = await decryptPack(ioPassphrase, envelope);
      const response = await fetch("/api/agents/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(pack)
      });
      const payload = await readPayload(response);
      if (!response.ok) {
        showToast("error", payload.error?.message ?? "导入失败");
        return;
      }
      showToast("success", `已导入 ${Array.isArray(payload.data) ? payload.data.length : 1} 个配置`);
      setIoFile(null);
      if (ioFileInputRef.current) {
        ioFileInputRef.current.value = "";
      }
      setIoOpen(false);
      await reloadAll();
    } catch (error) {
      showToast("error", error instanceof Error ? error.message : "导入失败");
    } finally {
      setIsImporting(false);
    }
  }

  return (
    <div className="grid grid-2 agentsPageGrid">
      {toast ? (
        <div
          className={`toast ${toast.type === "success" ? "toast-success" : "toast-error"}`}
          role="status"
          aria-live="polite"
        >
          {toast.text}
        </div>
      ) : null}
      {ioOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          onClick={() => setIoOpen(false)}
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
          <div className="panel stack" onClick={(e) => e.stopPropagation()} style={{ width: "min(880px, 100%)" }}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <strong>导入 / 导出（加密文件）</strong>
              <button className="btn" onClick={() => setIoOpen(false)}>
                关闭
              </button>
            </div>
            <div className="muted">导出文件为加密 JSON，包含 API Key；导入时只需同一个口令解密。</div>

            <div className="field">
              <label>加密口令（导入/导出共用）</label>
              <input
                type="password"
                autoComplete="off"
                data-1p-ignore="true"
                data-bwignore="true"
                data-lpignore="true"
                value={ioPassphrase}
                onChange={(event) => setIoPassphrase(event.target.value)}
                placeholder="请输入口令（请自行妥善保存）"
              />
            </div>

            <div className="grid grid-2" style={{ gap: 16, alignItems: "start" }}>
              <section className="panel stack">
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <strong>导出</strong>
                  <span className="muted">已选 {selectedAgentIds.length}</span>
                </div>
                <div className="row">
                  <button
                    className="btn"
                    onClick={() => setSelectedAgentIds(agents.map((a) => a.id))}
                  >
                    全选
                  </button>
                  <button className="btn" onClick={() => setSelectedAgentIds([])}>
                    清空
                  </button>
                </div>
                <button className="btn btn-primary" disabled={isExporting} onClick={() => void exportSelectedEncrypted()}>
                  {isExporting ? "导出中..." : "导出为文件"}
                </button>
              </section>

              <section className="panel stack">
                <strong>导入</strong>
                <input
                  ref={ioFileInputRef}
                  type="file"
                  accept="application/json,.json"
                  onChange={(event) => {
                    const file = event.target.files?.[0] ?? null;
                    setIoFile(file);
                  }}
                />
                <button className="btn btn-primary" disabled={isImporting} onClick={() => void importEncryptedFile()}>
                  {isImporting ? "导入中..." : "导入文件"}
                </button>
              </section>
            </div>
          </div>
        </div>
      ) : null}
      {toggleDialogAgent ? (
        <div
          role="dialog"
          aria-modal="true"
          onClick={() => setToggleDialogAgent(null)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(15, 23, 42, 0.45)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 24,
            zIndex: 1001
          }}
        >
          <div
            className="panel stack"
            onClick={(event) => event.stopPropagation()}
            style={{ width: "min(520px, 100%)" }}
          >
            <div className="row" style={{ justifyContent: "space-between" }}>
              <strong>{toggleDialogAgent.isActive ? "确认禁用 AI 配置" : "确认启用 AI 配置"}</strong>
              <button className="btn" type="button" onClick={() => setToggleDialogAgent(null)}>
                关闭
              </button>
            </div>
            <div className="stack" style={{ gap: 8 }}>
              <div>
                {toggleDialogAgent.isActive
                  ? `禁用后，“${toggleDialogAgent.name}”将不会出现在可用 AI 配置里。`
                  : `启用后，“${toggleDialogAgent.name}”会重新出现在可用 AI 配置里。`}
              </div>
              <div className="muted">
                Provider: {toggleDialogAgent.provider} · Model: {toggleDialogAgent.model}
              </div>
            </div>
            <div className="row" style={{ justifyContent: "flex-end" }}>
              <button className="btn btn-muted" type="button" onClick={() => setToggleDialogAgent(null)}>
                取消
              </button>
              <button
                className={`btn ${toggleDialogAgent.isActive ? "btn-danger" : "btn-primary"}`}
                type="button"
                disabled={togglingAgentId === toggleDialogAgent.id}
                onClick={() => void toggleAgentActive(toggleDialogAgent)}
              >
                {togglingAgentId === toggleDialogAgent.id
                  ? "处理中..."
                  : toggleDialogAgent.isActive
                    ? "确认禁用"
                    : "确认启用"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      <section ref={agentEditorRef} className={`panel stack agentEditor ${editingId ? "agentEditorEditing" : ""}`}>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2 style={{ margin: 0 }}>{editingId ? "编辑 AI 配置" : "新建 AI 配置"}</h2>
        </div>
        {editingAgent ? (
          <div
            className="row"
            style={{ justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}
            title={editingAgent.lastConnectivityCheckMessage ?? undefined}
          >
            <span
              className={`agentStatus ${
                editingAgent.lastConnectivityCheckStatus === "reachable"
                  ? "agentStatusEnabled"
                  : editingAgent.lastConnectivityCheckStatus === "failed"
                    ? "agentStatusDisabled"
                    : ""
              }`}
              style={editingAgent.lastConnectivityCheckStatus ? undefined : { color: "var(--muted)" }}
            >
              {getConnectivityCheckText(editingAgent)}
            </span>
            <span className="muted">
              {editingAgent.lastConnectivityCheckAt
                ? `上次校验：${formatLocalTime(editingAgent.lastConnectivityCheckAt)}`
                : "尚未记录校验时间"}
            </span>
          </div>
        ) : null}
        <div className="field">
          <label>名称</label>
          <input
            name="name"
            autoComplete="off"
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
            placeholder="例如：LongCat Flash Lite"
          />
        </div>
        <div className="field">
          <label>Provider</label>
          <select
            value={form.provider}
            onChange={(event) =>
              setForm({
                ...form,
                provider: event.target.value,
                baseUrl:
                  event.target.value === "openai"
                    ? "https://api.openai.com/v1"
                    : "https://api.anthropic.com/v1"
              })
            }
          >
            <option value="openai">OpenAI</option>
            <option value="anthropic">Anthropic</option>
          </select>
        </div>
        <div className="field">
          <label>模型</label>
          <input
            name="model"
            autoComplete="off"
            value={form.model}
            onChange={(event) => setForm({ ...form, model: event.target.value })}
            placeholder="给 Provider 用的模型名（可自定义）"
          />
        </div>
        <div className="field">
          <label>上下文长度（tokens，可选）</label>
          <div className="row" style={{ gap: 8 }}>
            <input
              name="contextLength"
              autoComplete="off"
              value={form.contextLength}
              onChange={(event) => setForm({ ...form, contextLength: event.target.value })}
              style={{ flex: 1, minWidth: 220 }}
              placeholder="留空=未知；例如 128000"
            />
            <button
              className="btn"
              type="button"
              disabled={openRouterLoading || openRouterModels.length === 0}
              onClick={() => {
                setModelSearch(form.model.trim());
                setModelPickerOpen(true);
              }}
              title={openRouterModels.length === 0 ? "模型目录为空（可刷新）" : "从模型目录中选择，并自动填充上下文长度、查看最大输出上限"}
            >
              从目录填充
            </button>
            <button
              className="btn btn-muted"
              type="button"
              disabled={openRouterLoading}
              onClick={() => void loadCatalogModels()}
            >
              {openRouterLoading ? "刷新中..." : "刷新模型"}
            </button>
          </div>
          <div className="hint">
            {parseContextLengthInput(form.contextLength)
              ? `75% ≈ ${Math.floor((parseContextLengthInput(form.contextLength) ?? 0) * 0.75).toLocaleString()}`
              : "可用“从目录填充”自动写入，也可以手动输入。"}
          </div>
          {catalogSelectedModel ? (
            <div className="hint">
              目录信息：
              {catalogSelectedModel.contextLength
                ? ` 上下文 ${catalogSelectedModel.contextLength.toLocaleString()}`
                : " 上下文未提供"}
              {"；"}
              {catalogSelectedModel.maxOutputTokens
                ? `最大输出 ${catalogSelectedModel.maxOutputTokens.toLocaleString()}`
                : "最大输出未提供"}
            </div>
          ) : null}
        </div>
        <div className="field">
          <label>最大输入 Token（可选）</label>
          <input
            name="maxInputTokens"
            autoComplete="off"
            value={form.maxInputTokens}
            onChange={(event) => setForm({ ...form, maxInputTokens: event.target.value })}
            placeholder="留空=未知；例如 64000"
          />
          <div className="hint">这是单次请求可接受的最大输入，不等于总上下文窗口。</div>
        </div>
        <div className="field">
          <label>最大输出 Token（可选）</label>
          <input
            name="maxOutputTokens"
            autoComplete="off"
            value={form.maxOutputTokens}
            onChange={(event) => setForm({ ...form, maxOutputTokens: event.target.value })}
            placeholder="留空=未知；例如 32000"
          />
          <div className="hint">
            {parseMaxOutputTokensInput(form.maxOutputTokens)
              ? `当前配置会把单轮输出上限夹到 ${parseMaxOutputTokensInput(form.maxOutputTokens)?.toLocaleString()} 以内`
              : "如果知道模型官方最大输出，可以填在这里，运行时会优先参考。"}
          </div>
        </div>
        <div className="field">
          <label>Base URL</label>
          <input
            name="baseUrl"
            autoComplete="off"
            value={form.baseUrl}
            onChange={(event) => setForm({ ...form, baseUrl: event.target.value })}
            placeholder="https://api.openai.com/v1"
          />
          <div className="hint">如果只填到域名根路径，服务端会尝试自动补全 /v1。</div>
        </div>
        <div className="field">
          <label>限额模式</label>
          <select
            value={form.usageControlMode}
            onChange={(event) =>
              setForm((current) => ({
                ...current,
                usageControlMode: event.target.value === "coding_plan" ? "coding_plan" : "none",
                quotaProfileId: event.target.value === "coding_plan" ? current.quotaProfileId : ""
              }))
            }
          >
            <option value="none">不控制</option>
            <option value="coding_plan">Coding Plan</option>
          </select>
        </div>
        {form.usageControlMode === "coding_plan" ? (
          <div className="field">
            <label>共享 Coding Plan</label>
            <select
              value={form.quotaProfileId}
              onChange={(event) => setForm((current) => ({ ...current, quotaProfileId: event.target.value }))}
            >
              <option value="">请选择计划池</option>
              {quotaProfiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                </option>
              ))}
            </select>
            <div className="hint">多个 AI 配置绑定同一个计划池时，会共享同一套请求预算。</div>
            {selectedQuotaProfile ? (
              <div className="panel stack" style={{ gap: 6 }}>
                <div>
                  <strong>{selectedQuotaProfile.name}</strong>
                </div>
                <div className="muted">
                  5 小时：{selectedQuotaProfile.summary.used5h}/{selectedQuotaProfile.summary.limit5h} · 周：
                  {selectedQuotaProfile.summary.usedWeek}/{selectedQuotaProfile.summary.limitWeek} · 月：
                  {selectedQuotaProfile.summary.usedMonth}/{selectedQuotaProfile.summary.limitMonth}
                </div>
                <div className="muted">
                  节流：{selectedQuotaProfile.pacingMode === "percent" ? `${selectedQuotaProfile.pacingValue}%` : `${selectedQuotaProfile.pacingValue} 次`}
                  {" · "}
                  当前状态：{getQuotaBlockingReasonText(selectedQuotaProfile.summary.blockingReason)}
                </div>
                <div className="muted">
                  {selectedQuotaProfile.summary.nextAvailableAt
                    ? `下一次可请求：${formatLocalTime(selectedQuotaProfile.summary.nextAvailableAt)}`
                    : "当前可立即请求"}
                </div>
              </div>
            ) : (
              <div className="hint">还没有创建计划池时，可先在下方“Coding Plan 池管理”里新增。</div>
            )}
          </div>
        ) : null}

        <div className="field">
          <label>API Key</label>
          <input
            type="password"
            name="apiKey"
            autoComplete="off"
            data-1p-ignore="true"
            data-bwignore="true"
            data-lpignore="true"
            value={form.apiKey}
            onChange={(event) => setForm({ ...form, apiKey: event.target.value })}
            placeholder="Bearer Token / API Key"
          />
          <div className="hint">
            {editingId ? "留空表示不修改现有 Key。" : "不会在页面上明文展示，保存后只显示掩码。"}
          </div>
        </div>
        <div className="row">
          <button
            className="btn"
            disabled={(editingId ? false : !canTestDraft) || isTestingDraft}
            onClick={() =>
              void (editingId && !form.apiKey.trim() ? testAgent(editingId) : testDraftConfig())
            }
          >
            {isTestingDraft
              ? "测试中..."
              : editingId && !form.apiKey.trim()
                ? "测试已保存配置"
                : "测试当前输入"}
          </button>
          {editingId ? (
            <>
              <button className="btn btn-muted" onClick={() => cancelEdit()}>
                取消
              </button>
              <button
                className="btn btn-primary"
                disabled={!canUpdate}
                onClick={() => void updateAgent()}
              >
                保存修改
              </button>
            </>
          ) : (
            <button className="btn btn-primary" disabled={!canSave} onClick={() => void createAgent()}>
              保存
            </button>
          )}
        </div>
      </section>

      <section className="panel stack" style={{ order: 3, gridColumn: "1 / -1" }}>
        <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
          <h2 style={{ margin: 0 }}>Coding Plan 池管理</h2>
          <span className="muted">{quotaProfiles.length} 个计划池</span>
        </div>
        <div className="row" style={{ gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
          <div className="panel stack" style={{ flex: "1 1 360px", minWidth: 320 }}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <strong>{editingQuotaProfileId ? "编辑计划池" : "新建计划池"}</strong>
              {editingQuotaProfileId ? (
                <button className="btn btn-muted" type="button" onClick={() => cancelQuotaProfileEdit()}>
                  取消
                </button>
              ) : null}
            </div>
            <div className="field">
              <label>名称</label>
              <input
                value={quotaProfileForm.name}
                onChange={(event) => setQuotaProfileForm((current) => ({ ...current, name: event.target.value }))}
                placeholder="例如：Coding Plan Lite"
              />
            </div>
            <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
              <div className="field" style={{ flex: 1, minWidth: 180 }}>
                <label>5 小时限额</label>
                <input
                  value={quotaProfileForm.requestLimit5h}
                  onChange={(event) =>
                    setQuotaProfileForm((current) => ({ ...current, requestLimit5h: event.target.value }))
                  }
                />
              </div>
              <div className="field" style={{ flex: 1, minWidth: 180 }}>
                <label>周限额</label>
                <input
                  value={quotaProfileForm.requestLimitWeek}
                  onChange={(event) =>
                    setQuotaProfileForm((current) => ({ ...current, requestLimitWeek: event.target.value }))
                  }
                />
              </div>
              <div className="field" style={{ flex: 1, minWidth: 180 }}>
                <label>月限额</label>
                <input
                  value={quotaProfileForm.requestLimitMonth}
                  onChange={(event) =>
                    setQuotaProfileForm((current) => ({ ...current, requestLimitMonth: event.target.value }))
                  }
                />
              </div>
            </div>
            <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
              <div className="field" style={{ flex: 1, minWidth: 180 }}>
                <label>节流模式</label>
                <select
                  value={quotaProfileForm.pacingMode}
                  onChange={(event) =>
                    setQuotaProfileForm((current) => ({
                      ...current,
                      pacingMode: event.target.value === "absolute" ? "absolute" : "percent"
                    }))
                  }
                >
                  <option value="percent">百分比</option>
                  <option value="absolute">固定次数</option>
                </select>
              </div>
              <div className="field" style={{ flex: 1, minWidth: 180 }}>
                <label>{quotaProfileForm.pacingMode === "percent" ? "节流百分比" : "5 小时固定次数"}</label>
                <input
                  value={quotaProfileForm.pacingValue}
                  onChange={(event) =>
                    setQuotaProfileForm((current) => ({ ...current, pacingValue: event.target.value }))
                  }
                />
              </div>
              <div className="field" style={{ flex: 1, minWidth: 180 }}>
                <label>时区</label>
                <input
                  value={quotaProfileForm.resetTimezone}
                  onChange={(event) =>
                    setQuotaProfileForm((current) => ({ ...current, resetTimezone: event.target.value }))
                  }
                  placeholder="Asia/Shanghai"
                />
              </div>
            </div>
            <div className="row">
              <button
                className="btn btn-primary"
                type="button"
                disabled={quotaActionLoading === "save-profile"}
                onClick={() => void saveQuotaProfile()}
              >
                {quotaActionLoading === "save-profile" ? "保存中..." : editingQuotaProfileId ? "保存计划池" : "创建计划池"}
              </button>
            </div>
          </div>

          <div className="panel stack" style={{ flex: "1 1 320px", minWidth: 320 }}>
            <strong>手工校正外部消耗</strong>
            <div className="field">
              <label>目标计划池</label>
              <select
                value={adjustmentForm.profileId}
                onChange={(event) => setAdjustmentForm((current) => ({ ...current, profileId: event.target.value }))}
              >
                <option value="">请选择计划池</option>
                {quotaProfiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
              <div className="field" style={{ flex: 1, minWidth: 160 }}>
                <label>窗口</label>
                <select
                  value={adjustmentForm.windowType}
                  onChange={(event) =>
                    setAdjustmentForm((current) => ({
                      ...current,
                      windowType: event.target.value as "rolling_5h" | "week" | "month"
                    }))
                  }
                >
                  <option value="rolling_5h">5 小时</option>
                  <option value="week">周</option>
                  <option value="month">月</option>
                </select>
              </div>
              <div className="field" style={{ flex: 1, minWidth: 160 }}>
                <label>校正次数</label>
                <input
                  value={adjustmentForm.delta}
                  onChange={(event) => setAdjustmentForm((current) => ({ ...current, delta: event.target.value }))}
                  placeholder="正数=额外消耗，负数=回退"
                />
              </div>
            </div>
            <div className="field">
              <label>备注</label>
              <input
                value={adjustmentForm.note}
                onChange={(event) => setAdjustmentForm((current) => ({ ...current, note: event.target.value }))}
                placeholder="例如：外部 IDE 已额外消耗 320 次"
              />
            </div>
            <div className="row">
              <button
                className="btn"
                type="button"
                disabled={quotaActionLoading === "adjust-profile"}
                onClick={() => void applyQuotaAdjustment()}
              >
                {quotaActionLoading === "adjust-profile" ? "提交中..." : "提交校正"}
              </button>
            </div>
          </div>
        </div>

        <div className="card-list">
          {quotaProfiles.map((profile) => (
            <div className="panel stack" key={profile.id}>
              <div className="row" style={{ justifyContent: "space-between", gap: 12, alignItems: "center" }}>
                <strong>{profile.name}</strong>
                <span className="muted">引用 {profile.referencedAgentCount}</span>
              </div>
              <div className="muted">
                5 小时 {profile.summary.used5h}/{profile.summary.limit5h} · 周 {profile.summary.usedWeek}/{profile.summary.limitWeek} · 月{" "}
                {profile.summary.usedMonth}/{profile.summary.limitMonth}
              </div>
              <div className="muted">
                节流 {profile.pacingMode === "percent" ? `${profile.pacingValue}%` : `${profile.pacingValue} 次`} · 当前状态{" "}
                {getQuotaBlockingReasonText(profile.summary.blockingReason)}
              </div>
              <div className="muted">
                {profile.summary.nextAvailableAt
                  ? `下一次可请求：${formatLocalTime(profile.summary.nextAvailableAt)}`
                  : "当前可立即请求"}
              </div>
              <div className="muted">时区：{profile.resetTimezone}</div>
              <div className="row">
                <button className="btn" type="button" onClick={() => startQuotaProfileEdit(profile)}>
                  编辑
                </button>
                <button
                  className="btn"
                  type="button"
                  onClick={() =>
                    setAdjustmentForm((current) => ({
                      ...current,
                      profileId: profile.id
                    }))
                  }
                >
                  设为校正目标
                </button>
                <button
                  className="btn btn-danger"
                  type="button"
                  disabled={quotaActionLoading === `delete:${profile.id}`}
                  onClick={() => void deleteQuotaProfile(profile)}
                >
                  {quotaActionLoading === `delete:${profile.id}` ? "删除中..." : "删除"}
                </button>
              </div>
            </div>
          ))}
          {quotaProfiles.length === 0 ? <div className="muted">还没有创建 Coding Plan 计划池。</div> : null}
        </div>
      </section>

      {modelPickerOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          onClick={() => setModelPickerOpen(false)}
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
              <strong>选择模型（OpenRouter）</strong>
              <button className="btn" type="button" onClick={() => setModelPickerOpen(false)}>
                关闭
              </button>
            </div>
            <div className="row" style={{ gap: 8 }}>
              <input
                autoComplete="off"
                value={modelSearch}
                onChange={(event) => setModelSearch(event.target.value)}
                placeholder="搜索 id / name，例如 gpt-4.1 或 claude"
                style={{ flex: 1, minWidth: 220 }}
              />
              <button className="btn btn-muted" type="button" onClick={() => setModelSearch("")}>
                清空
              </button>
            </div>
            <div className="muted">
              {openRouterModels.length > 0 ? `共 ${openRouterModels.length.toLocaleString()} 个模型（列表只显示前 200 个匹配项）` : "暂无模型"}
            </div>
            <div className="stack" style={{ gap: 8, maxHeight: "60vh", overflowY: "auto" }}>
              {filteredOpenRouterModels.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className="btn"
                  style={{ textAlign: "left" }}
                  onClick={() => {
                    const ctx = m.contextLength ? String(m.contextLength) : "";
                    const out = m.maxOutputTokens ? String(m.maxOutputTokens) : "";
                    setForm((cur) => ({ ...cur, contextLength: ctx, maxOutputTokens: out || cur.maxOutputTokens }));
                    setModelPickerOpen(false);
                  }}
                  title={m.name || m.id}
                >
                  <div className="row" style={{ justifyContent: "space-between", gap: 12 }}>
                    <strong style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.id}</strong>
                    <span className="muted" style={{ flex: "0 0 auto" }}>
                      {m.contextLength ? `${m.contextLength.toLocaleString()} ctx` : "ctx ?"}
                      {" · "}
                      {m.maxOutputTokens ? `${m.maxOutputTokens.toLocaleString()} out` : "out ?"}
                    </span>
                  </div>
                  {m.name ? <div className="muted">{m.name}</div> : null}
                </button>
              ))}
              {filteredOpenRouterModels.length === 0 ? <div className="muted">（没有匹配项）</div> : null}
            </div>
          </div>
        </div>
      ) : null}

      {debugOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          onClick={() => setDebugOpen(false)}
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
              <strong>{debugTitle || "返回 JSON"}</strong>
              <button className="btn" type="button" onClick={() => setDebugOpen(false)}>
                关闭
              </button>
            </div>
            <div className="panel" style={{ height: "70vh", overflowY: "auto" }}>
              <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{debugText}</pre>
            </div>
          </div>
        </div>
      ) : null}

      <section
        className="panel stack agentsListPanel"
        style={syncedAgentsPanelsHeight ? { minHeight: syncedAgentsPanelsHeight, height: syncedAgentsPanelsHeight } : undefined}
      >
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2 style={{ margin: 0 }}>已有配置</h2>
          <button className="btn" onClick={() => setIoOpen(true)}>
            导入/导出
          </button>
        </div>
        <div className="tabsBar">
          <button
            type="button"
            className={`tab ${filterTab === "all" ? "tabActive" : ""}`}
            onClick={() => setFilterTab("all")}
          >
            <span className="tabName">全部</span>
            <span className="muted">{agents.length}</span>
          </button>
          <button
            type="button"
            className={`tab ${filterTab === "enabled" ? "tabActive" : ""}`}
            onClick={() => setFilterTab("enabled")}
          >
            <span className="agentStatus agentStatusEnabled">
              <span className="agentStatusDot" aria-hidden="true" />
              已启用
            </span>
            <span className="muted">{enabledAgentsCount}</span>
          </button>
          <button
            type="button"
            className={`tab ${filterTab === "disabled" ? "tabActive" : ""}`}
            onClick={() => setFilterTab("disabled")}
          >
            <span className="agentStatus agentStatusDisabled">
              <span className="agentStatusDot" aria-hidden="true" />
              已禁用
            </span>
            <span className="muted">{disabledAgentsCount}</span>
          </button>
        </div>
        <div className="card-list agentsListViewport">
          {filteredAgents.map((agent) => {
            const agentQuotaProfile =
              agent.quotaProfileId ? quotaProfiles.find((profile) => profile.id === agent.quotaProfileId) ?? null : null;
            const connectivityStatusClass =
              agent.lastConnectivityCheckStatus === "reachable"
                ? "agentStatusEnabled"
                : agent.lastConnectivityCheckStatus === "failed"
                  ? "agentStatusDisabled"
                  : "";
            const summaryItems = [
              agent.contextLength ? `Context ${agent.contextLength.toLocaleString()}` : null,
              agent.maxInputTokens ? `Input ${agent.maxInputTokens.toLocaleString()}` : null,
              agent.maxOutputTokens ? `Output ${agent.maxOutputTokens.toLocaleString()}` : null,
              `限额 ${agent.usageControlMode === "coding_plan" ? "Coding Plan" : "不控制"}`
            ].filter(Boolean) as string[];
            const quotaItems = agentQuotaProfile
              ? [
                  `计划池 ${agentQuotaProfile.name}`,
                  `5 小时 ${agentQuotaProfile.summary.used5h}/${agentQuotaProfile.summary.limit5h}`,
                  `周 ${agentQuotaProfile.summary.usedWeek}/${agentQuotaProfile.summary.limitWeek}`,
                  agentQuotaProfile.summary.nextAvailableAt
                    ? `下次可请求 ${formatLocalTime(agentQuotaProfile.summary.nextAvailableAt)}`
                    : "当前可立即请求",
                  `限制原因 ${getQuotaBlockingReasonText(agentQuotaProfile.summary.blockingReason)}`
                ]
              : [];
            return (
              <div
                className={`panel agentCard ${agent.id === editingId ? "agentCardEditing" : ""}`}
                key={agent.id}
              >
                <div className="agentCardLayout">
                  <div className="stack agentCardMain">
                    <div className="row agentCardHeader">
                      <label className="row agentCardIdentity">
                        <input
                          type="checkbox"
                          checked={selectedAgentIds.includes(agent.id)}
                          onChange={() => toggleSelected(agent.id)}
                          style={{ marginTop: 3, flex: "0 0 auto" }}
                        />
                        <span className="stack agentCardIdentityText">
                          <strong className="agentCardTitle">{agent.name}</strong>
                          <span className="muted">
                            {agent.provider} · {agent.model}
                          </span>
                        </span>
                      </label>
                      <span className={`agentStatus ${agent.isActive ? "agentStatusEnabled" : "agentStatusDisabled"}`}>
                        <span className="agentStatusDot" aria-hidden="true" />
                        {agent.isActive ? "已启用" : "已禁用"}
                      </span>
                    </div>

                    <div className="agentCardMetrics">
                      {summaryItems.map((item) => (
                        <div key={item} className="muted agentCardMetric">
                          {item}
                        </div>
                      ))}
                      {quotaItems.map((item) => (
                        <div key={item} className="muted agentCardMetric agentCardMetricQuota">
                          {item}
                        </div>
                      ))}
                    </div>

                    <div className="stack agentCardMeta">
                      <div className="muted">{agent.baseUrl}</div>
                      <div className="muted">Key: {agent.apiKeyMasked}</div>
                    </div>
                  </div>

                  <div className="stack agentCardAside">
                    <div className="stack agentCardAsideStatus">
                      <span
                        className={`agentStatus ${connectivityStatusClass}`}
                        style={agent.lastConnectivityCheckStatus ? undefined : { color: "var(--muted)" }}
                        title={agent.lastConnectivityCheckMessage ?? undefined}
                      >
                        {getConnectivityCheckText(agent)}
                      </span>
                      <span className="muted">
                        {agent.lastConnectivityCheckAt ? formatLocalTime(agent.lastConnectivityCheckAt) : "尚无校验时间"}
                      </span>
                    </div>

                    <div className="agentCardActions">
                      <button
                        className="btn"
                        disabled={testingAgentId === agent.id}
                        onClick={() => void testAgent(agent.id)}
                      >
                        {testingAgentId === agent.id ? "测试中..." : "测试连接"}
                      </button>
                      <button className="btn" disabled={debugLoading} onClick={() => void debugAgent(agent.id, agent.name)}>
                        返回 JSON
                      </button>
                      <button className="btn" onClick={() => startEdit(agent)}>
                        修改
                      </button>
                      <button
                        className="btn"
                        disabled={duplicatingAgentId === agent.id}
                        onClick={() => void duplicateAgent(agent.id)}
                      >
                        {duplicatingAgentId === agent.id ? "复制中..." : "复制"}
                      </button>
                      <button className="btn" disabled={togglingAgentId === agent.id} onClick={() => openToggleDialog(agent)}>
                        {togglingAgentId === agent.id ? "处理中..." : agent.isActive ? "禁用" : "启用"}
                      </button>
                      <button className="btn btn-danger" onClick={() => void deleteAgent(agent.id)}>
                        删除
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
          {filteredAgents.length === 0 ? (
            <div className="muted">
              {agents.length === 0
                ? "暂无 AI 配置"
                : filterTab === "enabled"
                  ? "暂无已启用的 AI 配置"
                  : filterTab === "disabled"
                    ? "暂无已禁用的 AI 配置"
                    : "暂无 AI 配置"}
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}
