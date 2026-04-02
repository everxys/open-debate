"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type WorkspaceListItem = {
  id: string;
  name: string;
  strategyName: string;
  debateCount: number;
  defaultMaxTurns: number;
  defaultEnableSharedFacts: boolean;
  updatedAt: string;
};

function formatTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

export default function WorkspacesPage() {
  const [items, setItems] = useState<WorkspaceListItem[]>([]);
  const [error, setError] = useState("");
  const [creatingWorkspaceId, setCreatingWorkspaceId] = useState("");

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch("/api/workspaces", { cache: "no-store" });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          setError(payload.error?.message ?? "加载工作台失败");
          return;
        }
        setItems(Array.isArray(payload.data) ? payload.data : []);
      } catch {
        setError("加载工作台失败");
      }
    })();
  }, []);

  async function createDebateFromWorkspace(workspaceId: string) {
    setCreatingWorkspaceId(workspaceId);
    try {
      const response = await fetch(`/api/workspaces/${workspaceId}/create-debate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({})
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(payload.error?.message ?? "从工作台创建辩论失败");
        return;
      }
      const debateId = typeof payload.data?.id === "string" ? payload.data.id : "";
      if (debateId) {
        window.location.href = `/debates/${debateId}`;
      }
    } catch {
      setError("从工作台创建辩论失败");
    } finally {
      setCreatingWorkspaceId("");
    }
  }

  return (
    <div className="grid" style={{ gap: 20 }}>
      <section className="panel">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div>
            <h2 style={{ margin: 0 }}>工作台</h2>
            <div className="muted">策略负责方法，工作台负责项目私有内容，再从工作台创建辩论。</div>
            {error ? <div style={{ color: "var(--red)" }}>{error}</div> : null}
          </div>
          <div className="row" style={{ gap: 8 }}>
            <Link className="btn" href="/strategies">
              选择策略
            </Link>
            <Link className="btn btn-primary" href="/workspaces/new">
              新建工作台
            </Link>
          </div>
        </div>
      </section>

      <section className="panel stack">
        <h3 style={{ margin: 0 }}>我的工作台</h3>
        <div className="card-list">
          {items.map((item) => (
            <div className="panel stack" key={item.id}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <Link href={`/workspaces/${item.id}`} style={{ flex: 1, minWidth: 0 }}>
                  <strong>{item.name}</strong>
                </Link>
                <div className="row" style={{ gap: 8 }}>
                  <button
                    className="btn btn-primary"
                    type="button"
                    disabled={creatingWorkspaceId === item.id}
                    onClick={() => void createDebateFromWorkspace(item.id)}
                  >
                    {creatingWorkspaceId === item.id ? "创建中..." : "创建辩论"}
                  </button>
                  <Link className="btn" href={`/workspaces/${item.id}`}>
                    打开
                  </Link>
                </div>
              </div>
              <div className="muted">
                策略：{item.strategyName} · 已创建辩论 {item.debateCount} 场 · 更新于 {formatTime(item.updatedAt)}
              </div>
            </div>
          ))}
          {items.length === 0 ? <div className="muted">还没有工作台。先从策略创建一个吧。</div> : null}
        </div>
      </section>
    </div>
  );
}
