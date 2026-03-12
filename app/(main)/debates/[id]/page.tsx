"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

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
  const [message, setMessage] = useState("");

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

  async function action(name: "start" | "pause" | "resume" | "stop") {
    if (!id) {
      return;
    }
    setMessage("");
    const response = await fetch(`/api/debates/${id}/${name}`, { method: "POST" });
    const payload = await response.json();
    if (!response.ok) {
      setMessage(payload.error?.message ?? "操作失败");
      return;
    }
    setMessage(`${name} 成功`);
  }

  if (!debate) {
    return <div className="panel">加载中...</div>;
  }

  return (
    <div className="grid grid-2">
      <section className="panel stack">
        <h2 style={{ margin: 0 }}>辩论状态</h2>
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
        {message ? <div className="muted">{message}</div> : null}
        <div className="stack">
          <h3 style={{ marginBottom: 0 }}>参与者</h3>
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

