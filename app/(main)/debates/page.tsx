"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type Debate = {
  id: string;
  question: string;
  status: string;
  currentTurn: number;
  maxTurns: number;
  tokenUsed: number;
  consensusReached: boolean;
  isShared: boolean;
  runtimeNoticeKind: "recovering" | "recovered" | null;
  runtimeNoticeMessage: string | null;
  runtimeNoticeAt: string | null;
  agentCount: number;
  createdAt: string;
};

function formatTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function RecoveryBadge(props: {
  runtimeNoticeKind: "recovering" | "recovered" | null;
  runtimeNoticeMessage: string | null;
  runtimeNoticeAt: string | null;
}) {
  if (!props.runtimeNoticeKind || !props.runtimeNoticeMessage) return null;
  const badgeClass = props.runtimeNoticeKind === "recovering" ? "badge-recovering" : "badge-recovered";
  const label = props.runtimeNoticeKind === "recovering" ? "恢复中" : "已自动恢复";
  const title = props.runtimeNoticeAt
    ? `${props.runtimeNoticeMessage} · ${formatTime(props.runtimeNoticeAt)}`
    : props.runtimeNoticeMessage;
  return (
    <span className={`badge ${badgeClass}`} title={title}>
      {label}
    </span>
  );
}

export default function DebatesPage() {
  const [debates, setDebates] = useState<Debate[]>([]);
  const [deletingId, setDeletingId] = useState<string>("");
  const [scope, setScope] = useState<"mine" | "shared">("mine");
  const [loadError, setLoadError] = useState<string>("");
  const [selectedFinishedIds, setSelectedFinishedIds] = useState<string[]>([]);
  const [bulkDeleting, setBulkDeleting] = useState(false);

  async function load(nextScope: "mine" | "shared" = scope) {
    setLoadError("");
    try {
      const debatesResponse = await fetch(`/api/debates?scope=${nextScope}`);
      const debatesPayload = await debatesResponse.json().catch(() => ({}));

      if (!debatesResponse.ok) {
        setDebates([]);
        if (debatesResponse.status === 401) {
          setLoadError("请先登录");
        } else {
          setLoadError(debatesPayload.error?.message ?? "加载失败");
        }
        return;
      }

      const nextDebates = Array.isArray(debatesPayload.data) ? debatesPayload.data : [];
      setDebates(nextDebates);
    } catch (error) {
      console.error(error);
      setDebates([]);
      setLoadError("加载失败");
    }
  }

  async function removeDebate(id: string) {
    const target = debates.find((d) => d.id === id);
    if (!target) return;
    if (["pending", "running", "paused"].includes(String(target.status))) {
      window.alert("进行中的辩论必须先终止才能删除");
      return;
    }
    if (!window.confirm("确定删除这场辩论吗？（会删除该辩论所有记录）")) return;

    setDeletingId(id);
    try {
      const response = await fetch(`/api/debates/${id}`, { method: "DELETE" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        window.alert(payload.error?.message ?? "删除失败");
        return;
      }
      await load();
    } finally {
      setDeletingId("");
    }
  }

  function toggleFinishedSelected(id: string) {
    setSelectedFinishedIds((current) => (current.includes(id) ? current.filter((x) => x !== id) : [...current, id]));
  }

  async function deleteSelectedFinished() {
    if (scope !== "mine") return;
    if (bulkDeleting) return;
    const targets = finished.filter((d) => selectedFinishedIds.includes(d.id));
    if (targets.length === 0) return;
    if (!window.confirm(`确定批量删除已结束辩论 ${targets.length} 场吗？（会删除所有记录）`)) return;
    setBulkDeleting(true);
    try {
      for (const item of targets) {
        // eslint-disable-next-line no-await-in-loop
        const response = await fetch(`/api/debates/${item.id}`, { method: "DELETE" });
        // eslint-disable-next-line no-await-in-loop
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          window.alert(payload.error?.message ?? "删除失败");
          break;
        }
      }
      setSelectedFinishedIds([]);
      await load("mine");
    } finally {
      setBulkDeleting(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);

  const running = debates.filter((debate) =>
    ["pending", "running", "paused"].includes(debate.status)
  );
  const finished = debates.filter((debate) =>
    ["completed", "stopped", "failed"].includes(debate.status)
  );

  return (
    <div className="grid" style={{ gap: 20 }}>
      <section className="panel">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div>
            <h2 style={{ margin: 0 }}>辩论</h2>
            <div className="muted">进行中 {running.length} · 已结束 {finished.length}</div>
            {loadError ? <div style={{ color: "var(--red)" }}>{loadError}</div> : null}
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button
              className={`btn ${scope === "shared" ? "btn-active" : ""}`}
              onClick={() => setScope("shared")}
            >
              公开辩论
            </button>
            <button
              className={`btn ${scope === "mine" ? "btn-active" : ""}`}
              onClick={() => setScope("mine")}
            >
              我的辩论
            </button>
            <Link className="btn btn-primary" href="/debates/new">
              新增辩论
            </Link>
          </div>
        </div>
      </section>

      <section className="panel stack">
        <h3 style={{ margin: 0 }}>进行中</h3>
        <div className="card-list">
          {running.map((debate) => (
            <div className="panel stack" key={debate.id}>
              {(() => {
                const count = Math.max(1, Number(debate.agentCount ?? 0) || 1);
                const completedRounds = Math.floor((Number(debate.currentTurn ?? 0) || 0) / count);
                const maxRoundsText = debate.maxTurns <= 0 ? "∞" : debate.maxTurns;
                return (
                  <>
                    <div className="row" style={{ justifyContent: "space-between" }}>
                      <Link href={`/debates/${debate.id}`} style={{ flex: 1, minWidth: 0 }}>
                        <strong
                          style={{
                            whiteSpace: "pre-wrap",
                            overflow: "hidden",
                            display: "-webkit-box",
                            WebkitBoxOrient: "vertical",
                            WebkitLineClamp: 2
                          }}
                        >
                          {debate.question}
                        </strong>
                      </Link>
                      <div className="row" style={{ gap: 8 }}>
                        <span className={`badge badge-${debate.status}`}>{debate.status}</span>
                        <RecoveryBadge
                          runtimeNoticeKind={debate.runtimeNoticeKind}
                          runtimeNoticeMessage={debate.runtimeNoticeMessage}
                          runtimeNoticeAt={debate.runtimeNoticeAt}
                        />
                        {scope === "mine" ? (
                          <>
                            <button
                              className={`btn ${debate.isShared ? "btn-active" : ""}`}
                              disabled={deletingId === debate.id}
                              onClick={async () => {
                                const response = await fetch(`/api/debates/${debate.id}`, {
                                  method: "PATCH",
                                  headers: { "Content-Type": "application/json" },
                                  body: JSON.stringify({ isShared: !debate.isShared })
                                });
                                const payload = await response.json().catch(() => ({}));
                                if (!response.ok) {
                                  window.alert(payload.error?.message ?? "更新失败");
                                  return;
                                }
                                await load("mine");
                              }}
                            >
                              {debate.isShared ? "已公开" : "公开"}
                            </button>
                            <button
                              className="btn btn-danger"
                              disabled={deletingId === debate.id}
                              onClick={() => void removeDebate(debate.id)}
                            >
                              {deletingId === debate.id ? "删除中..." : "删除"}
                            </button>
                          </>
                        ) : null}
                      </div>
                    </div>
                    <div className="muted">
                      轮次 {completedRounds}/{maxRoundsText} · 参与者 {count} · token {debate.tokenUsed}
                      {debate.consensusReached ? " · 已达成共识" : ""} · 创建于{" "}
                      {formatTime(debate.createdAt)}
                    </div>
                    {debate.runtimeNoticeMessage ? (
                      <div className="muted" title={debate.runtimeNoticeMessage}>
                        {debate.runtimeNoticeMessage}
                        {debate.runtimeNoticeAt ? ` · ${formatTime(debate.runtimeNoticeAt)}` : ""}
                      </div>
                    ) : null}
                  </>
                );
              })()}
            </div>
          ))}
          {running.length === 0 ? <div className="muted">暂无进行中的辩论</div> : null}
        </div>
      </section>

      <section className="panel stack">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h3 style={{ margin: 0 }}>已结束</h3>
          {scope === "mine" ? (
            <div className="row" style={{ gap: 8 }}>
              <button className="btn" disabled={finished.length === 0} onClick={() => setSelectedFinishedIds(finished.map((d) => d.id))}>
                全选
              </button>
              <button className="btn" disabled={selectedFinishedIds.length === 0} onClick={() => setSelectedFinishedIds([])}>
                清空
              </button>
              <button className="btn btn-danger" disabled={selectedFinishedIds.length === 0 || bulkDeleting} onClick={() => void deleteSelectedFinished()}>
                {bulkDeleting ? "删除中..." : `删除所选 (${selectedFinishedIds.length})`}
              </button>
            </div>
          ) : null}
        </div>
        <div className="card-list">
          {finished.map((debate) => (
            <div className="panel stack" key={debate.id}>
              {(() => {
                const count = Math.max(1, Number(debate.agentCount ?? 0) || 1);
                const completedRounds = Math.floor((Number(debate.currentTurn ?? 0) || 0) / count);
                const maxRoundsText = debate.maxTurns <= 0 ? "∞" : debate.maxTurns;
                return (
                  <>
                    <div className="row" style={{ justifyContent: "space-between" }}>
                      {scope === "mine" ? (
                        <label className="row" style={{ gap: 10 }}>
                          <input
                            type="checkbox"
                            checked={selectedFinishedIds.includes(debate.id)}
                            onChange={() => toggleFinishedSelected(debate.id)}
                          />
                        </label>
                      ) : null}
                      <Link href={`/debates/${debate.id}`} style={{ flex: 1, minWidth: 0 }}>
                        <strong
                          style={{
                            whiteSpace: "pre-wrap",
                            overflow: "hidden",
                            display: "-webkit-box",
                            WebkitBoxOrient: "vertical",
                            WebkitLineClamp: 2
                          }}
                        >
                          {debate.question}
                        </strong>
                      </Link>
                      <div className="row" style={{ gap: 8 }}>
                        <span className={`badge badge-${debate.status}`}>{debate.status}</span>
                        <RecoveryBadge
                          runtimeNoticeKind={debate.runtimeNoticeKind}
                          runtimeNoticeMessage={debate.runtimeNoticeMessage}
                          runtimeNoticeAt={debate.runtimeNoticeAt}
                        />
                        {scope === "mine" ? (
                          <>
                            <button
                              className={`btn ${debate.isShared ? "btn-active" : ""}`}
                              disabled={deletingId === debate.id}
                              onClick={async () => {
                                const response = await fetch(`/api/debates/${debate.id}`, {
                                  method: "PATCH",
                                  headers: { "Content-Type": "application/json" },
                                  body: JSON.stringify({ isShared: !debate.isShared })
                                });
                                const payload = await response.json().catch(() => ({}));
                                if (!response.ok) {
                                  window.alert(payload.error?.message ?? "更新失败");
                                  return;
                                }
                                await load("mine");
                              }}
                            >
                              {debate.isShared ? "已公开" : "公开"}
                            </button>
                            <button
                              className="btn btn-danger"
                              disabled={deletingId === debate.id}
                              onClick={() => void removeDebate(debate.id)}
                            >
                              {deletingId === debate.id ? "删除中..." : "删除"}
                            </button>
                          </>
                        ) : null}
                      </div>
                    </div>
                    <div className="muted">
                      轮次 {completedRounds}/{maxRoundsText} · 参与者 {count} · token {debate.tokenUsed}
                      {debate.consensusReached ? " · 已达成共识" : ""} · 创建于{" "}
                      {formatTime(debate.createdAt)}
                    </div>
                    {debate.runtimeNoticeMessage ? (
                      <div className="muted" title={debate.runtimeNoticeMessage}>
                        {debate.runtimeNoticeMessage}
                        {debate.runtimeNoticeAt ? ` · ${formatTime(debate.runtimeNoticeAt)}` : ""}
                      </div>
                    ) : null}
                  </>
                );
              })()}
            </div>
          ))}
          {finished.length === 0 ? <div className="muted">暂无已结束的辩论</div> : null}
        </div>
      </section>
    </div>
  );
}
