"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { createBrowserLogger } from "@/lib/logger/client";

type Debate = {
  id: string;
  question: string;
  status: string;
  currentTurn: number;
  maxTurns: number;
  tokenUsed: number;
  consensusReached: boolean;
  isShared: boolean;
  runtimeNoticeKind: "recovering" | "recovered" | "interrupted" | "quota_wait" | null;
  runtimeNoticeMessage: string | null;
  runtimeNoticeAt: string | null;
  isOwner?: boolean;
  agentCount: number;
  createdAt: string;
};

const debatesListLogger = createBrowserLogger("ui.debates.list");

function formatTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function RecoveryBadge(props: {
  runtimeNoticeKind: "recovering" | "recovered" | "interrupted" | "quota_wait" | null;
  runtimeNoticeMessage: string | null;
  runtimeNoticeAt: string | null;
}) {
  if (!props.runtimeNoticeKind || !props.runtimeNoticeMessage) return null;
  const badgeClass =
    props.runtimeNoticeKind === "recovering"
      ? "badge-recovering"
      : props.runtimeNoticeKind === "interrupted" || props.runtimeNoticeKind === "quota_wait"
        ? "badge-paused"
        : "badge-recovered";
  const label =
    props.runtimeNoticeKind === "recovering"
      ? "恢复中"
      : props.runtimeNoticeKind === "interrupted" || props.runtimeNoticeKind === "quota_wait"
        ? "已自动暂停"
        : "已自动恢复";
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
  const [stoppingId, setStoppingId] = useState<string>("");
  const [repairingId, setRepairingId] = useState<string>("");
  const [scope, setScope] = useState<"mine" | "shared">("mine");
  const [loadError, setLoadError] = useState<string>("");
  const [selectedFinishedIds, setSelectedFinishedIds] = useState<string[]>([]);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [clearMenuOpen, setClearMenuOpen] = useState(false);
  const [clearBelowRounds, setClearBelowRounds] = useState("1");
  const [purgingStopped, setPurgingStopped] = useState(false);

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
      debatesListLogger.error("failed to load debates list", {
        scope: nextScope,
        error
      });
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

  async function stopDebate(id: string) {
    const target = debates.find((d) => d.id === id);
    if (!target || !target.isOwner) return;
    if (!["pending", "running", "paused"].includes(String(target.status))) return;
    if (!window.confirm("确定终止这场辩论吗？")) return;

    setStoppingId(id);
    try {
      const response = await fetch(`/api/debates/${id}/stop`, { method: "POST" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        window.alert(payload.error?.message ?? "终止失败");
        return;
      }
      await load(scope);
    } finally {
      setStoppingId("");
    }
  }

  async function repairDebate(id: string) {
    const target = debates.find((d) => d.id === id);
    if (!target || !target.isOwner) return;
    if (String(target.status) !== "failed") return;
    if (!window.confirm("确定将这场 failed 辩论修复为 paused 吗？修复后你可以手动继续运行。")) return;

    setRepairingId(id);
    try {
      const response = await fetch(`/api/debates/${id}/repair`, { method: "POST" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        window.alert(payload.error?.message ?? "修复失败");
        return;
      }
      await load(scope);
    } finally {
      setRepairingId("");
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

  async function purgeStoppedDebates(maxCompletedRounds: number) {
    if (scope !== "mine") return;
    if (purgingStopped) return;

    setPurgingStopped(true);
    try {
      const response = await fetch("/api/debates/purge-stopped", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxCompletedRounds })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        window.alert(payload.error?.message ?? "清理失败");
        return;
      }
      setSelectedFinishedIds([]);
      setClearMenuOpen(false);
      await load("mine");
    } finally {
      setPurgingStopped(false);
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
  const stoppableFinished = debates.filter((debate) => ["stopped", "failed"].includes(debate.status));
  const clearThreshold = Math.max(0, Number.parseInt(clearBelowRounds || "0", 10) || 0);
  const stoppableFinishedBelowThreshold = stoppableFinished.filter((debate) => {
    const count = Math.max(1, Number(debate.agentCount ?? 0) || 1);
    const completedRounds = Math.floor((Number(debate.currentTurn ?? 0) || 0) / count);
    return completedRounds < clearThreshold;
  });

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
                        {debate.isOwner ? (
                          <>
                            <button
                              className={`btn ${debate.isShared ? "btn-active" : ""}`}
                              disabled={deletingId === debate.id || stoppingId === debate.id || repairingId === debate.id}
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
                              disabled={deletingId === debate.id || stoppingId === debate.id || repairingId === debate.id}
                              onClick={() => void stopDebate(debate.id)}
                            >
                              {stoppingId === debate.id ? "终止中..." : "终止"}
                            </button>
                            <button
                              className="btn btn-danger"
                              disabled={deletingId === debate.id || stoppingId === debate.id || repairingId === debate.id}
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
            <div className="row" style={{ gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
              <button
                className="btn"
                disabled={stoppableFinished.length === 0 || purgingStopped}
                onClick={() => setClearMenuOpen((current) => !current)}
              >
                {purgingStopped ? "清空中..." : "清空..."}
              </button>
              <button className="btn" disabled={finished.length === 0} onClick={() => setSelectedFinishedIds(finished.map((d) => d.id))}>
                全选
              </button>
              <button className="btn" disabled={selectedFinishedIds.length === 0} onClick={() => setSelectedFinishedIds([])}>
                清空选择
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
                        {debate.isOwner ? (
                          <>
                            <button
                              className={`btn ${debate.isShared ? "btn-active" : ""}`}
                              disabled={deletingId === debate.id || stoppingId === debate.id || repairingId === debate.id}
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
                            {debate.status === "failed" ? (
                              <button
                                className="btn"
                                disabled={deletingId === debate.id || stoppingId === debate.id || repairingId === debate.id}
                                onClick={() => void repairDebate(debate.id)}
                              >
                                {repairingId === debate.id ? "修复中..." : "修复为暂停中"}
                              </button>
                            ) : null}
                            <button
                              className="btn btn-danger"
                              disabled={deletingId === debate.id || stoppingId === debate.id || repairingId === debate.id}
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
      {scope === "mine" && clearMenuOpen ? (
        <div
          onClick={() => {
            if (!purgingStopped) setClearMenuOpen(false);
          }}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0, 0, 0, 0.45)",
            display: "grid",
            placeItems: "center",
            zIndex: 80,
            padding: 16
          }}
        >
          <div
            className="panel"
            onClick={(event) => event.stopPropagation()}
            style={{ width: "min(520px, 100%)", display: "grid", gap: 12 }}
          >
            <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
              <strong>清空已停止/失败辩论</strong>
              <button className="btn" disabled={purgingStopped} onClick={() => setClearMenuOpen(false)}>
                关闭
              </button>
            </div>
            <div className="muted">只处理 `status = stopped` 或 `failed` 的辩论，不影响 `completed`。</div>
            <div className="row" style={{ gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              <span>清空已完成轮数小于</span>
              <input
                type="number"
                min={0}
                step={1}
                value={clearBelowRounds}
                onChange={(event) => setClearBelowRounds(event.target.value)}
                style={{ width: 96 }}
              />
              <span>轮的已停止/失败辩论</span>
            </div>
            <div className="muted">
              当前将删除 {stoppableFinishedBelowThreshold.length} 场符合条件的已停止/失败辩论。
            </div>
            <div className="row" style={{ gap: 10, justifyContent: "flex-end", flexWrap: "wrap" }}>
              <button className="btn" disabled={purgingStopped} onClick={() => setClearMenuOpen(false)}>
                取消
              </button>
              <button
                className="btn btn-danger"
                disabled={purgingStopped || stoppableFinishedBelowThreshold.length === 0}
                onClick={() => {
                  if (
                    !window.confirm(
                      `确定清空已完成轮数小于 ${clearThreshold} 轮的已停止/失败辩论 ${stoppableFinishedBelowThreshold.length} 场吗？`
                    )
                  ) {
                    return;
                  }
                  void purgeStoppedDebates(clearThreshold);
                }}
              >
                {purgingStopped
                  ? "清空中..."
                  : `确认清空${stoppableFinishedBelowThreshold.length > 0 ? ` (${stoppableFinishedBelowThreshold.length})` : ""}`}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
