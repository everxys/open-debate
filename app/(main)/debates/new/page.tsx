"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

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

type BindingRow = {
  rowId: string;
  roleId: string;
  enabled: boolean;
  agentId: string;
};

const initialForm = {
  question: "",
  maxTurns: 10,
  unlimitedTurns: false,
  enableSharedFacts: true
};

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
  const [bindingRows, setBindingRows] = useState<BindingRow[]>([]);

  function newRowId() {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
    return `row_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }

  async function loadAgents() {
    const response = await fetch("/api/agents");
    const payload = await response.json();
    if (!response.ok) {
      showToast("error", payload.error?.message ?? "加载 AI 配置失败");
      return;
    }
    setAgents(payload.data ?? []);
  }

  async function loadStrategies() {
    const response = await fetch("/api/strategies?scope=mine");
    const payload = await response.json();
    if (!response.ok) {
      return;
    }
    setStrategies(payload.data ?? []);
  }

  async function loadStrategyDetail(id: string) {
    if (!id) {
      setStrategyDetail(null);
      setBindingRows([]);
      return;
    }

    const response = await fetch(`/api/strategies/${id}`);
    const payload = await response.json();
    if (!response.ok) {
      showToast("error", payload.error?.message ?? "加载策略失败");
      setStrategyDetail(null);
      return;
    }

    const detail = payload.data as StrategyDetail;
    setStrategyDetail(detail);
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
  }

  useEffect(() => {
    void loadAgents();
    void loadStrategies();
  }, []);

  useEffect(() => {
    const id = searchParams.get("strategyId") ?? "";
    if (!id) return;
    setStrategyId(id);
    void loadStrategyDetail(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  function toggleAgent(id: string) {
    setSelectedAgentIds((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
    );
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
      (Number.isFinite(form.maxTurns) && form.maxTurns >= 1 && form.maxTurns <= 50)) &&
    (strategyId
      ? enabledRows.length >= 2 &&
        enabledBindings.length === enabledRows.length
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
                    }))
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
              placeholder="请输入辩论问题（至少 10 个字）"
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
          <textarea
            value={form.question}
            onChange={(event) => setForm({ ...form, question: event.target.value })}
            placeholder="请输入辩论问题（至少 10 个字）"
            maxLength={50_000}
            rows={7}
            style={{ height: 180, maxHeight: 180, overflowY: "auto", resize: "none" }}
          />
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
              max={50}
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
              <div className="row" style={{ justifyContent: "space-between" }}>
                <label style={{ fontWeight: 600 }}>
                  策略角色映射（已选 {enabledRows.length}）
                </label>
                <span className="muted">
                  至少选择 2 个角色；同一个 AI 配置可以重复绑定（会作为多个席位发言）
                  {hasDuplicateStrategyAgentIds ? " · 当前存在重复绑定" : ""}
                </span>
              </div>
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
                              agentId: ""
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
