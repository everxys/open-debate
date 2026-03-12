"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { useAutoDismissToast } from "@/components/ui/use-toast";

type Agent = {
  id: string;
  name: string;
  provider: string;
  model: string;
};

const initialForm = {
  question: "",
  maxTurns: 10,
  tokenBudget: 20000
};

export default function NewDebatePage() {
  const router = useRouter();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedAgentIds, setSelectedAgentIds] = useState<string[]>([]);
  const [form, setForm] = useState(initialForm);
  const { toast, showToast } = useAutoDismissToast(1200);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function loadAgents() {
    const response = await fetch("/api/agents");
    const payload = await response.json();
    if (!response.ok) {
      showToast("error", payload.error?.message ?? "加载 AI 配置失败");
      return;
    }
    setAgents(payload.data ?? []);
  }

  useEffect(() => {
    void loadAgents();
  }, []);

  function toggleAgent(id: string) {
    setSelectedAgentIds((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
    );
  }

  const canSubmit =
    form.question.trim().length >= 10 &&
    Number.isFinite(form.maxTurns) &&
    form.maxTurns >= 1 &&
    selectedAgentIds.length >= 2 &&
    selectedAgentIds.length <= 5 &&
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
          agentIds: selectedAgentIds
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
            <div className="muted">选择 2-5 个 AI，创建后可在详情页开始运行。</div>
          </div>
          <Link className="btn" href="/debates">
            返回
          </Link>
        </div>
      </section>

      <section className="panel stack">
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

        <div className="stack">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <label style={{ fontWeight: 600 }}>参与 AI（{selectedAgentIds.length}/5）</label>
            <span className="muted">至少选择 2 个</span>
          </div>
          {agents.map((agent) => (
            <label key={agent.id} className="row">
              <input
                checked={selectedAgentIds.includes(agent.id)}
                type="checkbox"
                onChange={() => toggleAgent(agent.id)}
                disabled={
                  !selectedAgentIds.includes(agent.id) && selectedAgentIds.length >= 5
                }
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

        <div className="row">
          <button className="btn btn-primary" disabled={!canSubmit} onClick={() => void createDebate()}>
            {isSubmitting ? "创建中..." : "创建辩论"}
          </button>
        </div>
      </section>
    </div>
  );
}
