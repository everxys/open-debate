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
  createdAt: string;
};

function formatTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

export default function DebatesPage() {
  const [debates, setDebates] = useState<Debate[]>([]);

  async function load() {
    const debatesResponse = await fetch("/api/debates");
    const debatesPayload = await debatesResponse.json();
    setDebates(debatesPayload.data);
  }

  useEffect(() => {
    void load();
  }, []);

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
          </div>
          <Link className="btn btn-primary" href="/debates/new">
            新增辩论
          </Link>
        </div>
      </section>

      <section className="panel stack">
        <h3 style={{ margin: 0 }}>进行中</h3>
        <div className="card-list">
          {running.map((debate) => (
            <Link className="panel stack" href={`/debates/${debate.id}`} key={debate.id}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <strong>{debate.question}</strong>
                <span className={`badge badge-${debate.status}`}>{debate.status}</span>
              </div>
              <div className="muted">
                轮次 {debate.currentTurn}/{debate.maxTurns} · token {debate.tokenUsed}
                {debate.consensusReached ? " · 已达成共识" : ""} · 创建于{" "}
                {formatTime(debate.createdAt)}
              </div>
            </Link>
          ))}
          {running.length === 0 ? <div className="muted">暂无进行中的辩论</div> : null}
        </div>
      </section>

      <section className="panel stack">
        <h3 style={{ margin: 0 }}>已结束</h3>
        <div className="card-list">
          {finished.map((debate) => (
            <Link className="panel stack" href={`/debates/${debate.id}`} key={debate.id}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <strong>{debate.question}</strong>
                <span className={`badge badge-${debate.status}`}>{debate.status}</span>
              </div>
              <div className="muted">
                轮次 {debate.currentTurn}/{debate.maxTurns} · token {debate.tokenUsed}
                {debate.consensusReached ? " · 已达成共识" : ""} · 创建于{" "}
                {formatTime(debate.createdAt)}
              </div>
            </Link>
          ))}
          {finished.length === 0 ? <div className="muted">暂无已结束的辩论</div> : null}
        </div>
      </section>
    </div>
  );
}
