"use client";

import { useEffect, useState } from "react";

type Agent = {
  id: string;
  name: string;
  provider: string;
  model: string;
  baseUrl: string;
  systemPrompt: string | null;
  apiKeyMasked: string;
  isActive: boolean;
};

const initialForm = {
  name: "",
  provider: "openai",
  model: "gpt-4.1-mini",
  baseUrl: "https://api.openai.com/v1",
  systemPrompt: "",
  apiKey: ""
};

export default function AgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [form, setForm] = useState(initialForm);
  const [message, setMessage] = useState("");

  async function loadAgents() {
    const response = await fetch("/api/agents");
    const payload = await response.json();
    setAgents(payload.data);
  }

  useEffect(() => {
    void loadAgents();
  }, []);

  const canSubmit =
    form.model.trim().length > 0 &&
    form.baseUrl.trim().length > 0 &&
    form.apiKey.trim().length > 0;

  async function createAgent() {
    setMessage("");
    const response = await fetch("/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form)
    });
    const payload = await response.json();

    if (!response.ok) {
      setMessage(payload.error?.message ?? "创建失败");
      return;
    }

    setForm(initialForm);
    setMessage("创建成功");
    await loadAgents();
  }

  async function testDraftConfig() {
    setMessage("");
    const response = await fetch("/api/agents/test-config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form)
    });
    const payload = await response.json();
    setMessage(payload.data?.message ?? payload.error?.message ?? "测试完成");
  }

  async function testAgent(id: string) {
    const response = await fetch(`/api/agents/${id}/test`, { method: "POST" });
    const payload = await response.json();
    setMessage(payload.data?.message ?? payload.error?.message ?? "测试完成");
  }

  async function deleteAgent(id: string) {
    await fetch(`/api/agents/${id}`, { method: "DELETE" });
    await loadAgents();
  }

  return (
    <div className="grid grid-2">
      <section className="panel stack">
        <h2 style={{ margin: 0 }}>新建 AI 配置</h2>
        <div className="field">
          <label>名称</label>
          <input
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
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
            value={form.model}
            onChange={(event) => setForm({ ...form, model: event.target.value })}
          />
        </div>
        <div className="field">
          <label>Base URL</label>
          <input
            value={form.baseUrl}
            onChange={(event) => setForm({ ...form, baseUrl: event.target.value })}
          />
        </div>
        <div className="field">
          <label>System Prompt</label>
          <textarea
            value={form.systemPrompt}
            onChange={(event) =>
              setForm({ ...form, systemPrompt: event.target.value })
            }
          />
        </div>
        <div className="field">
          <label>API Key</label>
          <input
            value={form.apiKey}
            onChange={(event) => setForm({ ...form, apiKey: event.target.value })}
          />
        </div>
        <div className="row">
          <button className="btn" disabled={!canSubmit} onClick={() => void testDraftConfig()}>
            测试当前配置
          </button>
          <button
            className="btn btn-primary"
            disabled={!canSubmit}
            onClick={() => void createAgent()}
          >
            保存
          </button>
          {message ? <span className="muted">{message}</span> : null}
        </div>
      </section>

      <section className="panel stack">
        <h2 style={{ margin: 0 }}>已有配置</h2>
        <div className="card-list">
          {agents.map((agent) => (
            <div className="panel stack" key={agent.id}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <strong>{agent.name}</strong>
                <span className="muted">{agent.provider}</span>
              </div>
              <div className="muted">{agent.model}</div>
              <div className="muted">{agent.baseUrl}</div>
              <div className="muted">Key: {agent.apiKeyMasked}</div>
              <div className="row">
                <button className="btn" onClick={() => void testAgent(agent.id)}>
                  测试连接
                </button>
                <button className="btn btn-danger" onClick={() => void deleteAgent(agent.id)}>
                  删除
                </button>
              </div>
            </div>
          ))}
          {agents.length === 0 ? <div className="muted">暂无 AI 配置</div> : null}
        </div>
      </section>
    </div>
  );
}

