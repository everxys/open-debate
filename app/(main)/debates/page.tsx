"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type Agent = {
  id: string;
  name: string;
  provider: string;
  model: string;
};

type Debate = {
  id: string;
  question: string;
  status: string;
  currentTurn: number;
  maxTurns: number;
  tokenUsed: number;
  consensusReached: boolean;
  createdAt: string;
};

const initialForm = {
  question: "",
  maxTurns: 10,
  tokenBudget: 20000
};

export default function DebatesPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [debates, setDebates] = useState<Debate[]>([]);
  const [selectedAgentIds, setSelectedAgentIds] = useState<string[]>([]);
  const [form, setForm] = useState(initialForm);
  const [message, setMessage] = useState("");

  async function load() {
    const [agentsResponse, debatesResponse] = await Promise.all([
      fetch("/api/agents"),
      fetch("/api/debates")
    ]);
    const agentsPayload = await agentsResponse.json();
    const debatesPayload = await debatesResponse.json();
    setAgents(agentsPayload.data);
    setDebates(debatesPayload.data);
  }

  useEffect(() => {
    void load();
  }, []);

  function toggleAgent(id: string) {
    setSelectedAgentIds((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
    );
  }

  async function createDebate() {
    setMessage("");
    const response = await fetch("/api/debates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...form,
        agentIds: selectedAgentIds
      })
    });
    const payload = await response.json();
    if (!response.ok) {
      setMessage(payload.error?.message ?? "创建失败");
      return;
    }

    setForm(initialForm);
    setSelectedAgentIds([]);
    setMessage("创建成功");
    await load();
  }

  return (
    <div className="grid grid-2">
      <section className="panel stack">
        <h2 style={{ margin: 0 }}>创建辩论</h2>
        <div className="field">
          <label>问题</label>
          <textarea
            value={form.question}
            onChange={(event) => setForm({ ...form, question: event.target.value })}
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
            <label>Token 预算</label>
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
          <label>参与 AI（2-5 个）</label>
          {agents.map((agent) => (
            <label key={agent.id} className="row">
              <input
                checked={selectedAgentIds.includes(agent.id)}
                type="checkbox"
                onChange={() => toggleAgent(agent.id)}
              />
              <span>
                {agent.name} · {agent.provider} · {agent.model}
              </span>
            </label>
          ))}
        </div>
        <div className="row">
          <button className="btn btn-primary" onClick={() => void createDebate()}>
            创建
          </button>
          {message ? <span className="muted">{message}</span> : null}
        </div>
      </section>

      <section className="panel stack">
        <h2 style={{ margin: 0 }}>辩论列表</h2>
        <div className="card-list">
          {debates.map((debate) => (
            <Link className="panel stack" href={`/debates/${debate.id}`} key={debate.id}>
              <strong>{debate.question}</strong>
              <div className="muted">
                {debate.status} · {debate.currentTurn}/{debate.maxTurns} · token{" "}
                {debate.tokenUsed}
              </div>
            </Link>
          ))}
          {debates.length === 0 ? <div className="muted">暂无辩论</div> : null}
        </div>
      </section>
    </div>
  );
}

