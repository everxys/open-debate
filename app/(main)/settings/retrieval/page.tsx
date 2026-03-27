"use client";

import { useEffect, useMemo, useState } from "react";

type RetrievalConfigView = {
  id: string;
  name: string;
  provider: "openai";
  model: string;
  dimensions: number | null;
  baseUrl: string;
  apiKeyMasked: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
} | null;

type MessageState = { type: "error" | "success"; text: string } | null;

export default function RetrievalSettingsPage() {
  const [config, setConfig] = useState<RetrievalConfigView>(null);
  const [name, setName] = useState("Default Retrieval");
  const [provider, setProvider] = useState<"openai">("openai");
  const [model, setModel] = useState("");
  const [dimensions, setDimensions] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState<MessageState>(null);

  const canSubmit = useMemo(() => {
    if (!name.trim() || !model.trim() || !baseUrl.trim()) return false;
    if (!config && !apiKey.trim()) return false;
    return true;
  }, [apiKey, baseUrl, config, model, name]);

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    setLoading(true);
    setMessage(null);
    try {
      const response = await fetch("/api/retrieval-config", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) {
        setMessage({ type: "error", text: payload.error?.message ?? "加载失败" });
        return;
      }
      const data = (payload.data ?? null) as RetrievalConfigView;
      setConfig(data);
      if (!data) return;
      setName(data.name);
      setProvider(data.provider);
      setModel(data.model);
      setDimensions(data.dimensions ? String(data.dimensions) : "");
      setBaseUrl(data.baseUrl);
    } finally {
      setLoading(false);
    }
  }

  async function save() {
    if (!canSubmit) return;
    setSaving(true);
    setMessage(null);
    try {
      const response = await fetch("/api/retrieval-config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          provider,
          model,
          dimensions: dimensions.trim() ? Number(dimensions) : null,
          baseUrl,
          ...(apiKey.trim() ? { apiKey } : {})
        })
      });
      const payload = await response.json();
      if (!response.ok) {
        setMessage({ type: "error", text: payload.error?.message ?? "保存失败" });
        return;
      }
      setApiKey("");
      setConfig(payload.data as RetrievalConfigView);
      setMessage({ type: "success", text: "检索配置已保存" });
      await load();
    } finally {
      setSaving(false);
    }
  }

  async function testConnection() {
    if (!name.trim() || !model.trim() || !baseUrl.trim() || (!config && !apiKey.trim())) return;
    setTesting(true);
    setMessage(null);
    try {
      const response = await fetch("/api/retrieval-config/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          provider,
          model,
          dimensions: dimensions.trim() ? Number(dimensions) : null,
          baseUrl,
          ...(apiKey.trim() ? { apiKey } : {})
        })
      });
      const payload = await response.json();
      if (!response.ok) {
        setMessage({ type: "error", text: payload.error?.message ?? "测试失败" });
        return;
      }
      setMessage({
        type: "success",
        text: `连接成功${payload.data?.dimensions ? `，向量维度 ${payload.data.dimensions}` : ""}`
      });
    } finally {
      setTesting(false);
    }
  }

  return (
    <section className="panel">
      <h2 style={{ marginTop: 0 }}>检索配置</h2>
      <p className="muted" style={{ marginTop: -6 }}>
        用于长辩论历史检索的独立 embedding 配置，不复用辩论模型。
      </p>

      <div className="stack" style={{ marginTop: 14, maxWidth: 680 }}>
        {loading ? <div className="muted">加载中...</div> : null}

        <div className="field">
          <label>名称</label>
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Default Retrieval" />
        </div>

        <div className="field">
          <label>Provider</label>
          <select value={provider} onChange={(event) => setProvider(event.target.value as "openai")}>
            <option value="openai">openai-compatible</option>
          </select>
        </div>

        <div className="field">
          <label>Embedding Model</label>
          <input value={model} onChange={(event) => setModel(event.target.value)} placeholder="text-embedding-3-large" />
        </div>

        <div className="field">
          <label>Dimensions（可选）</label>
          <input value={dimensions} onChange={(event) => setDimensions(event.target.value)} placeholder="3072" />
        </div>

        <div className="field">
          <label>Base URL</label>
          <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.openai.com/v1" />
        </div>

        <div className="field">
          <label>API Key{config?.apiKeyMasked ? `（当前：${config.apiKeyMasked}）` : ""}</label>
          <input
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={config ? "留空表示不变" : "输入检索 API Key"}
          />
        </div>

        <div className="row">
          <button className="btn" disabled={testing || (!apiKey.trim() && !config)} onClick={() => void testConnection()}>
            {testing ? "测试中..." : "测试连接"}
          </button>
          <button className="btn btn-primary" disabled={saving || !canSubmit} onClick={() => void save()}>
            {saving ? "保存中..." : "保存配置"}
          </button>
        </div>

        {message ? (
          <div className={`alert ${message.type === "error" ? "alert-error" : "alert-success"}`}>{message.text}</div>
        ) : null}
      </div>
    </section>
  );
}
