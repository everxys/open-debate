"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useAutoDismissToast } from "@/components/ui/use-toast";

type StrategyListItem = {
  id: string;
  name: string;
  description: string | null;
  isShared: boolean;
  forkedFromStrategyId?: string | null;
  roleCount: number;
  isFavorited?: boolean;
  favoriteCount?: number;
  forkCount?: number;
  updatedAt: string;
  createdAt: string;
};

function formatTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

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
    error: { message: text || `${response.status} ${response.statusText}`.trim() }
  };
}

export default function StrategiesPage() {
  const [scope, setScope] = useState<"mine" | "shared">("mine");
  const [mine, setMine] = useState<StrategyListItem[]>([]);
  const [shared, setShared] = useState<StrategyListItem[]>([]);
  const { toast, showToast } = useAutoDismissToast(1200);
  const [isBusyId, setIsBusyId] = useState<string | null>(null);

  const items = useMemo(() => (scope === "mine" ? mine : shared), [scope, mine, shared]);

  const load = useCallback(async (target: "mine" | "shared") => {
    let response: Response;
    try {
      response = await fetch(`/api/strategies?scope=${target}`);
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

    if (target === "mine") setMine(payload.data ?? []);
    else setShared(payload.data ?? []);
  }, [showToast]);

  useEffect(() => {
    void load("mine");
    void load("shared");
  }, [load]);

  async function toggleShare(id: string) {
    if (isBusyId) return;
    setIsBusyId(id);
    try {
      const detailRes = await fetch(`/api/strategies/${id}`);
      const detailPayload = await readPayload(detailRes);
      if (!detailRes.ok) {
        showToast("error", detailPayload.error?.message ?? "加载失败");
        return;
      }

      const current = detailPayload.data as {
        name: string;
        description: string | null;
        isShared: boolean;
        roles: Array<{ id: string; name: string; systemPrompt: string | null }>;
      };

      const updateRes = await fetch(`/api/strategies/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: current.name,
          description: current.description,
          isShared: !current.isShared,
          roles: current.roles.map((role) => ({
            id: role.id,
            name: role.name,
            systemPrompt: role.systemPrompt
          }))
        })
      });
      const updatePayload = await readPayload(updateRes);
      if (!updateRes.ok) {
        showToast("error", updatePayload.error?.message ?? "更新失败");
        return;
      }
      showToast("success", "已更新");
      await load("mine");
      await load("shared");
    } finally {
      setIsBusyId(null);
    }
  }

  async function deleteOne(id: string) {
    if (isBusyId) return;
    const ok = window.confirm("确认删除该策略？此操作不可恢复。");
    if (!ok) return;
    setIsBusyId(id);
    try {
      const response = await fetch(`/api/strategies/${id}`, { method: "DELETE" });
      const payload = await readPayload(response);
      if (!response.ok) {
        showToast("error", payload.error?.message ?? "删除失败");
        return;
      }
      showToast("success", "已删除");
      await load("mine");
      await load("shared");
    } finally {
      setIsBusyId(null);
    }
  }

  async function toggleFavorite(item: StrategyListItem) {
    if (isBusyId) return;
    setIsBusyId(item.id);
    try {
      const response = await fetch(`/api/strategies/${item.id}/favorite`, {
        method: item.isFavorited ? "DELETE" : "POST"
      });
      const payload = await readPayload(response);
      if (!response.ok) {
        showToast("error", payload.error?.message ?? "操作失败");
        return;
      }
      showToast("success", item.isFavorited ? "已取消收藏" : "已收藏");
      await load("shared");
    } finally {
      setIsBusyId(null);
    }
  }

  async function forkOne(item: StrategyListItem) {
    if (isBusyId) return;
    setIsBusyId(item.id);
    try {
      const response = await fetch(`/api/strategies/${item.id}/fork`, { method: "POST" });
      const payload = await readPayload(response);
      if (!response.ok) {
        showToast("error", payload.error?.message ?? "Fork 失败");
        return;
      }
      showToast("success", "已 Fork 到我的策略");
      await load("mine");
      await load("shared");
    } finally {
      setIsBusyId(null);
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
            <h2 style={{ margin: 0 }}>策略</h2>
            <div className="muted">保存提示词+文件，创建辩论时一键带入（不影响全局 AI 配置）。</div>
          </div>
          <div className="row">
            <button className={`btn ${scope === "mine" ? "btn-primary" : ""}`} onClick={() => setScope("mine")}>
              我的策略
            </button>
            <button className={`btn ${scope === "shared" ? "btn-primary" : ""}`} onClick={() => setScope("shared")}>
              社区分享
            </button>
            <Link className="btn btn-primary" href="/strategies/new">
              新建策略
            </Link>
          </div>
        </div>
      </section>

      <section className="panel stack">
        <div className="card-list">
          {items.map((item) => {
            const busy = isBusyId === item.id;
            return (
              <div className="panel stack" key={item.id}>
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <strong>{item.name}</strong>
                  <div className="row">
                    <span className="muted">角色 {item.roleCount}</span>
                    {item.isShared ? <span className="badge badge-running">shared</span> : <span className="badge">private</span>}
                    {scope === "shared" && typeof item.favoriteCount === "number" ? (
                      <span className="muted">收藏 {item.favoriteCount}</span>
                    ) : null}
                    {scope === "shared" && typeof item.forkCount === "number" ? (
                      <span className="muted">Fork {item.forkCount}</span>
                    ) : null}
                  </div>
                </div>
                {item.description ? <div className="muted">{item.description}</div> : null}
                <div className="muted">更新于 {formatTime(item.updatedAt)}</div>
                <div className="row">
                  <Link className="btn btn-primary" href={`/debates/new?strategyId=${item.id}`}>
                    使用策略
                  </Link>
                  <Link className="btn" href={`/strategies/${item.id}`}>
                    {scope === "mine" ? "查看/编辑" : "查看"}
                  </Link>
                  {scope === "shared" ? (
                    <>
                      <button className="btn" disabled={busy} onClick={() => void toggleFavorite(item)}>
                        {busy ? "处理中..." : item.isFavorited ? "取消收藏" : "收藏"}
                      </button>
                      <button className="btn" disabled={busy} onClick={() => void forkOne(item)}>
                        {busy ? "处理中..." : "Fork"}
                      </button>
                    </>
                  ) : null}
                  {scope === "mine" ? (
                    <>
                      <button className="btn" disabled={busy} onClick={() => void toggleShare(item.id)}>
                        {busy ? "处理中..." : item.isShared ? "取消分享" : "分享"}
                      </button>
                      <button className="btn btn-danger" disabled={busy} onClick={() => void deleteOne(item.id)}>
                        删除
                      </button>
                    </>
                  ) : null}
                </div>
              </div>
            );
          })}
          {items.length === 0 ? (
            <div className="muted">{scope === "mine" ? "还没有策略，先新建一个。" : "暂无社区分享策略。"}</div>
          ) : null}
        </div>
      </section>
    </div>
  );
}
