"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import { MarkdownView } from "@/components/ui/markdown";
import { useAutoDismissToast } from "@/components/ui/use-toast";

type Agent = {
  id: string;
  name: string;
  provider: string;
  model: string;
};

type StrategyListItem = {
  id: string;
  name: string;
  roleCount: number;
};

type StrategyDetail = {
  id: string;
  name: string;
  isShared: boolean;
  roles: Array<{
    id: string;
    name: string;
    systemPrompt: string | null;
    roleOrder: number;
  }>;
};

type WorkflowPhasePrompt = {
  id: string;
  title: string;
  kind: string;
  description: string | null;
  minRounds: number | null;
  injectedPrompt: string;
};

type WorkflowIdeaBank = {
  rawIdeaBankPath: string | null;
  derivedFiles: {
    selectedSTierPath: string | null;
    selectedATierPath: string | null;
    rejectedOrMergedPath: string | null;
    eventMappingsPath: string | null;
    newlyInventedIdeasPath: string | null;
  };
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
};

type WorkflowConfigPayload = {
  summarizer?: Partial<WorkflowSummarizer> & {
    prompts?: Partial<WorkflowSummarizer["prompts"]>;
  };
  [key: string]: unknown;
};

type BindingRow = {
  rowId: string;
  roleId: string;
  enabled: boolean;
  agentId: string;
};

type PromptPreviewDialogState =
  | null
  | {
      title: string;
      description: string;
      value: string;
    };

const QUESTION_HISTORY_STORAGE_KEY = "open-debate:new-debate-question-history";
const QUESTION_HISTORY_LIMIT = 12;

const initialForm = {
  question: "",
  maxTurns: 10,
  unlimitedTurns: false,
  enableSharedFacts: true
};

function summarizePrompt(value: string) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return "未配置";
  return normalized.length > 120 ? `${normalized.slice(0, 120)}...` : normalized;
}

function summarizeQuestionHistoryItem(value: string) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return "空白问题";
  return normalized.length > 80 ? `${normalized.slice(0, 80)}...` : normalized;
}

function assignAgentsEvenly(rows: BindingRow[], agentIds: string[]) {
  if (rows.length === 0 || agentIds.length === 0) return rows;
  return rows.map((row, index) => ({
    ...row,
    agentId: agentIds[index % agentIds.length] ?? ""
  }));
}

function pickRandomAgentId(agentIds: string[]) {
  if (agentIds.length === 0) return "";
  return agentIds[Math.floor(Math.random() * agentIds.length)] ?? "";
}

