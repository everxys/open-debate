"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { useAutoDismissToast } from "@/components/ui/use-toast";

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
  const { toast, showToast } = useAutoDismissToast(1200);
  const [isTestingDraft, setIsTestingDraft] = useState(false);
  const [testingAgentId, setTestingAgentId] = useState<string | null>(null);

  async function readPayload(response: Response) {
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      try {
        return await response.json();
      } catch {
      }
    }

    let text = "";
    try {
      text = await response.text();
    } catch {
    }

    return {
      success: false,
      error: {
        message: text || `${response.status} ${response.statusText}`.trim()
      }
    };
  }

  async function loadAgents() {
    let response: Response;
    try {
      response = await fetch("/api/agents");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showToast("error", `Failed to fetch: ${message}`);
      return;
    }

    const payload = await readPayload(response);
    if (!response.ok) {
      showToast("error", payload.error?.message ?? "加载失败");
      return;
    }
    setAgents(payload.data ?? []);
  }

  useEffect(() => {
    void loadAgents();
  }, []);

  const canTest =
    form.model.trim().length > 0 &&
    form.baseUrl.trim().length > 0 &&
    form.apiKey.trim().length > 0;
  const canSave = canTest && form.name.trim().length > 0;

  async function createAgent() {
    let response: Response;
    try {
      response = await fetch("/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form)
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showToast("error", `Failed to fetch: ${message}`);
      return;
    }

    const payload = await readPayload(response);

    if (!response.ok) {
      showToast("error", payload.error?.message ?? "创建失败");
      return;
    }

    setForm(initialForm);
    showToast("success", "创建成功");
    await loadAgents();
  }

  async function testDraftConfig() {
    if (isTestingDraft) return;
    setIsTestingDraft(true);
    let response: Response;
    try {
      response = await fetch("/api/agents/test-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form)
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showToast("error", `Failed to fetch: ${message}`);
      setIsTestingDraft(false);
      return;
    }

    const payload = await readPayload(response);
    const text =
      payload.data?.message ??
      payload.error?.message ??
      `${response.status} ${response.statusText}`.trim();
    showToast(response.ok ? "success" : "error", text);
    setIsTestingDraft(false);
  }

  async function testAgent(id: string) {
    if (testingAgentId === id) return;
    setTestingAgentId(id);
    let response: Response;
    try {
      response = await fetch(`/api/agents/${id}/test`, { method: "POST" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showToast("error", `Failed to fetch: ${message}`);
      setTestingAgentId(null);
      return;
    }

    const payload = await readPayload(response);
    const text =
      payload.data?.message ??
      payload.error?.message ??
      `${response.status} ${response.statusText}`.trim();
    showToast(response.ok ? "success" : "error", text);
    setTestingAgentId(null);
  }

  async function deleteAgent(id: string) {
    try {
      await fetch(`/api/agents/${id}`, { method: "DELETE" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showToast("error", `Failed to fetch: ${message}`);
      return;
    }
    showToast("success", "已删除");
    await loadAgents();
  }

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
        <h2 style={{ margin: 0 }}>新建 AI 配置</h2>
        <div className="field">
          <label>名称</label>
          <input
            name="name"
            autoComplete="off"
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
            placeholder="例如：LongCat Flash Lite"
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
            name="model"
            autoComplete="off"
            value={form.model}
            onChange={(event) => setForm({ ...form, model: event.target.value })}
          />
        </div>
        <div className="field">
          <label>Base URL</label>
          <input
            name="baseUrl"
            autoComplete="off"
            value={form.baseUrl}
            onChange={(event) => setForm({ ...form, baseUrl: event.target.value })}
            placeholder="https://api.openai.com/v1"
          />
          <div className="hint">如果只填到域名根路径，服务端会尝试自动补全 /v1。</div>
        </div>
        <div className="field">
          <label>System Prompt</label>
          <textarea
            name="systemPrompt"
            value={form.systemPrompt}
            onChange={(event) =>
              setForm({ ...form, systemPrompt: event.target.value })
            }
          />
        </div>
        <div className="field">
          <label>API Key</label>
          <input
            type="password"
            name="apiKey"
            autoComplete="off"
            data-1p-ignore="true"
            data-bwignore="true"
            data-lpignore="true"
            value={form.apiKey}
            onChange={(event) => setForm({ ...form, apiKey: event.target.value })}
            placeholder="Bearer Token / API Key"
          />
          <div className="hint">不会在页面上明文展示，保存后只显示掩码。</div>
        </div>
        <div className="row">
          <button
            className="btn"
            disabled={!canTest || isTestingDraft}
            onClick={() => void testDraftConfig()}
          >
            {isTestingDraft ? "测试中..." : "测试当前配置"}
          </button>
          <button
            className="btn btn-primary"
            disabled={!canSave}
            onClick={() => void createAgent()}
          >
            保存
          </button>
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
                <button
                  className="btn"
                  disabled={testingAgentId === agent.id}
                  onClick={() => void testAgent(agent.id)}
                >
                  {testingAgentId === agent.id ? "测试中..." : "测试连接"}
                </button>
                <Link className="btn" href={`/agents/${agent.id}/files`}>
                  文件
                </Link>
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
