"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

import { useAutoDismissToast } from "@/components/ui/use-toast";

type Agent = {
  id: string;
  name: string;
  provider: string;
  model: string;
};

type DebateAgent = {
  id: string;
  name: string;
  provider: string;
  turnOrder: number;
  turnCount: number;
};

type Debate = {
  id: string;
  question: string;
  status: string;
  currentTurn: number;
  maxTurns: number;
  tokenUsed: number;
  tokenBudget: number | null;
  consensusReached: boolean;
  consensusSummary: {
    leadingSolution: string;
    score: number;
  } | null;
  agents: DebateAgent[];
};

type Turn = {
  id: string;
  turnNumber: number;
  content: string;
  parseStatus: string;
  tokenUsed: number;
  createdAt: string;
  agent: {
    name: string;
    provider: string;
  };
  structuredOutput: {
    proposed_solution?: string;
    arguments?: Array<{ type: "support" | "rebuttal"; content: string }>;
    agreement_score?: number;
  } | null;
};

export default function DebateDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const [debate, setDebate] = useState<Debate | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [newAgentId, setNewAgentId] = useState<string>("");
  const [isAddingAgent, setIsAddingAgent] = useState(false);
  const { toast, showToast } = useAutoDismissToast(1200);

  useEffect(() => {
    if (!id) {
      return;
    }

    async function load() {
      const [debateResponse, turnsResponse] = await Promise.all([
        fetch(`/api/debates/${id}`),
        fetch(`/api/debates/${id}/turns`)
      ]);
      const debatePayload = await debateResponse.json();
      const turnsPayload = await turnsResponse.json();
      setDebate(debatePayload.data);
      setTurns(turnsPayload.data);
    }

    void load();
    const timer = setInterval(() => {
      void load();
    }, 1500);

    return () => {
      clearInterval(timer);
    };
  }, [id]);

  useEffect(() => {
    if (!id) return;
    async function loadAgents() {
      const response = await fetch("/api/agents");
      const payload = await response.json();
      if (response.ok) {
        setAgents(payload.data ?? []);
      }
    }
    void loadAgents();
  }, [id]);

  async function action(name: "start" | "pause" | "resume" | "stop") {
    if (!id) {
      return;
    }
    const response = await fetch(`/api/debates/${id}/${name}`, { method: "POST" });
    const payload = await response.json();
    if (!response.ok) {
      showToast("error", payload.error?.message ?? "操作失败");
      return;
    }
    showToast("success", "操作成功");
  }

  async function addAgent() {
    if (!id || !newAgentId || isAddingAgent) return;
    setIsAddingAgent(true);
    try {
      const response = await fetch(`/api/debates/${id}/agents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: newAgentId })
      });
      const payload = await response.json();
      if (!response.ok) {
        showToast("error", payload.error?.message ?? "加入失败");
        return;
      }
      setDebate(payload.data);
      setNewAgentId("");
      showToast("success", "已加入（排在最后）");
    } finally {
      setIsAddingAgent(false);
    }
  }

  if (!debate) {
    return <div className="panel">加载中...</div>;
  }

  const joinedAgentIds = new Set(debate.agents.map((item) => item.id));
  const availableAgents = agents.filter((agent) => !joinedAgentIds.has(agent.id));
  const canAddAgent =
    ["running", "paused"].includes(debate.status) &&
    availableAgents.length > 0;

  return (
    <div className="grid grid-2">
      {toast ? (
        <div
          className={`toast ${toast.type === "success" ? "toast-success" : "toast-error"}`}
          role="status"
          aria-live="polite"
        >
          {toast.text}
        </div>
      ) : null}

      <section className="panel stack">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2 style={{ margin: 0 }}>辩论状态</h2>
          <Link className="btn" href="/debates">
            返回列表
          </Link>
        </div>
        <div>
          <span className={`badge badge-${debate.status}`}>{debate.status}</span>
        </div>
        <strong>{debate.question}</strong>
        <div className="muted">
          轮次 {debate.currentTurn}/{debate.maxTurns}
        </div>
        <div className="muted">
          token {debate.tokenUsed}
          {debate.tokenBudget ? ` / ${debate.tokenBudget}` : ""}
        </div>
        <div className="muted">
          共识: {debate.consensusReached ? "已达成" : "未达成"}
          {debate.consensusSummary
            ? ` · ${debate.consensusSummary.leadingSolution} · ${debate.consensusSummary.score}`
            : ""}
        </div>
        <div className="row">
          <button className="btn btn-primary" onClick={() => void action("start")}>
            开始
          </button>
          <button className="btn" onClick={() => void action("pause")}>
            暂停
          </button>
          <button className="btn" onClick={() => void action("resume")}>
            恢复
          </button>
          <button className="btn btn-danger" onClick={() => void action("stop")}>
            停止
          </button>
        </div>
        <div className="stack">
          <h3 style={{ marginBottom: 0 }}>参与者</h3>
          {canAddAgent ? (
            <div className="panel">
              <div className="row" style={{ justifyContent: "space-between" }}>
                <strong>加入新的 AI（会排在最后）</strong>
                <span className="muted">当前 {debate.agents.length}</span>
              </div>
              <div className="row">
                <select
                  value={newAgentId}
                  onChange={(event) => setNewAgentId(event.target.value)}
                  style={{ flex: 1 }}
                >
                  <option value="">选择一个 AI 配置</option>
                  {availableAgents.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.name} · {agent.provider} · {agent.model}
                    </option>
                  ))}
                </select>
                <button className="btn btn-primary" disabled={!newAgentId || isAddingAgent} onClick={() => void addAgent()}>
                  加入
                </button>
              </div>
              <div className="muted">仅支持进行中/暂停中的辩论加入。</div>
            </div>
          ) : null}
          {debate.agents.map((agent) => (
            <div className="panel" key={agent.id}>
              #{agent.turnOrder} {agent.name} · {agent.provider} · 发言 {agent.turnCount}
            </div>
          ))}
        </div>
      </section>

      <section className="panel stack">
        <h2 style={{ margin: 0 }}>发言记录</h2>
        {turns.map((turn) => (
          <article className="turn stack" key={turn.id}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <strong>
                第 {turn.turnNumber} 轮 · {turn.agent.name}
              </strong>
              <span className="muted">
                {new Date(turn.createdAt).toLocaleTimeString()}
              </span>
            </div>
            <pre>{turn.content}</pre>
            {turn.structuredOutput?.proposed_solution ? (
              <div className="muted">
                方案：{turn.structuredOutput.proposed_solution}
                {typeof turn.structuredOutput.agreement_score === "number"
                  ? ` · 同意度 ${turn.structuredOutput.agreement_score}`
                  : ""}
              </div>
            ) : null}
            <div>
              {turn.structuredOutput?.arguments?.map((argument, index) => (
                <span
                  className={`pill ${
                    argument.type === "support" ? "pill-support" : "pill-rebuttal"
                  }`}
                  key={`${turn.id}-${index}`}
                >
                  {argument.type}: {argument.content}
                </span>
              ))}
            </div>
            {turn.parseStatus === "fallback" ? (
              <div className="muted">结构化解析失败，已保留原文</div>
            ) : null}
          </article>
        ))}
        {turns.length === 0 ? <div className="muted">还没有发言记录</div> : null}
      </section>
    </div>
  );
}
