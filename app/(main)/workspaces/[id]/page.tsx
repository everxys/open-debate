"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { WorkspaceFilesManager } from "@/components/workspaces/files-manager";
import { useAutoDismissToast } from "@/components/ui/use-toast";

type Agent = {
  id: string;
  name: string;
  categoryId: string | null;
  provider: string;
  model: string;
  isActive?: boolean;
};

type AgentCategory = {
  id: string;
  name: string;
  referencedAgentCount: number;
};

type AgentCategoryScope = "" | "uncategorized" | string;

type WorkspaceDetail = {
  id: string;
  strategyId: string;
  name: string;
  description: string | null;
  question: string;
  summaryAgentId: string | null;
  defaultMaxTurns: number;
  defaultEnableSharedFacts: boolean;
  strategy: { id: string; name: string; description: string | null } | null;
  bindings: Array<{
    id: string;
    sourceStrategyRoleId: string | null;
    roleName: string;
    roleOrder: number;
    agentId: string | null;
    displayName: string | null;
  }>;
  files: Array<{
    id: string;
    path: string;
    content: string;
  }>;
};

function assignAgentsEvenly(rows: WorkspaceDetail["bindings"], agentIds: string[]) {
  if (rows.length === 0 || agentIds.length === 0) return rows;
  return rows.map((row, index) => ({
    ...row,
    agentId: agentIds[index % agentIds.length] ?? null
  }));
}

function pickRandomAgentId(agentIds: string[]) {
  if (agentIds.length === 0) return "";
  return agentIds[Math.floor(Math.random() * agentIds.length)] ?? "";
}

function agentMatchesCategory(agent: Agent, categoryId: AgentCategoryScope) {
  if (!categoryId) return false;
  if (categoryId === "uncategorized") return !agent.categoryId;
  return agent.categoryId === categoryId;
}

function normalizeBindings(bindings: WorkspaceDetail["bindings"]) {
  return bindings
    .map((binding) => ({
      id: binding.id,
      sourceStrategyRoleId: binding.sourceStrategyRoleId ?? null,
      roleName: binding.roleName,
      roleOrder: binding.roleOrder,
      agentId: binding.agentId ?? null,
      displayName: binding.displayName ?? null
    }))
    .sort((a, b) => a.roleOrder - b.roleOrder || a.id.localeCompare(b.id));
}

