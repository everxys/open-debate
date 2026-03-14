"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

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

const initialForm = {
  question: "",
  maxTurns: 10,
  tokenBudget: 20000,
  enableSharedFacts: true
};

export default function NewDebatePage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedAgentIds, setSelectedAgentIds] = useState<string[]>([]);
  const [form, setForm] = useState(initialForm);
  const { toast, showToast } = useAutoDismissToast(1200);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [strategies, setStrategies] = useState<StrategyListItem[]>([]);
  const [strategyId, setStrategyId] = useState<string>("");
  const [strategyDetail, setStrategyDetail] = useState<StrategyDetail | null>(null);
  const [roleBindings, setRoleBindings] = useState<
    Record<string, { enabled: boolean; agentId: string }>
  >({});

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
      setRoleBindings({});
      return;
    }

    const response = await fetch(`/api/strategies/${id}`);
    const payload = await response.json();
    if (!response.ok) {
      showToast("error", payload.error?.message ?? "加载策略失败");
      setStrategyDetail(null);
      setRoleBindings({});
      return;
    }

    const detail = payload.data as StrategyDetail;
    setStrategyDetail(detail);
    const bindings: Record<string, { enabled: boolean; agentId: string }> = {};
    for (const role of detail.roles ?? []) {
      bindings[role.id] = { enabled: true, agentId: "" };
    }
    setRoleBindings(bindings);
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

  const enabledRoleIds = Object.entries(roleBindings)
    .filter(([, value]) => value.enabled)
    .map(([roleId]) => roleId);

  const enabledBindings = enabledRoleIds
    .map((roleId) => ({ roleId, agentId: roleBindings[roleId]?.agentId ?? "" }))
    .filter((binding) => binding.agentId);

  const hasDuplicateStrategyAgentIds = (() => {
    const ids = enabledBindings.map((binding) => binding.agentId);
    return new Set(ids).size !== ids.length;
  })();

  const canSubmit =
    form.question.trim().length >= 10 &&
    Number.isFinite(form.maxTurns) &&
    form.maxTurns >= 1 &&
    (strategyId
      ? enabledRoleIds.length >= 2 &&
        enabledBindings.length === enabledRoleIds.length &&
        !hasDuplicateStrategyAgentIds
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
          maxTurns: form.maxTurns,
          tokenBudget: form.tokenBudget,
          enableSharedFacts: form.enableSharedFacts,
          ...(strategyId
            ? {
                strategy: {
                  strategyId,
                  bindings: enabledRoleIds.map((roleId) => ({
                    roleId,
                    agentId: roleBindings[roleId]?.agentId ?? ""
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
                setRoleBindings({});
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
          <label>问题</label>
          <textarea
            value={form.question}
            onChange={(event) => setForm({ ...form, question: event.target.value })}
            placeholder="请输入辩论问题（至少 10 个字）"
          />
        </div>
        <div className="row">
          <div className="field" style={{ flex: 1 }}>
            <label>最大轮数</label>
            <input
              type="number"
              value={form.maxTurns}
              onChange={(event) =>
                setForm({ ...form, maxTurns: Number(event.target.value) })
              }
            />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label>Token 预算（可选）</label>
            <input
              type="number"
              value={form.tokenBudget}
              onChange={(event) =>
                setForm({ ...form, tokenBudget: Number(event.target.value) })
              }
            />
          </div>
        </div>

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
                策略角色映射（已选 {enabledRoleIds.length}）
              </label>
              <span className="muted">至少选择 2 个角色；同一个 AI 配置不能重复绑定</span>
            </div>
            {strategyDetail.roles
              .slice()
              .sort((a, b) => a.roleOrder - b.roleOrder)
              .map((role) => {
                const binding = roleBindings[role.id] ?? { enabled: true, agentId: "" };
                const usedByOther = new Set(
                  Object.entries(roleBindings)
                    .filter(([rid, value]) => rid !== role.id && value.enabled && value.agentId)
                    .map(([, value]) => value.agentId)
                );

                return (
                  <div key={role.id} className="panel stack">
                    <div className="row" style={{ justifyContent: "space-between" }}>
                      <label className="row">
                        <input
                          type="checkbox"
                          checked={binding.enabled}
                          onChange={(event) =>
                            setRoleBindings((current) => ({
                              ...current,
                              [role.id]: { ...binding, enabled: event.target.checked }
                            }))
                          }
                        />
                        <strong>{role.name}</strong>
                      </label>
                      <span className="muted">#{role.roleOrder}</span>
                    </div>

                    <div className="row">
                      <select
                        value={binding.agentId}
                        disabled={!binding.enabled}
                        onChange={(event) =>
                          setRoleBindings((current) => ({
                            ...current,
                            [role.id]: { ...binding, agentId: event.target.value }
                          }))
                        }
                        style={{ flex: 1 }}
                      >
                        <option value="">选择一个 AI 配置</option>
                        {agents.map((agent) => (
                          <option
                            key={agent.id}
                            value={agent.id}
                            disabled={usedByOther.has(agent.id)}
                          >
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
