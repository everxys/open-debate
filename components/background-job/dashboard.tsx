"use client";

import Link from "next/link";
import type { ComponentProps } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/feedback";
import {
  formatBackgroundJobDurationMs,
  type BackgroundJobDashboardData,
  type BackgroundJobDashboardItem,
  type BackgroundJobQueueStat,
  type BackgroundJobSourceDefinition,
  type BackgroundJobStatusFilter
} from "@/lib/background-job";

type ApiEnvelope<T> =
  | { success: true; data: T }
  | { success: false; error?: { message?: string; code?: string } };

type SourceOption = {
  value: string;
  label: string;
};

type DashboardData = BackgroundJobDashboardData & {
  summaryQueue?: Array<Omit<BackgroundJobQueueStat, "source">>;
};

const STATUS_OPTIONS: Array<{ value: BackgroundJobStatusFilter; label: string }> = [
  { value: "all", label: "全部状态" },
  { value: "active", label: "活跃" },
  { value: "failed", label: "失败" },
  { value: "completed", label: "完成" }
];

function getPayloadMessage(payload: ApiEnvelope<unknown>, fallback: string) {
  return payload.success ? fallback : payload.error?.message ?? fallback;
}

function clampText(value: string | null, max = 120) {
  if (!value) return "";
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max)}...`;
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { hour12: false });
}

function getStatusLabel(job: BackgroundJobDashboardItem) {
  if (job.statusBucket === "active") {
    if (job.status === "running") return "运行中";
    if (job.status === "retry_wait") return "等待重试";
    if (job.status === "blocked") return "阻塞";
    return "待处理";
  }
  if (job.statusBucket === "failed") return job.status === "dead_letter" ? "死信" : "失败";
  return "完成";
}

function getStatusBadgeClass(job: BackgroundJobDashboardItem) {
  if (job.statusBucket === "failed") return "badge badge-failed";
  if (job.statusBucket === "completed") return "badge badge-completed";
  return job.status === "running" ? "badge badge-running" : "badge badge-pending";
}

function getStatCount(data: DashboardData | null, source: string, bucket: "active" | "failed" | "completed") {
  return data?.stats.find((item) => item.source === source && item.statusBucket === bucket)?.count ?? 0;
}

function resolveSources(data: DashboardData | null, fallback: SourceOption[]): BackgroundJobSourceDefinition[] {
  if (data?.sources.length) return data.sources;
  return fallback.map((item) => ({ source: item.value, label: item.label }));
}

function JobDashboardRow({
  job,
  busy,
  actionsDisabled,
  buildJobHref,
  onRerun
}: {
  job: BackgroundJobDashboardItem;
  busy: boolean;
  actionsDisabled: boolean;
  buildJobHref?: (job: BackgroundJobDashboardItem) => string | null;
  onRerun: (job: BackgroundJobDashboardItem) => void;
}) {
  const retryText = job.maxRetries === null ? `${job.retryCount}` : `${job.retryCount}/${job.maxRetries}`;
  const scheduleText = job.nextRetryAt ?? job.runAt;
  const href = buildJobHref?.(job) ?? (job.debateId ? `/debates/${job.debateId}` : null);
  const linkHref = href as ComponentProps<typeof Link>["href"] | null;

  return (
    <div className="jobDashboardRow">
      <div className="jobDashboardMain">
        <div className="jobDashboardTitle">
          <span className="jobDashboardKind">{job.kindLabel}</span>
          {linkHref && job.debateId ? (
            <Link className="authLink" href={linkHref}>
              {job.debateId}
            </Link>
          ) : null}
        </div>
        <div className="jobDashboardMeta">
          <span>{job.sourceLabel}</span>
          {job.jobKey ? <span>{job.jobKey}</span> : null}
          <span>更新 {formatDateTime(job.updatedAt)}</span>
          {job.lockedBy ? <span>锁定 {job.lockedBy}</span> : null}
        </div>
        {job.debateQuestion ? <div className="jobDashboardQuestion">{clampText(job.debateQuestion, 180)}</div> : null}
        {job.failureReason ? <div className="jobDashboardError">{clampText(job.failureReason, 240)}</div> : null}
      </div>
      <div className="jobDashboardCell">
        <span className={getStatusBadgeClass(job)}>{getStatusLabel(job)}</span>
        <span className="muted">{job.status}</span>
      </div>
      <div className="jobDashboardCell">
        <strong>{retryText}</strong>
        <span className="muted">重试</span>
      </div>
      <div className="jobDashboardCell">
        <strong>{formatBackgroundJobDurationMs(job.durationMs)}</strong>
        <span className="muted">耗时</span>
      </div>
      <div className="jobDashboardCell jobDashboardSchedule">
        <span>{formatDateTime(scheduleText)}</span>
        {job.completedAt ? <span className="muted">完成 {formatDateTime(job.completedAt)}</span> : null}
      </div>
      <div className="jobDashboardActions">
        <Button
          variant="muted"
          disabled={!job.canRerun || actionsDisabled}
          onClick={() => onRerun(job)}
          title={job.canRerun ? "手动重新排队执行" : "运行中的任务不能重跑"}
        >
          {busy ? "重跑中..." : "重跑"}
        </Button>
      </div>
    </div>
  );
}

export function BackgroundJobDashboard({
  endpoint,
  title = "后台任务中心",
  description = "统一查看后台任务、Worker 和后续批处理任务的运行状态",
  sourceOptions,
  buildJobHref
}: {
  endpoint: string;
  title?: string;
  description?: string;
  sourceOptions?: SourceOption[];
  buildJobHref?: (job: BackgroundJobDashboardItem) => string | null;
}) {
  const initialSourceOptions = useMemo(() => sourceOptions ?? [], [sourceOptions]);
  const [source, setSource] = useState("all");
  const [status, setStatus] = useState<BackgroundJobStatusFilter>("all");
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rerunningJobKey, setRerunningJobKey] = useState<string | null>(null);

  const requestUrl = useMemo(() => {
    const params = new URLSearchParams({ source, status, limit: "80" });
    return `${endpoint}?${params.toString()}`;
  }, [endpoint, source, status]);

  const loadJobs = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const response = await fetch(requestUrl, { signal, cache: "no-store" });
        const payload = (await response.json().catch(() => null)) as ApiEnvelope<DashboardData> | null;
        if (!response.ok || !payload?.success) {
          setError(payload ? getPayloadMessage(payload, "后台任务读取失败") : "后台任务读取失败");
          return;
        }
        setData(payload.data);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : "后台任务读取失败");
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [requestUrl]
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadJobs(controller.signal);
    return () => controller.abort();
  }, [loadJobs]);

  const rerunJob = useCallback(
    async (job: BackgroundJobDashboardItem) => {
      const jobKey = `${job.source}:${job.id}`;
      if (!job.canRerun || rerunningJobKey) return;
      setRerunningJobKey(jobKey);
      setError(null);
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "rerun", source: job.source, id: job.id })
        });
        const payload = (await response.json().catch(() => null)) as ApiEnvelope<unknown> | null;
        if (!response.ok || !payload?.success) {
          setError(payload ? getPayloadMessage(payload, "任务重跑失败") : "任务重跑失败");
          return;
        }
        await loadJobs();
      } catch (err) {
        setError(err instanceof Error ? err.message : "任务重跑失败");
      } finally {
        setRerunningJobKey(null);
      }
    },
    [endpoint, loadJobs, rerunningJobKey]
  );

  const sources = resolveSources(data, initialSourceOptions.filter((item) => item.value !== "all"));
  const allSourceOptions = [
    { value: "all", label: "全部来源" },
    ...sources.map((item) => ({ value: item.source, label: item.label }))
  ];
  const activeWorkers = data?.workers.filter((worker) => !worker.stale).length ?? 0;
  const staleWorkers = data?.workers.filter((worker) => worker.stale).length ?? 0;
  const queues = data?.queues.length ? data.queues : data?.summaryQueue ?? [];
  const queueTotal = queues.reduce((sum, item) => sum + item.count, 0);

  return (
    <div className="panel jobDashboard">
      <div className="jobDashboardHeader">
        <div>
          <h3>{title}</h3>
          <div className="hint">{description}</div>
        </div>
        <Button variant="muted" disabled={loading} onClick={() => void loadJobs()}>
          {loading ? "刷新中..." : "刷新"}
        </Button>
      </div>

      <div className="jobDashboardStats">
        <div>
          <span className="muted">Worker</span>
          <strong>{activeWorkers}</strong>
          <span className="hint">异常 {staleWorkers}</span>
        </div>
        <div>
          <span className="muted">队列</span>
          <strong>{queueTotal}</strong>
          <span className="hint">按任务种类聚合</span>
        </div>
        {sources.map((item) => (
          <div key={item.source}>
            <span className="muted">{item.label} 活跃 / 失败 / 完成</span>
            <strong>
              {getStatCount(data, item.source, "active")} / {getStatCount(data, item.source, "failed")} /{" "}
              {getStatCount(data, item.source, "completed")}
            </strong>
          </div>
        ))}
      </div>

      <div className="jobDashboardToolbar">
        <div className="segmentedControls" aria-label="任务来源筛选">
          {allSourceOptions.map((option) => (
            <Button
              key={option.value}
              variant={source === option.value ? "default" : "muted"}
              active={source === option.value}
              onClick={() => setSource(option.value)}
            >
              {option.label}
            </Button>
          ))}
        </div>
        <div className="segmentedControls" aria-label="任务状态筛选">
          {STATUS_OPTIONS.map((option) => (
            <Button
              key={option.value}
              variant={status === option.value ? "default" : "muted"}
              active={status === option.value}
              onClick={() => setStatus(option.value)}
            >
              {option.label}
            </Button>
          ))}
        </div>
      </div>

      {error ? <Alert tone="error">{error}</Alert> : null}

      <div className="jobDashboardList" aria-busy={loading}>
        {data?.jobs.length ? (
          data.jobs.map((job) => (
            <JobDashboardRow
              key={`${job.source}:${job.id}`}
              job={job}
              busy={rerunningJobKey === `${job.source}:${job.id}`}
              actionsDisabled={Boolean(rerunningJobKey)}
              buildJobHref={buildJobHref}
              onRerun={rerunJob}
            />
          ))
        ) : (
          <div className="jobDashboardEmpty">{loading ? "正在读取后台任务..." : "当前筛选下没有任务"}</div>
        )}
      </div>
    </div>
  );
}