export default function WorkspaceDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { toast, showToast } = useAutoDismissToast(1200);
  const [detail, setDetail] = useState<WorkspaceDetail | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentCategories, setAgentCategories] = useState<AgentCategory[]>([]);
  const [autoAssignCategoryId, setAutoAssignCategoryId] = useState<AgentCategoryScope>("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [question, setQuestion] = useState("");
  const [summaryAgentId, setSummaryAgentId] = useState("");
  const [bindings, setBindings] = useState<WorkspaceDetail["bindings"]>([]);
  const [maxTurns, setMaxTurns] = useState(10);
  const [enableSharedFacts, setEnableSharedFacts] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isCreatingDebate, setIsCreatingDebate] = useState(false);

  useEffect(() => {
    void (async () => {
      const [detailResponse, agentsResponse, categoriesResponse] = await Promise.all([
        fetch(`/api/workspaces/${params.id}`, { cache: "no-store" }),
        fetch("/api/agents", { cache: "no-store" }),
        fetch("/api/agents/categories", { cache: "no-store" })
      ]);
      const detailPayload = await detailResponse.json().catch(() => ({}));
      const agentsPayload = await agentsResponse.json().catch(() => ({}));
      const categoriesPayload = await categoriesResponse.json().catch(() => ({}));
      if (!detailResponse.ok) {
        showToast("error", detailPayload.error?.message ?? "加载工作台失败");
        return;
      }
      if (agentsResponse.ok) {
        setAgents(Array.isArray(agentsPayload.data) ? agentsPayload.data : []);
      }
      if (categoriesResponse.ok) {
        setAgentCategories(Array.isArray(categoriesPayload.data) ? categoriesPayload.data : []);
      } else {
        showToast("error", categoriesPayload.error?.message ?? "加载 AI 分类失败");
      }
      const next = detailPayload.data as WorkspaceDetail;
      setDetail(next);
      setName(next.name);
      setDescription(next.description ?? "");
      setQuestion(next.question ?? "");
      setSummaryAgentId(next.summaryAgentId ?? "");
      setMaxTurns(typeof next.defaultMaxTurns === "number" ? next.defaultMaxTurns : 10);
      setEnableSharedFacts(next.defaultEnableSharedFacts ?? true);
      setBindings(next.bindings ?? []);
    })();
  }, [params.id, showToast]);

  const enabledBindings = bindings.filter((binding) => binding.agentId && binding.sourceStrategyRoleId);
  const activeAgents = useMemo(() => agents.filter((agent) => agent.isActive !== false), [agents]);
  const activeAgentCountsByCategory = useMemo(() => {
    const counts = new Map<string, number>();
    for (const agent of activeAgents) {
      const key = agent.categoryId ?? "uncategorized";
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [activeAgents]);
  const assignableAgents = useMemo(
    () => activeAgents.filter((agent) => agentMatchesCategory(agent, autoAssignCategoryId)),
    [activeAgents, autoAssignCategoryId]
  );
  const assignableAgentIds = useMemo(() => assignableAgents.map((agent) => agent.id), [assignableAgents]);
  const autoAssignCategoryName = useMemo(() => {
    if (!autoAssignCategoryId) return "";
    if (autoAssignCategoryId === "uncategorized") return "未分类";
    return agentCategories.find((category) => category.id === autoAssignCategoryId)?.name ?? "所选分类";
  }, [agentCategories, autoAssignCategoryId]);

  useEffect(() => {
    if (!autoAssignCategoryId || autoAssignCategoryId === "uncategorized") return;
    if (!agentCategories.some((category) => category.id === autoAssignCategoryId)) {
      setAutoAssignCategoryId("");
    }
  }, [agentCategories, autoAssignCategoryId]);

  const isDirty = useMemo(() => {
    if (!detail) return false;
    return JSON.stringify({
      name: name.trim(),
      description: description.trim() || null,
      question,
      summaryAgentId: summaryAgentId || null,
      defaultMaxTurns: maxTurns,
      defaultEnableSharedFacts: enableSharedFacts,
      bindings: normalizeBindings(bindings)
    }) !==
      JSON.stringify({
        name: detail.name,
        description: detail.description ?? null,
        question: detail.question ?? "",
        summaryAgentId: detail.summaryAgentId ?? null,
        defaultMaxTurns: detail.defaultMaxTurns,
        defaultEnableSharedFacts: detail.defaultEnableSharedFacts,
        bindings: normalizeBindings(detail.bindings ?? [])
      });
  }, [bindings, detail, description, enableSharedFacts, maxTurns, name, question, summaryAgentId]);

  const canSave =
    name.trim().length > 0 &&
    question.trim().length <= 50_000 &&
    bindings.length >= 2 &&
    !isSaving;

  const canCreateDebate =
    question.trim().length >= 10 &&
    enabledBindings.length >= 2 &&
    !isCreatingDebate;

  const unlimitedRounds = maxTurns === 0;

  function getAssignableAgentIds() {
    if (!autoAssignCategoryId) {
      showToast("error", "请先选择 AI 分类");
      return null;
    }
    if (assignableAgentIds.length === 0) {
      showToast("error", `${autoAssignCategoryName}下没有已启用的 AI 配置`);
      return null;
    }
    return assignableAgentIds;
  }

  useEffect(() => {
    if (!isDirty) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    const handleDocumentClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest("a[href]") as HTMLAnchorElement | null;
      if (!anchor) return;
      const href = anchor.getAttribute("href");
      if (!href || href.startsWith("#")) return;
      const isModifiedClick = event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0;
      if (isModifiedClick) return;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname && url.search === window.location.search && url.hash === window.location.hash) return;
      if (!window.confirm("工作台有未保存的更新，确定离开吗？")) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    document.addEventListener("click", handleDocumentClick, true);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      document.removeEventListener("click", handleDocumentClick, true);
    };
  }, [isDirty]);

  async function saveWorkspace() {
    if (!detail || !canSave) return;
    setIsSaving(true);
    try {
      const response = await fetch(`/api/workspaces/${detail.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() || null,
          question,
          summaryAgentId: summaryAgentId || null,
          defaultMaxTurns: maxTurns,
          defaultEnableSharedFacts: enableSharedFacts,
          bindings: bindings.map((binding) => ({
            id: binding.id,
            sourceStrategyRoleId: binding.sourceStrategyRoleId,
            roleName: binding.roleName,
            roleOrder: binding.roleOrder,
            agentId: binding.agentId || null,
            displayName: binding.displayName || null
          }))
        })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        showToast("error", payload.error?.message ?? "保存工作台失败");
        return false;
      }
      const next = payload.data as WorkspaceDetail;
      setDetail(next);
      setName(next.name);
      setDescription(next.description ?? "");
      setQuestion(next.question ?? "");
      setSummaryAgentId(next.summaryAgentId ?? "");
      setMaxTurns(typeof next.defaultMaxTurns === "number" ? next.defaultMaxTurns : 10);
      setEnableSharedFacts(next.defaultEnableSharedFacts ?? true);
      setBindings(next.bindings ?? []);
      showToast("success", "工作台已保存");
      return true;
    } finally {
      setIsSaving(false);
    }
  }

  async function createDebate() {
    if (!detail || !canCreateDebate) return;
    if (isDirty && !window.confirm("工作台有未保存的更新，是否先保存并继续创建辩论？")) {
      return;
    }
    const saved = await saveWorkspace();
    if (!saved) return;
    setIsCreatingDebate(true);
    try {
      const response = await fetch(`/api/workspaces/${detail.id}/create-debate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          maxTurns,
          enableSharedFacts
        })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        showToast("error", payload.error?.message ?? "从工作台创建辩论失败");
        return;
      }
      router.push(`/debates/${payload.data?.id}`);
    } finally {
      setIsCreatingDebate(false);
    }
  }

  return (
    <div className="grid" style={{ gap: 20 }}>
      {toast ? (
        <div className={`toast ${toast.type === "success" ? "toast-success" : "toast-error"}`} role="status" aria-live="polite">
          {toast.text}
        </div>
      ) : null}
      <section className="panel">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div>
            <h2 style={{ margin: 0 }}>工作台</h2>
            <div className="muted">策略共享方法，工作台保存你的题目、idea 和私有素材，再从这里发起辩论。</div>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <Link
              className="btn"
              href="/workspaces"
              onClick={(event) => {
                if (isDirty && !window.confirm("工作台有未保存的更新，确定返回列表吗？")) {
                  event.preventDefault();
                }
              }}
            >
              返回列表
            </Link>
            <button className="btn btn-primary" disabled={!canSave} onClick={() => void saveWorkspace()}>
              {isSaving ? "保存中..." : "保存工作台"}
            </button>
          </div>
        </div>
      </section>

      <section className="panel stack">
        <div className="field">
          <label>工作台名称</label>
          <input value={name} onChange={(event) => setName(event.target.value.slice(0, 120))} />
        </div>
        <div className="field">
          <label>说明（可选）</label>
          <textarea value={description} onChange={(event) => setDescription(event.target.value.slice(0, 4000))} style={{ minHeight: 120 }} />
        </div>
        <div className="muted">
          当前策略：{detail?.strategy?.name ?? "加载中..."}
        </div>
      </section>

      <section className="panel stack">
        <div className="field">
          <label>项目题目</label>
          <textarea value={question} onChange={(event) => setQuestion(event.target.value.slice(0, 50_000))} style={{ minHeight: 180 }} />
          <div className="muted">这是私有项目题目，不会跟随策略一起分享。</div>
        </div>
      </section>

      <section className="panel stack">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <strong>私有文件树</strong>
          <span className="muted">右键新建文件/文件夹，策略不会分享这里的私有内容。</span>
        </div>
        {detail ? (
          <WorkspaceFilesManager
            workspaceId={detail.id}
            onChanged={async () => {
              const response = await fetch(`/api/workspaces/${detail.id}`, { cache: "no-store" });
              const payload = await response.json().catch(() => ({}));
              if (!response.ok) return;
              setDetail(payload.data as WorkspaceDetail);
            }}
          />
        ) : null}
      </section>

      <section className="panel stack">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <strong>默认 AI 绑定</strong>
          <div className="row" style={{ gap: 8, alignItems: "flex-end" }}>
            <div className="field" style={{ minWidth: 240 }}>
              <label>自动分配分类</label>
              <select value={autoAssignCategoryId} onChange={(event) => setAutoAssignCategoryId(event.target.value)}>
                <option value="">选择分类</option>
                {agentCategories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}（启用 {activeAgentCountsByCategory.get(category.id) ?? 0}）
                  </option>
                ))}
                <option value="uncategorized">未分类（启用 {activeAgentCountsByCategory.get("uncategorized") ?? 0}）</option>
              </select>
            </div>
            <button
              className="btn"
              type="button"
              onClick={() => {
                const agentIds = getAssignableAgentIds();
                if (!agentIds) return;
                const next = assignAgentsEvenly(bindings, agentIds);
                setBindings(next);
                showToast("success", "已均匀分配 AI");
              }}
            >
              均匀分配 AI
            </button>
            <button
              className="btn"
              type="button"
              onClick={() => {
                const agentIds = getAssignableAgentIds();
                if (!agentIds) return;
                setSummaryAgentId(pickRandomAgentId(agentIds));
              }}
            >
              总结器随机 AI
            </button>
          </div>
        </div>
        {bindings.map((binding, index) => (
          <div key={binding.id} className="softBox stack">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <strong>
                #{binding.roleOrder} {binding.roleName}
              </strong>
              <span className="muted">Seat-{index + 1}</span>
            </div>
            <input
              value={binding.displayName ?? ""}
              onChange={(event) =>
                setBindings((current) =>
                  current.map((item) =>
                    item.id === binding.id ? { ...item, displayName: event.target.value.slice(0, 80) } : item
                  )
                )
              }
              placeholder={`留空则自动命名为 AI-${index + 1}`}
            />
            <select
              value={binding.agentId ?? ""}
              onChange={(event) =>
                setBindings((current) =>
                  current.map((item) => (item.id === binding.id ? { ...item, agentId: event.target.value || null } : item))
                )
              }
            >
              <option value="">选择一台 AI</option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name} · {agent.provider} · {agent.model}
                  {agent.isActive === false ? " · 已禁用" : ""}
                </option>
              ))}
            </select>
          </div>
        ))}
        <div className="softBox stack">
          <strong>独立总结器</strong>
          <select value={summaryAgentId} onChange={(event) => setSummaryAgentId(event.target.value)}>
            <option value="">不绑定总结器 AI</option>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name} · {agent.provider} · {agent.model}
                {agent.isActive === false ? " · 已禁用" : ""}
              </option>
            ))}
          </select>
        </div>
      </section>

      <section className="panel stack">
        <strong>从工作台创建辩论</strong>
        <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
          <div className="field" style={{ flex: 1, minWidth: 220 }}>
            <label>最大轮数</label>
            <input
              type="number"
              min={0}
              value={unlimitedRounds ? 0 : maxTurns}
              disabled={unlimitedRounds}
              onChange={(event) => setMaxTurns(Number(event.target.value) || 0)}
            />
            <div className="muted">填 `0` 或勾选“无限轮数”都表示不设轮数上限。</div>
          </div>
        </div>
        <label className="row" style={{ alignItems: "center", gap: 8 }}>
          <input
            type="checkbox"
            checked={unlimitedRounds}
            onChange={(event) => setMaxTurns(event.target.checked ? 0 : 10)}
          />
          <span>无限轮数</span>
        </label>
        <label className="row" style={{ alignItems: "center", gap: 8 }}>
          <input type="checkbox" checked={enableSharedFacts} onChange={(event) => setEnableSharedFacts(event.target.checked)} />
          <span>开启共享事实板</span>
        </label>
        <div className="row" style={{ justifyContent: "center", gap: 12, flexWrap: "wrap" }}>
          <button className="btn" disabled={!canSave} onClick={() => void saveWorkspace()}>
            {isSaving ? "保存中..." : "保存工作台"}
          </button>
          <button className="btn btn-primary" disabled={!canCreateDebate} onClick={() => void createDebate()}>
            {isCreatingDebate ? "创建中..." : "从工作台创建辩论"}
          </button>
        </div>
      </section>
    </div>
  );
}
