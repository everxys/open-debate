"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { useAutoDismissToast } from "@/components/ui/use-toast";

type Agent = {
  id: string;
  name: string;
  provider: string;
  model: string;
};

const QUESTION_HISTORY_STORAGE_KEY = "open-debate:new-debate-question-history";
const QUESTION_HISTORY_LIMIT = 12;

const initialForm = {
  question: "",
  maxTurns: 10,
  unlimitedTurns: false,
  enableSharedFacts: true
};

function summarizeQuestionHistoryItem(value: string) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return "空白问题";
  return normalized.length > 80 ? `${normalized.slice(0, 80)}...` : normalized;
}

export default function NewDebatePage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { toast, showToast } = useAutoDismissToast(1200);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedAgentIds, setSelectedAgentIds] = useState<string[]>([]);
  const [form, setForm] = useState(initialForm);
  const [questionZoomOpen, setQuestionZoomOpen] = useState(false);
  const [questionHistory, setQuestionHistory] = useState<string[]>([]);
  const [questionHistoryOpen, setQuestionHistoryOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    const strategyId = searchParams.get("strategyId") ?? "";
    if (strategyId) {
      router.replace(`/workspaces/new?strategyId=${encodeURIComponent(strategyId)}`);
    }
  }, [router, searchParams]);

  const loadAgents = useCallback(async () => {
    const response = await fetch("/api/agents");
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      showToast("error", payload.error?.message ?? "加载 AI 配置失败");
      return;
    }
    setAgents(Array.isArray(payload.data) ? payload.data : []);
  }, [showToast]);

  useEffect(() => {
    void loadAgents();
  }, [loadAgents]);

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

  const canSubmit =
    form.question.trim().length >= 10 &&
    (form.unlimitedTurns || (Number.isFinite(form.maxTurns) && form.maxTurns >= 1 && form.maxTurns <= 200)) &&
    selectedAgentIds.length >= 2 &&
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
          agentIds: selectedAgentIds
        })
      });
      const payload = await response.json().catch(() => ({}));
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
        <div className={`toast ${toast.type === "success" ? "toast-success" : "toast-error"}`} role="status" aria-live="polite">
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
              placeholder="请输入辩论问题（至少 10 个字）。"
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
            <div className="muted">手动选择至少 2 个 AI 直接创建辩论；如需使用策略，请先创建工作台。</div>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <Link className="btn" href="/workspaces">
              工作台
            </Link>
            <Link className="btn" href="/debates">
              返回
            </Link>
          </div>
        </div>
      </section>

      <section className="panel stack">
        <div className="field">
          <label>辩论问题</label>
          <div style={{ position: "relative" }}>
            <textarea
              value={form.question}
              onChange={(event) => setForm({ ...form, question: event.target.value })}
              onFocus={() => setQuestionHistoryOpen(true)}
              onBlur={() => {
                window.setTimeout(() => setQuestionHistoryOpen(false), 120);
              }}
              placeholder="请输入辩论问题（至少 10 个字）"
              maxLength={50_000}
              style={{ height: 220, resize: "vertical" }}
            />
            <button
              className="btn"
              type="button"
              onClick={() => setQuestionZoomOpen(true)}
              style={{ position: "absolute", right: 12, top: 12 }}
            >
              放大编辑
            </button>
            {questionHistoryOpen && questionHistory.length > 0 ? (
              <div
                className="panel stack"
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  top: "calc(100% + 8px)",
                  zIndex: 20,
                  maxHeight: 280,
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
                    style={{ justifyContent: "flex-start", textAlign: "left", whiteSpace: "normal", lineHeight: 1.5 }}
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
            <span className="muted">{form.question.length.toLocaleString()}/50,000</span>
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
              onChange={(event) => setForm({ ...form, maxTurns: Number(event.target.value) })}
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

        <div className="stack">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <label style={{ fontWeight: 600 }}>参与 AI（已选 {selectedAgentIds.length}）</label>
            <span className="muted">至少选择 2 个</span>
          </div>
          {agents.map((agent) => (
            <label key={agent.id} className="row">
              <input checked={selectedAgentIds.includes(agent.id)} type="checkbox" onChange={() => toggleAgent(agent.id)} />
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