export default function NewDebatePage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedAgentIds, setSelectedAgentIds] = useState<string[]>([]);
  const [form, setForm] = useState(initialForm);
  const [questionZoomOpen, setQuestionZoomOpen] = useState(false);
  const { toast, showToast } = useAutoDismissToast(1200);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [strategies, setStrategies] = useState<StrategyListItem[]>([]);
  const [strategyId, setStrategyId] = useState<string>("");
  const [strategyDetail, setStrategyDetail] = useState<StrategyDetail | null>(null);
  const [workflowOpeningPrompt, setWorkflowOpeningPrompt] = useState("");
  const [workflowIdeaBank, setWorkflowIdeaBank] = useState<WorkflowIdeaBank | null>(null);
  const [workflowSummarizer, setWorkflowSummarizer] = useState<WorkflowSummarizer | null>(null);
  const [workflowPhasePrompts, setWorkflowPhasePrompts] = useState<WorkflowPhasePrompt[]>([]);
  const [workflowPhasePromptsLoading, setWorkflowPhasePromptsLoading] = useState(false);
  const [bindingRows, setBindingRows] = useState<BindingRow[]>([]);
  const [summaryAgentId, setSummaryAgentId] = useState("");
  const [promptPreviewDialog, setPromptPreviewDialog] = useState<PromptPreviewDialogState>(null);
  const [questionHistory, setQuestionHistory] = useState<string[]>([]);
  const [questionHistoryOpen, setQuestionHistoryOpen] = useState(false);

  function newRowId() {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
    return `row_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }

  const loadAgents = useCallback(async () => {
    const response = await fetch("/api/agents");
    const payload = await response.json();
    if (!response.ok) {
      showToast("error", payload.error?.message ?? "加载 AI 配置失败");
      return;
    }
    setAgents(payload.data ?? []);
  }, [showToast]);

  const loadStrategies = useCallback(async () => {
    const response = await fetch("/api/strategies?scope=mine");
    const payload = await response.json();
    if (!response.ok) {
      return;
    }
    setStrategies(payload.data ?? []);
  }, []);

  async function loadStrategyDetail(id: string) {
    if (!id) {
      setStrategyDetail(null);
      setWorkflowOpeningPrompt("");
      setWorkflowIdeaBank(null);
      setWorkflowSummarizer(null);
      setWorkflowPhasePrompts([]);
      setBindingRows([]);
      setSummaryAgentId("");
      return;
    }

    setWorkflowPhasePromptsLoading(true);

    try {
      const [strategyResponse, workflowResponse, workflowConfigResponse] = await Promise.all([
        fetch(`/api/strategies/${id}`),
        fetch(`/api/strategies/${id}/workflow-phase-prompts`),
        fetch(`/api/strategies/${id}/workflow-config`)
      ]);
      const payload = await strategyResponse.json();
      const workflowPayload = await workflowResponse.json();
      const workflowConfigPayload = await workflowConfigResponse.json();
      if (!strategyResponse.ok) {
        showToast("error", payload.error?.message ?? "加载策略失败");
        setStrategyDetail(null);
        setWorkflowPhasePrompts([]);
        return;
      }
      if (!workflowResponse.ok) {
        showToast("error", workflowPayload.error?.message ?? "加载阶段注入提示词失败");
        setWorkflowOpeningPrompt("");
        setWorkflowIdeaBank(null);
        setWorkflowSummarizer(null);
        setWorkflowPhasePrompts([]);
      } else {
        setWorkflowOpeningPrompt(typeof workflowPayload.data?.openingPrompt === "string" ? workflowPayload.data.openingPrompt : "");
        const ideaBank = workflowPayload.data?.ideaBank;
        setWorkflowIdeaBank(
          ideaBank && typeof ideaBank === "object"
            ? {
                rawIdeaBankPath: typeof ideaBank.rawIdeaBankPath === "string" ? ideaBank.rawIdeaBankPath : null,
                derivedFiles: {
                  selectedSTierPath:
                    typeof ideaBank.derivedFiles?.selectedSTierPath === "string" ? ideaBank.derivedFiles.selectedSTierPath : null,
                  selectedATierPath:
                    typeof ideaBank.derivedFiles?.selectedATierPath === "string" ? ideaBank.derivedFiles.selectedATierPath : null,
                  rejectedOrMergedPath:
                    typeof ideaBank.derivedFiles?.rejectedOrMergedPath === "string" ? ideaBank.derivedFiles.rejectedOrMergedPath : null,
                  eventMappingsPath:
                    typeof ideaBank.derivedFiles?.eventMappingsPath === "string" ? ideaBank.derivedFiles.eventMappingsPath : null,
                  newlyInventedIdeasPath:
                    typeof ideaBank.derivedFiles?.newlyInventedIdeasPath === "string" ? ideaBank.derivedFiles.newlyInventedIdeasPath : null
                }
              }
            : null
        );
        setWorkflowPhasePrompts(
          Array.isArray(workflowPayload.data?.phases)
            ? workflowPayload.data.phases.map((phase: Record<string, unknown>) => ({
                id: String(phase.id ?? ""),
                title: String(phase.title ?? ""),
                kind: String(phase.kind ?? ""),
                description: typeof phase.description === "string" ? phase.description : null,
                minRounds: typeof phase.minRounds === "number" ? phase.minRounds : null,
                injectedPrompt: typeof phase.injectedPrompt === "string" ? phase.injectedPrompt : ""
              }))
            : []
        );
      }
      if (workflowConfigResponse.ok) {
        const workflowConfig =
          workflowConfigPayload.data?.workflowConfig && typeof workflowConfigPayload.data.workflowConfig === "object"
            ? (workflowConfigPayload.data.workflowConfig as WorkflowConfigPayload)
            : null;
        const summarizerRaw =
          workflowConfig?.summarizer && typeof workflowConfig.summarizer === "object"
            ? workflowConfig.summarizer
            : null;
        setWorkflowSummarizer(
          summarizerRaw
            ? {
                enabled: Boolean(summarizerRaw.enabled),
                perTurn: summarizerRaw.perTurn === undefined ? true : Boolean(summarizerRaw.perTurn),
                perRound: summarizerRaw.perRound === undefined ? true : Boolean(summarizerRaw.perRound),
                factsBoard: summarizerRaw.factsBoard === undefined ? true : Boolean(summarizerRaw.factsBoard),
                prompts: {
                  turnSummary:
                    typeof summarizerRaw.prompts?.turnSummary === "string" ? summarizerRaw.prompts.turnSummary : "",
                  roundSummary:
                    typeof summarizerRaw.prompts?.roundSummary === "string" ? summarizerRaw.prompts.roundSummary : "",
                  factsBoard:
                    typeof summarizerRaw.prompts?.factsBoard === "string" ? summarizerRaw.prompts.factsBoard : ""
                }
              }
            : null
        );
      } else {
        setWorkflowSummarizer(null);
      }

      const detail = payload.data as StrategyDetail;
      setStrategyDetail(detail);
      setSummaryAgentId("");
      setBindingRows((current) => {
        const roleIdSet = new Set((detail.roles ?? []).map((r) => r.id));
        const kept = current.filter((row) => roleIdSet.has(row.roleId));
        const existingCounts = new Map<string, number>();
        for (const row of kept) existingCounts.set(row.roleId, (existingCounts.get(row.roleId) ?? 0) + 1);

        const next: BindingRow[] = [...kept];
        for (const role of detail.roles ?? []) {
          if ((existingCounts.get(role.id) ?? 0) > 0) continue;
          next.push({ rowId: role.id, roleId: role.id, enabled: true, agentId: "" });
        }
        return next;
      });
    } finally {
      setWorkflowPhasePromptsLoading(false);
    }
  }

  useEffect(() => {
    void loadAgents();
    void loadStrategies();
  }, [loadAgents, loadStrategies]);

  useEffect(() => {
    const id = searchParams.get("strategyId") ?? "";
    if (!id) return;
    setStrategyId(id);
    void loadStrategyDetail(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(QUESTION_HISTORY_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      setQuestionHistory(
        parsed
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.trim())
          .filter(Boolean)
          .slice(0, QUESTION_HISTORY_LIMIT)
      );
    } catch {
      // ignore invalid local history
    }
  }, []);

  function toggleAgent(id: string) {
    setSelectedAgentIds((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
    );
  }

  function applyFairStrategyBinding() {
    const enabled = bindingRows.filter((row) => row.enabled);
    if (enabled.length === 0) {
      showToast("error", "没有可分配的启用席位");
      return;
    }
    if (agents.length === 0) {
      showToast("error", "还没有可用的 AI 配置");
      return;
    }

    const assigned = assignAgentsEvenly(enabled, agents.map((agent) => agent.id));
    const byRowId = new Map(assigned.map((row) => [row.rowId, row.agentId]));
    setBindingRows((current) =>
      current.map((row) => (byRowId.has(row.rowId) ? { ...row, agentId: byRowId.get(row.rowId) ?? "" } : row))
    );
    showToast("success", `已均匀分配 ${agents.length} 台 AI 到 ${enabled.length} 个启用席位`);
  }

  function assignRandomSummaryAgent() {
    if (agents.length === 0) {
      showToast("error", "还没有可用的 AI 配置");
      return;
    }
    const nextId = pickRandomAgentId(agents.map((agent) => agent.id));
    setSummaryAgentId(nextId);
    const picked = agents.find((agent) => agent.id === nextId);
    showToast("success", picked ? `已为总结器随机选择：${picked.name}` : "已为总结器随机选择一台 AI");
  }

  const rolesById = useMemo(() => {
    const map = new Map<string, StrategyDetail["roles"][number]>();
    for (const role of strategyDetail?.roles ?? []) map.set(role.id, role);
    return map;
  }, [strategyDetail]);

  const enabledRows = bindingRows.filter((row) => row.enabled);
  const enabledBindings = enabledRows.filter((row) => row.agentId.trim().length > 0);
  const hasDuplicateStrategyAgentIds = (() => {
    const ids = enabledRows.map((row) => row.agentId).filter(Boolean);
    return new Set(ids).size !== ids.length;
  })();

  const canSubmit =
    form.question.trim().length >= 10 &&
    (form.unlimitedTurns ||
      (Number.isFinite(form.maxTurns) && form.maxTurns >= 1 && form.maxTurns <= 200)) &&
    (strategyId
      ? enabledRows.length >= 2 &&
        enabledBindings.length === enabledRows.length &&
        (!workflowSummarizer?.enabled || Boolean(summaryAgentId))
      : selectedAgentIds.length >= 2) &&
    !isSubmitting;

  async function createDebate() {
    if (!canSubmit) return;
    setIsSubmitting(true);
    try {
        const response = await fetch("/api/debates", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            question: form.question,
            maxTurns: form.unlimitedTurns ? 0 : form.maxTurns,
            enableSharedFacts: form.enableSharedFacts,
            ...(strategyId
              ? {
                  strategy: {
                    strategyId,
                    bindings: enabledRows.map((row) => ({
                      roleId: row.roleId,
                      agentId: row.agentId
                    })),
                    summaryAgentId: workflowSummarizer?.enabled ? summaryAgentId || null : null
                  }
                }
              : { agentIds: selectedAgentIds })
          })
        });
      const payload = await response.json();
      if (!response.ok) {
        showToast("error", payload.error?.message ?? "创建失败");
        return;
      }

      const trimmedQuestion = form.question.trim();
      if (typeof window !== "undefined" && trimmedQuestion) {
        const nextHistory = [trimmedQuestion, ...questionHistory.filter((item) => item !== trimmedQuestion)].slice(
          0,
          QUESTION_HISTORY_LIMIT
        );
        setQuestionHistory(nextHistory);
        window.localStorage.setItem(QUESTION_HISTORY_STORAGE_KEY, JSON.stringify(nextHistory));
      }

      showToast("success", "创建成功");
      router.push(`/debates/${payload.data?.id}`);
    } finally {
      setIsSubmitting(false);
    }
  }

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
      {questionZoomOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          onClick={() => setQuestionZoomOpen(false)}
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
              <strong>放大编辑问题</strong>
              <button className="btn" type="button" onClick={() => setQuestionZoomOpen(false)}>
                关闭
              </button>
            </div>
            <textarea
              value={form.question}
              onChange={(event) => setForm({ ...form, question: event.target.value })}
              onFocus={() => setQuestionHistoryOpen(true)}
              placeholder="请输入辩论问题（至少 10 个字）。如果策略启用了点子库，请只写作品目标、世界前提和最高原则，不要把 100+ 点子再塞进这里。"
              maxLength={50_000}
              style={{ height: "60vh", resize: "none", overflowY: "auto" }}
              autoFocus
            />
            <div className="row" style={{ justifyContent: "flex-end" }}>
              <span className="muted">{form.question.length.toLocaleString()}/50,000</span>
            </div>
          </div>
        </div>
      ) : null}
      {promptPreviewDialog ? (
        <div
          role="dialog"
          aria-modal="true"
          onClick={() => setPromptPreviewDialog(null)}
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
                <strong>{promptPreviewDialog.title}</strong>
                <div className="muted">{promptPreviewDialog.description}</div>
              </div>
              <button className="btn" type="button" onClick={() => setPromptPreviewDialog(null)}>
                关闭
              </button>
            </div>
            <div
              style={{ maxHeight: "60vh", overflowY: "auto" }}
            >
              <MarkdownView value={promptPreviewDialog.value || "未配置"} />
            </div>
          </div>
        </div>
      ) : null}

      <section className="panel">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div>
            <h2 style={{ margin: 0 }}>新增辩论</h2>
            <div className="muted">
              {strategyId
                ? "已选择策略：映射角色到你的 AI 配置（至少 2 个）。"
                : "选择至少 2 个 AI，创建后可在详情页开始运行。"}
            </div>
          </div>
          <Link className="btn" href="/debates">
            返回
          </Link>
        </div>
      </section>

      <section className="panel stack">
        <div className="field">
          <label>策略（可选）</label>
          <div className="row">
            <select
              value={strategyId}
              onChange={(event) => {
                const next = event.target.value;
                setStrategyId(next);
                setStrategyDetail(null);
                setSelectedAgentIds([]);
                void loadStrategyDetail(next);
              }}
              style={{ flex: 1 }}
            >
              <option value="">不使用策略（手动选择 AI）</option>
              {strategies.map((strategy) => (
                <option key={strategy.id} value={strategy.id}>
                  {strategy.name} · 角色 {strategy.roleCount}
                </option>
              ))}
            </select>
            <Link className="btn" href="/strategies">
              管理策略
            </Link>
          </div>
        </div>

        <div className="field">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <label>问题</label>
            <button className="btn" type="button" onClick={() => setQuestionZoomOpen(true)}>
              放大
            </button>
          </div>
          <div style={{ position: "relative" }}>
            <textarea
              value={form.question}
              onChange={(event) => setForm({ ...form, question: event.target.value })}
              onFocus={() => setQuestionHistoryOpen(true)}
              onBlur={() => window.setTimeout(() => setQuestionHistoryOpen(false), 120)}
              placeholder="请输入辩论问题（至少 10 个字）。如果策略启用了点子库，请只写作品目标、世界前提和最高原则，不要把 100+ 点子再塞进这里。"
              maxLength={50_000}
              rows={7}
              style={{ height: 180, maxHeight: 180, overflowY: "auto", resize: "none" }}
            />
            {questionHistoryOpen && questionHistory.length > 0 ? (
              <div
                className="panel stack"
                style={{
                  position: "absolute",
                  top: "calc(100% + 6px)",
                  left: 0,
                  right: 0,
                  zIndex: 20,
                  maxHeight: 240,
                  overflowY: "auto",
                  gap: 8
                }}
              >
                <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
                  <strong style={{ fontSize: 13 }}>最近填写过的问题</strong>
                  <button
                    className="btn btn-muted"
                    type="button"
                    onMouseDown={(event) => {
                      event.preventDefault();
                      setQuestionHistory([]);
                      if (typeof window !== "undefined") {
                        window.localStorage.removeItem(QUESTION_HISTORY_STORAGE_KEY);
                      }
                    }}
                  >
                    清空
                  </button>
                </div>
                {questionHistory.map((item, index) => (
                  <button
                    key={`${index}-${item.slice(0, 20)}`}
                    className="btn btn-muted"
                    type="button"
                    onMouseDown={(event) => {
                      event.preventDefault();
                      setForm((current) => ({ ...current, question: item }));
                      setQuestionHistoryOpen(false);
                    }}
                    style={{
                      justifyContent: "flex-start",
                      textAlign: "left",
                      whiteSpace: "normal",
                      lineHeight: 1.5
                    }}
                    title={item}
                  >
                    {summarizeQuestionHistoryItem(item)}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span className="muted">支持长文本，输入框会固定高度并滚动</span>
            <span className="muted">
              {form.question.length.toLocaleString()}/50,000
            </span>
          </div>
        </div>
        <div className="row">
          <div className="field" style={{ flex: 1 }}>
            <label>最大轮数（每轮=所有参与者各发言一次）</label>
            <input
              type="number"
              value={form.maxTurns}
              disabled={form.unlimitedTurns}
              min={0}
              max={200}
              onChange={(event) =>
                setForm({ ...form, maxTurns: Number(event.target.value) })
              }
            />
          </div>
        </div>

        <label className="row" style={{ alignItems: "center", gap: 8 }}>
          <input
            type="checkbox"
            checked={form.unlimitedTurns}
            onChange={(event) =>
              setForm((current) => ({
                ...current,
                unlimitedTurns: event.target.checked,
                maxTurns: event.target.checked ? 0 : Math.max(1, current.maxTurns || 10)
              }))
            }
          />
          <span>无限轮次（直到达成共识或手动终止）</span>
        </label>

        <label className="row" style={{ alignItems: "center", gap: 8 }}>
          <input
            type="checkbox"
            checked={form.enableSharedFacts}
            onChange={(event) => setForm({ ...form, enableSharedFacts: event.target.checked })}
          />
          <span>开启全场共享事实板（会注入后续上下文）</span>
        </label>

        {strategyId && strategyDetail ? (
            <div className="stack">
              <div className="panel stack">
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <div>
                    <strong>阶段注入提示词</strong>
                    <div className="muted">创建后，系统进入对应阶段时会自动注入这些提示词。</div>
                  </div>
                  <Link className="btn" href={`/strategies/${strategyDetail.id}`}>
                    去策略页编辑
                  </Link>
                </div>
                {workflowPhasePromptsLoading ? (
                  <div className="muted">加载中...</div>
                ) : (
                  <div className="grid" style={{ gap: 12 }}>
                    {workflowIdeaBank ? (
                      <div className="softBox stack">
                        <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
                          <strong>点子库路由</strong>
                          <span className="muted">idea bank</span>
                        </div>
                        <div className="muted">
                          如果 workflow 配置了点子库路由，系统会按阶段规则注入原始点子库或派生结果文件；未配置时不会启用这套机制。
                        </div>
                        <div className="muted">原始点子库：{workflowIdeaBank.rawIdeaBankPath ?? "（未配置）"}</div>
                        <div className="muted">
                          派生结果文件：
                          {[
                            workflowIdeaBank.derivedFiles.selectedSTierPath,
                            workflowIdeaBank.derivedFiles.selectedATierPath,
                            workflowIdeaBank.derivedFiles.rejectedOrMergedPath,
                            workflowIdeaBank.derivedFiles.eventMappingsPath,
                            workflowIdeaBank.derivedFiles.newlyInventedIdeasPath
                          ]
                            .filter((item): item is string => Boolean(item))
                            .join(" / ") || "（未配置）"}
                        </div>
                      </div>
                    ) : null}
                    <div className="softBox stack">
                      <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
                        <strong>开局注入提示词</strong>
                        <span className="muted">opening</span>
                      </div>
                      <div
                        className="strategyPrompt"
                        style={{
                          whiteSpace: "pre-wrap",
                          minHeight: workflowOpeningPrompt ? undefined : 0,
                          color: workflowOpeningPrompt ? undefined : "var(--muted)"
                        }}
                      >
                        {workflowOpeningPrompt || "当前策略还没有配置开局自动注入提示词。"}
                      </div>
                    </div>
                    {workflowSummarizer?.enabled ? (
                      <div className="softBox stack">
                        <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
                          <strong>独立总结器</strong>
                          <span className="muted">summary worker</span>
                        </div>
                        <div className="muted">
                          这套策略启用了独立总结器。它不会参与正式席位发言，只会在每回/每轮之间生成摘要并整理事实板。
                        </div>
                        <div className="muted">
                          已启用：
                          {[
                            workflowSummarizer.perTurn ? "每回摘要" : "",
                            workflowSummarizer.perRound ? "每轮摘要" : "",
                            workflowSummarizer.factsBoard ? "事实板更新" : ""
                          ]
                            .filter(Boolean)
                            .join(" / ") || "（无）"}
                        </div>
                        <div className="grid" style={{ gap: 10 }}>
                          <div className="softBox stack">
                            <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
                              <strong>回摘要 Prompt</strong>
                              <button
                                className="btn"
                                type="button"
                                onClick={() =>
                                  setPromptPreviewDialog({
                                    title: "回摘要 Prompt",
                                    description: "每回发言结束后，独立总结器用这段规则生成 turn summary。",
                                    value: workflowSummarizer.prompts.turnSummary
                                  })
                                }
                              >
                                点击查看
                              </button>
                            </div>
                            <div className="muted">{summarizePrompt(workflowSummarizer.prompts.turnSummary)}</div>
                          </div>
                          <div className="softBox stack">
                            <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
                              <strong>轮摘要 Prompt</strong>
                              <button
                                className="btn"
                                type="button"
                                onClick={() =>
                                  setPromptPreviewDialog({
                                    title: "轮摘要 Prompt",
                                    description: "每轮结束后，独立总结器只基于这一轮的回摘要生成 round summary。",
                                    value: workflowSummarizer.prompts.roundSummary
                                  })
                                }
                              >
                                点击查看
                              </button>
                            </div>
                            <div className="muted">{summarizePrompt(workflowSummarizer.prompts.roundSummary)}</div>
                          </div>
                          <div className="softBox stack">
                            <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
                              <strong>事实板 Prompt</strong>
                              <button
                                className="btn"
                                type="button"
                                onClick={() =>
                                  setPromptPreviewDialog({
                                    title: "事实板 Prompt",
                                    description: "独立总结器会用这段规则重写结构化 facts board，而不是做逐 Turn 追加。",
                                    value: workflowSummarizer.prompts.factsBoard
                                  })
                                }
                              >
                                点击查看
                              </button>
                            </div>
                            <div className="muted">{summarizePrompt(workflowSummarizer.prompts.factsBoard)}</div>
                          </div>
                        </div>
                      </div>
                    ) : null}
                    {workflowPhasePrompts.length <= 0 ? (
                      <div className="muted">当前策略没有配置阶段注入提示词。</div>
                    ) : null}
                    {workflowPhasePrompts.map((phase) => (
                      <div key={phase.id} className="softBox stack">
                        <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
                          <strong>{phase.title}</strong>
                          <span className="muted">
                            {phase.kind}
                            {phase.minRounds ? ` · minRounds=${phase.minRounds}` : ""}
                          </span>
                        </div>
                        {phase.description ? <div className="muted">{phase.description}</div> : null}
                        <div
                          className="strategyPrompt"
                          style={{
                            whiteSpace: "pre-wrap",
                            minHeight: phase.injectedPrompt ? undefined : 0,
                            color: phase.injectedPrompt ? undefined : "var(--muted)"
                          }}
                        >
                          {phase.injectedPrompt || "当前阶段还没有配置自动注入提示词。"}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <label style={{ fontWeight: 600 }}>
                  策略角色映射（已选 {enabledRows.length}）
                </label>
                <div className="row" style={{ gap: 8, alignItems: "center" }}>
                  <button className="btn" type="button" onClick={applyFairStrategyBinding}>
                    均匀分配 AI
                  </button>
                  <span className="muted">
                    至少选择 2 个角色；同一个 AI 配置可以重复绑定（会作为多个席位发言）
                    {hasDuplicateStrategyAgentIds ? " · 当前存在重复绑定" : ""}
                  </span>
                </div>
              </div>
            {workflowSummarizer?.enabled ? (
              <div className="panel stack">
                <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
                  <div>
                    <strong>总结器 AI 绑定</strong>
                    <div className="muted">这台 AI 只负责回摘要、轮摘要和事实板整理，不参与正式发言和投票。</div>
                  </div>
                  <button className="btn" type="button" onClick={assignRandomSummaryAgent}>
                    随机 AI
                  </button>
                </div>
                <select value={summaryAgentId} onChange={(event) => setSummaryAgentId(event.target.value)} style={{ flex: 1 }}>
                  <option value="">选择一台总结器 AI</option>
                  {agents.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.name} · {agent.provider} · {agent.model}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
            {bindingRows.map((row) => {
              const role = rolesById.get(row.roleId);
              if (!role) return null;

              return (
                <div key={row.rowId} className="panel stack">
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <label className="row">
                      <input
                        type="checkbox"
                        checked={row.enabled}
                        onChange={(event) =>
                          setBindingRows((current) =>
                            current.map((item) =>
                              item.rowId === row.rowId ? { ...item, enabled: event.target.checked } : item
                            )
                          )
                        }
                      />
                      <strong>{role.name}</strong>
                    </label>
                    <div className="row" style={{ gap: 8 }}>
                      <button
                        className="btn"
                        type="button"
                        onClick={() =>
                          setBindingRows((current) => {
                            const index = current.findIndex((x) => x.rowId === row.rowId);
                            const copy: BindingRow = {
                              rowId: newRowId(),
                              roleId: row.roleId,
                              enabled: true,
                              agentId: row.agentId
                            };
                            if (index < 0) return [...current, copy];
                            return [...current.slice(0, index + 1), copy, ...current.slice(index + 1)];
                          })
                        }
                      >
                        复制
                      </button>
                      <button
                        className="btn btn-muted"
                        type="button"
                        onClick={() =>
                          setBindingRows((current) => current.filter((item) => item.rowId !== row.rowId))
                        }
                      >
                        删除
                      </button>
                      <span className="muted">#{role.roleOrder}</span>
                    </div>
                  </div>

                  <div className="row">
                    <select
                      value={row.agentId}
                      disabled={!row.enabled}
                      onChange={(event) =>
                        setBindingRows((current) =>
                          current.map((item) =>
                            item.rowId === row.rowId ? { ...item, agentId: event.target.value } : item
                          )
                        )
                      }
                      style={{ flex: 1 }}
                    >
                      <option value="">选择一个 AI 配置</option>
                      {agents.map((agent) => (
                        <option key={agent.id} value={agent.id}>
                          {agent.name} · {agent.provider} · {agent.model}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              );
            })}
            {agents.length === 0 ? (
              <div className="muted">
                还没有 AI 配置。先去 <Link href="/agents">AI 配置</Link> 创建。
              </div>
            ) : null}
          </div>
        ) : (
          <div className="stack">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <label style={{ fontWeight: 600 }}>参与 AI（已选 {selectedAgentIds.length}）</label>
              <span className="muted">至少选择 2 个</span>
            </div>
            {agents.map((agent) => (
              <label key={agent.id} className="row">
                <input
                  checked={selectedAgentIds.includes(agent.id)}
                  type="checkbox"
                  onChange={() => toggleAgent(agent.id)}
                />
                <span>
                  <strong>{agent.name}</strong> · {agent.provider} · {agent.model}
                </span>
              </label>
            ))}
            {agents.length === 0 ? (
              <div className="muted">
                还没有 AI 配置。先去 <Link href="/agents">AI 配置</Link> 创建。
              </div>
            ) : null}
          </div>
        )}

        <div className="row">
          <button className="btn btn-primary" disabled={!canSubmit} onClick={() => void createDebate()}>
            {isSubmitting ? "创建中..." : "创建辩论"}
          </button>
        </div>
      </section>
    </div>
  );
}
