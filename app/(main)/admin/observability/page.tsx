import Link from "next/link";

import { JobDashboard } from "./job-dashboard";
import { requireAdmin } from "@/lib/auth";
import { query } from "@/lib/db";

type Snapshot = {
  usersTotal: number;
  adminsTotal: number;
  debatesTotal: number;
  debatesToday: number;
  debatesRunning: number;
  debatesPaused: number;
  debatesPending: number;
  debatesFailed: number;
  tokensTotal: number;
  tokensToday: number;
  recentFailures: Array<{
    id: string;
    updatedAt: string;
    code: string | null;
    message: string | null;
    question: string;
  }>;
};

function toInt(value: unknown) {
  const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function clampText(value: string, max = 140) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max)}…`;
}

async function getSnapshot(): Promise<Snapshot> {
  const summary = await query<{
    users_total: string;
    admins_total: string;
    debates_total: string;
    debates_today: string;
    debates_running: string;
    debates_paused: string;
    debates_pending: string;
    debates_failed: string;
    tokens_total: string;
    tokens_today: string;
  }>(`
    select
      (select count(*) from users) as users_total,
      (select count(*) from users where role = 'admin') as admins_total,
      (select count(*) from debates) as debates_total,
      (select count(*) from debates where created_at >= date_trunc('day', now())) as debates_today,
      (select count(*) from debates where status = 'running') as debates_running,
      (select count(*) from debates where status = 'paused') as debates_paused,
      (select count(*) from debates where status = 'pending') as debates_pending,
      (select count(*) from debates where status = 'failed') as debates_failed,
      (select coalesce(sum(token_used), 0) from debates) as tokens_total,
      (select coalesce(sum(token_used), 0) from debates where created_at >= date_trunc('day', now())) as tokens_today
  `);

  const recentFailures = await query<{
    id: string;
    updated_at: string;
    last_error_code: string | null;
    last_error_message: string | null;
    question: string;
  }>(
    `
      select id, updated_at, last_error_code, last_error_message, question
      from debates
      where status = 'failed'
      order by updated_at desc
      limit 20
    `
  );

  const row = summary.rows[0];
  return {
    usersTotal: toInt(row?.users_total),
    adminsTotal: toInt(row?.admins_total),
    debatesTotal: toInt(row?.debates_total),
    debatesToday: toInt(row?.debates_today),
    debatesRunning: toInt(row?.debates_running),
    debatesPaused: toInt(row?.debates_paused),
    debatesPending: toInt(row?.debates_pending),
    debatesFailed: toInt(row?.debates_failed),
    tokensTotal: toInt(row?.tokens_total),
    tokensToday: toInt(row?.tokens_today),
    recentFailures: recentFailures.rows.map((r) => ({
      id: r.id,
      updatedAt: r.updated_at,
      code: r.last_error_code,
      message: r.last_error_message,
      question: r.question
    }))
  };
}

export default async function ObservabilityPage() {
  await requireAdmin();
  const snapshot = await getSnapshot();

  return (
    <section className="grid" style={{ gap: 16 }}>
      <div className="panel">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div>
            <h2 style={{ margin: 0 }}>监控面板</h2>
            <div className="hint">
              快捷健康检查：<Link className="authLink" href="/api/health">/api/health</Link>
            </div>
          </div>
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
        <div className="panel">
          <div className="muted">用户</div>
          <div style={{ fontSize: 26, fontWeight: 800, marginTop: 6 }}>{snapshot.usersTotal}</div>
          <div className="hint">管理员：{snapshot.adminsTotal}</div>
        </div>
        <div className="panel">
          <div className="muted">辩论总数</div>
          <div style={{ fontSize: 26, fontWeight: 800, marginTop: 6 }}>{snapshot.debatesTotal}</div>
          <div className="hint">今日新增：{snapshot.debatesToday}</div>
        </div>
        <div className="panel">
          <div className="muted">运行中 / 暂停 / 待开始</div>
          <div style={{ fontSize: 26, fontWeight: 800, marginTop: 6 }}>
            {snapshot.debatesRunning} / {snapshot.debatesPaused} / {snapshot.debatesPending}
          </div>
          <div className="hint">失败：{snapshot.debatesFailed}</div>
        </div>
        <div className="panel">
          <div className="muted">Token 消耗</div>
          <div style={{ fontSize: 26, fontWeight: 800, marginTop: 6 }}>{snapshot.tokensTotal}</div>
          <div className="hint">今日：{snapshot.tokensToday}</div>
        </div>
      </div>

      <JobDashboard />

      <div className="panel">
        <h3 style={{ marginTop: 0 }}>最近失败的辩论</h3>
        {snapshot.recentFailures.length === 0 ? (
          <div className="hint">暂无失败记录</div>
        ) : (
          <div className="card-list">
            {snapshot.recentFailures.map((item) => (
              <div key={item.id} className="turn">
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <div style={{ fontWeight: 800 }}>
                    <Link className="authLink" href={`/debates/${item.id}`}>
                      {item.id}
                    </Link>
                  </div>
                  <div className="hint">{new Date(item.updatedAt).toLocaleString()}</div>
                </div>
                <div className="hint" style={{ marginTop: 6 }}>
                  {item.code ? `错误码：${item.code}` : "错误码：-"}{" "}
                  {item.message ? `｜${clampText(item.message, 180)}` : ""}
                </div>
                <div style={{ marginTop: 8 }}>{clampText(item.question, 220)}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
