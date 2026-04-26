"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { PlaygroundSandboxFilesBrowser } from "@/components/playground/sandbox-files-browser";
import { useAutoDismissToast } from "@/components/ui/use-toast";
import type {
  PlaygroundChecklistItem,
  PlaygroundChecklistStage,
  PlaygroundChecklistSuiteId,
  PlaygroundToolName
} from "@/lib/playground/types";
import {
  PLAYGROUND_CHECKLIST_SUITE_IDS,
  PLAYGROUND_CHECKLIST_SUITES,
  PLAYGROUND_DEFAULT_CHECKLIST_SUITE_IDS
} from "@/lib/playground/types";

type Agent = {
  id: string;
  name: string;
  provider: "openai" | "anthropic";
  model: string;
  baseUrl: string;
  isActive: boolean;
  usageControlMode: "none" | "coding_plan";
};

const STAGE_LABELS: Record<PlaygroundChecklistStage, string> = {
  queued: "已入队",
  requesting_model: "请求模型",
  receiving_model_output: "接收输出",
  executing_tools: "执行工具",
  sandbox_changed: "文件变动",
  validating_result: "校验结果",
  passed: "已通过",
  failed: "已失败"
};

const PROGRESS_SEGMENTS = [
  { label: "请求模型", stages: ["queued", "requesting_model"] as PlaygroundChecklistStage[] },
  { label: "接收输出", stages: ["receiving_model_output"] as PlaygroundChecklistStage[] },
  { label: "工具执行", stages: ["executing_tools"] as PlaygroundChecklistStage[] },
  { label: "文件变动", stages: ["sandbox_changed"] as PlaygroundChecklistStage[] },
  { label: "结果校验", stages: ["validating_result", "passed", "failed"] as PlaygroundChecklistStage[] }
];

type ChecklistSnapshotPayload = { items?: PlaygroundChecklistItem[] };
type ChecklistItemPayload = { item?: PlaygroundChecklistItem };

function formatDateTime(value: string | null) {
  if (!value) return "未测";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", {
    hour12: false,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function statusLabel(status: PlaygroundChecklistItem["status"]) {
  if (status === "running") return "运行中";
  if (status === "passed") return "√ 已通过";
  if (status === "failed") return "× 失败";
  return "未测";
}

function statusClass(status: PlaygroundChecklistItem["status"]) {
  if (status === "passed") return "success";
  if (status === "failed") return "error";
  if (status === "running") return "warn";
  return "muted";
}

function getProgressSegmentIndex(stage: PlaygroundChecklistStage | null) {
  if (!stage) return -1;
  const index = PROGRESS_SEGMENTS.findIndex((segment) => segment.stages.includes(stage));
  return index >= 0 ? index : -1;
}

function getProgressSegmentClass(item: PlaygroundChecklistItem, index: number) {
  const currentIndex = getProgressSegmentIndex(item.currentStage);
  if (item.status === "passed") {
    return "done success";
  }
  if (item.status === "failed") {
    if (currentIndex > index) return "done";
    if (currentIndex === index) return "failed";
    return "pending";
  }
  if (item.status === "running") {
    if (currentIndex > index) return "done";
    if (currentIndex === index) return "current";
    return "pending";
  }
  return "pending";
}

function getCurrentStageText(item: PlaygroundChecklistItem) {
  if (item.progressMessage?.trim()) return item.progressMessage.trim();
  if (item.currentStage) return STAGE_LABELS[item.currentStage];
  return statusLabel(item.status);
}

function getDisplayStatusText(item: PlaygroundChecklistItem) {
  if (item.status === "passed") return "已通过";
  if (item.status === "failed") return "失败";
  if (item.status === "running") return "运行中";
  return "未测";
}

function shouldShowStageSummary(item: PlaygroundChecklistItem) {
  if (item.status === "running") return true;
  if (item.status === "failed") return Boolean(item.errorMessage);
  return false;
}

function getShortError(item: PlaygroundChecklistItem) {
  return item.status === "failed" ? item.errorMessage ?? item.progressMessage ?? null : null;
}

function mergeChecklistItem(items: PlaygroundChecklistItem[], nextItem: PlaygroundChecklistItem) {
  return items.map((item) => (item.toolName === nextItem.toolName ? nextItem : item));
}

function mergeChecklistItems(items: PlaygroundChecklistItem[], nextItems: PlaygroundChecklistItem[]) {
  const nextMap = new Map(nextItems.map((item) => [item.toolName, item] as const));
  return items.map((item) => nextMap.get(item.toolName) ?? item);
}

export default function PlaygroundPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentId, setAgentId] = useState("");
  const [checklist, setChecklist] = useState<PlaygroundChecklistItem[]>([]);
  const [selectedSuiteIds, setSelectedSuiteIds] = useState<PlaygroundChecklistSuiteId[]>(PLAYGROUND_DEFAULT_CHECKLIST_SUITE_IDS);
  const [selectedToolName, setSelectedToolName] = useState<PlaygroundToolName | null>(null);
  const [runningToolName, setRunningToolName] = useState<string | null>(null);
  const [runningAll, setRunningAll] = useState(false);
  const [rerunningFailed, setRerunningFailed] = useState(false);
  const { toast, showToast } = useAutoDismissToast(1600);

  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.id === agentId) ?? null,
    [agentId, agents]
  );
  const visibleChecklist = useMemo(() => {
    const selectedSuiteSet = new Set(selectedSuiteIds);
    return checklist.filter((item) => selectedSuiteSet.has(item.suiteId));
  }, [checklist, selectedSuiteIds]);
  const selectedChecklistItem = useMemo(
    () => visibleChecklist.find((item) => item.toolName === selectedToolName) ?? visibleChecklist[0] ?? null,
    [visibleChecklist, selectedToolName]
  );
  const actionableItems = useMemo(
    () => visibleChecklist.filter((item) => item.status === "failed" || item.status === "idle"),
    [visibleChecklist]
  );
  const allSuitesSelected = selectedSuiteIds.length === PLAYGROUND_CHECKLIST_SUITE_IDS.length;

  const readPayload = useCallback(async (response: Response) => {
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
  }, []);

  const loadAgents = useCallback(async () => {
    const response = await fetch("/api/agents", { cache: "no-store" });
    const payload = await readPayload(response);
    if (!response.ok) {
      showToast("error", payload.error?.message ?? "AI 配置加载失败");
      return;
    }
    const activeAgents = Array.isArray(payload.data)
      ? (payload.data as Agent[]).filter((agent) => agent.isActive)
      : [];
    setAgents(activeAgents);
    setAgentId((current) => current || activeAgents[0]?.id || "");
  }, [readPayload, showToast]);

  const loadChecklist = useCallback(async (nextAgentId: string) => {
    if (!nextAgentId) {
      setChecklist([]);
      setSelectedToolName(null);
      return;
    }
    const response = await fetch(`/api/agents/playground/checklist?agentId=${encodeURIComponent(nextAgentId)}`, {
      cache: "no-store"
    });
    const payload = await readPayload(response);
    if (!response.ok) {
      showToast("error", payload.error?.message ?? "工具验收结果加载失败");
      return;
    }
    const items = Array.isArray(payload.data) ? (payload.data as PlaygroundChecklistItem[]) : [];
    setChecklist(items);
    setSelectedToolName((current) => (current && items.some((item) => item.toolName === current) ? current : items[0]?.toolName ?? null));
  }, [readPayload, showToast]);

  useEffect(() => {
    void loadAgents();
  }, [loadAgents]);

  useEffect(() => {
    if (!agentId) return;
    void loadChecklist(agentId);
  }, [agentId, loadChecklist]);

  useEffect(() => {
    setSelectedToolName((current) =>
      current && visibleChecklist.some((item) => item.toolName === current) ? current : visibleChecklist[0]?.toolName ?? null
    );
  }, [visibleChecklist]);

  useEffect(() => {
    if (!agentId) return;
    const source = new EventSource(`/api/agents/playground/checklist/stream?agentId=${encodeURIComponent(agentId)}`);

    const applySnapshot = (payload: ChecklistSnapshotPayload) => {
      const items = Array.isArray(payload.items) ? payload.items : [];
      setChecklist(items);
      setSelectedToolName((current) => (current && items.some((item) => item.toolName === current) ? current : items[0]?.toolName ?? null));
    };

    const applyItem = (payload: ChecklistItemPayload) => {
      const nextItem = payload.item;
      if (!nextItem) return;
      setChecklist((current) => {
        if (current.some((item) => item.toolName === nextItem.toolName)) {
          return mergeChecklistItem(current, nextItem);
        }
        return [...current, nextItem];
      });
      setSelectedToolName((current) => current ?? nextItem.toolName);
    };

    source.addEventListener("snapshot", (event) => {
      try {
        applySnapshot(JSON.parse((event as MessageEvent).data) as ChecklistSnapshotPayload);
      } catch {
      }
    });
    source.addEventListener("checklist_progress", (event) => {
      try {
        applyItem(JSON.parse((event as MessageEvent).data) as ChecklistItemPayload);
      } catch {
      }
    });
    source.addEventListener("checklist_finished", (event) => {
      try {
        applyItem(JSON.parse((event as MessageEvent).data) as ChecklistItemPayload);
      } catch {
      }
    });

    return () => {
      source.close();
    };
  }, [agentId]);

  async function runSingleChecklist(toolName: PlaygroundToolName) {
    if (!agentId) {
      showToast("error", "先选择一个已启用 AI 配置");
      return;
    }
    setRunningToolName(toolName);
    setChecklist((current) =>
      current.map((item) =>
        item.toolName === toolName
          ? {
              ...item,
              status: "running",
              currentStage: "queued",
              progressMessage: "测试已开始，准备发起模型请求",
              errorMessage: null
            }
          : item
      )
    );
    try {
      const response = await fetch("/api/agents/playground/checklist/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId, toolId: toolName })
      });
      const payload = await readPayload(response);
      if (!response.ok) {
        showToast("error", payload.error?.message ?? "工具测试失败");
        await loadChecklist(agentId);
        return;
      }
      const updated = payload.data as PlaygroundChecklistItem;
      setChecklist((current) => mergeChecklistItem(current, updated));
      setSelectedToolName(updated.toolName);
      showToast(updated.passed ? "success" : "error", `${updated.label} ${updated.passed ? "通过" : "失败"}`);
    } catch (error) {
      showToast("error", error instanceof Error ? error.message : String(error));
      await loadChecklist(agentId);
    } finally {
      setRunningToolName(null);
    }
  }

  function toggleSuite(suiteId: PlaygroundChecklistSuiteId) {
    setSelectedSuiteIds((current) => {
      if (current.includes(suiteId)) {
        const next = current.filter((item) => item !== suiteId);
        return next.length > 0 ? next : current;
      }
      return [...current, suiteId];
    });
  }

  function toggleAllSuites() {
    setSelectedSuiteIds((current) =>
      current.length === PLAYGROUND_CHECKLIST_SUITE_IDS.length
        ? [...PLAYGROUND_DEFAULT_CHECKLIST_SUITE_IDS]
        : [...PLAYGROUND_CHECKLIST_SUITE_IDS]
    );
  }

  async function rerunFailedChecklist() {
    if (!agentId) {
      showToast("error", "先选择一个已启用 AI 配置");
      return;
    }
    if (actionableItems.length === 0) {
      showToast("error", "当前没有未过项可补测");
      return;
    }
    setRerunningFailed(true);
    setChecklist((current) =>
      current.map((item) =>
        item.status === "failed" || item.status === "idle"
          ? {
              ...item,
              status: "running",
              currentStage: "queued",
              progressMessage: "测试已开始，准备发起模型请求",
              errorMessage: null
            }
          : item
      )
    );
    let passedCount = 0;
    try {
      const responses = await Promise.all(
        actionableItems.map(async (item) => {
          const response = await fetch("/api/agents/playground/checklist/run", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ agentId, toolId: item.toolName })
          });
          const payload = await readPayload(response);
          return { item, response, payload };
        })
      );
      const failedResponse = responses.find(({ item, response, payload }) => {
        if (response.ok) return false;
        showToast("error", payload.error?.message ?? `${item.label} 补测失败`);
        return true;
      });
      if (failedResponse) {
        await loadChecklist(agentId);
        return;
      }
      const updatedItems = responses.map(({ payload }) => payload.data as PlaygroundChecklistItem);
      passedCount = updatedItems.filter((item) => item.passed).length;
      setChecklist((current) => mergeChecklistItems(current, updatedItems));
      setSelectedToolName((current) => current ?? updatedItems[0]?.toolName ?? null);
      showToast(
        passedCount === actionableItems.length ? "success" : "error",
        `补测完成 ${passedCount}/${actionableItems.length}`
      );
    } catch (error) {
      showToast("error", error instanceof Error ? error.message : String(error));
      await loadChecklist(agentId);
    } finally {
      setRunningToolName(null);
      setRerunningFailed(false);
    }
  }

  async function runAllChecklist() {
    if (!agentId) {
      showToast("error", "先选择一个已启用 AI 配置");
      return;
    }
    if (visibleChecklist.length === 0) {
      showToast("error", "当前没有已选测试集可运行");
      return;
    }
    setRunningAll(true);
    setChecklist((current) =>
      current.map((item) =>
        selectedSuiteIds.includes(item.suiteId)
          ? {
              ...item,
              status: "running",
              currentStage: "queued",
              progressMessage: "测试已开始，准备发起模型请求",
              errorMessage: null
            }
          : item
      )
    );
    try {
      const response = await fetch("/api/agents/playground/checklist/run-all", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId, suiteIds: selectedSuiteIds })
      });
      const payload = await readPayload(response);
      if (!response.ok) {
        showToast("error", payload.error?.message ?? "全部测试失败");
        await loadChecklist(agentId);
        return;
      }
      const items = Array.isArray(payload.data) ? (payload.data as PlaygroundChecklistItem[]) : [];
      setChecklist((current) => mergeChecklistItems(current, items));
      setSelectedToolName((current) => current ?? items[0]?.toolName ?? null);
      const passedCount = items.filter((item) => item.passed).length;
      showToast(passedCount === items.length ? "success" : "error", `已完成 ${passedCount}/${items.length} 项`);
    } catch (error) {
      showToast("error", error instanceof Error ? error.message : String(error));
      await loadChecklist(agentId);
    } finally {
      setRunningAll(false);
    }
  }

  async function clearChecklist() {
    if (!agentId) return;
    const response = await fetch(`/api/agents/playground/checklist?agentId=${encodeURIComponent(agentId)}`, {
      method: "DELETE"
    });
    const payload = await readPayload(response);
    if (!response.ok) {
      showToast("error", payload.error?.message ?? "清空失败");
      return;
    }
    await loadChecklist(agentId);
    showToast("success", "已清空该 AI 的工具验收结果");
  }

  return (
    <div className="grid playgroundChecklistShell">
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
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div>
            <h2 style={{ margin: 0 }}>工具验收台</h2>
            <div className="muted">先选 AI，再直接测试每个工具能不能真的用起来。每次真实模型请求都会计入该 AI 的 Coding Plan 次数。</div>
          </div>
          <div className="row">
            <button
              className="btn"
              onClick={() => void rerunFailedChecklist()}
              disabled={!agentId || runningAll || rerunningFailed || Boolean(runningToolName) || actionableItems.length === 0}
            >
              {rerunningFailed ? "补测未过项中..." : "补测未过项"}
            </button>
            <button className="btn btn-muted" onClick={() => void clearChecklist()} disabled={!agentId || runningAll || rerunningFailed || Boolean(runningToolName)}>
              清空结果
            </button>
            <button className="btn btn-primary" onClick={() => void runAllChecklist()} disabled={!agentId || runningAll || rerunningFailed || Boolean(runningToolName)}>
              {runningAll ? "全部测试中..." : "全部测试"}
            </button>
          </div>
        </div>

        <div className="softBox stack">
          <div className="field">
            <label>AI 配置</label>
            <select value={agentId} onChange={(event) => setAgentId(event.target.value)}>
              <option value="">选择一个已启用 AI</option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name} · {agent.provider} · {agent.model}
                </option>
              ))}
            </select>
          </div>
          {selectedAgent ? (
            <div className="stack" style={{ gap: 6 }}>
              <div className="row muted" style={{ fontSize: 13 }}>
                <span>{selectedAgent.baseUrl}</span>
                <span>·</span>
                <span>限额模式：{selectedAgent.usageControlMode === "coding_plan" ? "Coding Plan" : "不控制"}</span>
              </div>
              {selectedAgent.usageControlMode === "coding_plan" ? (
                <div className="status-pill warn" style={{ width: "fit-content" }}>
                  Playground 测试会消耗这个 AI 绑定的 Coding Plan 次数
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="softBox stack">
          <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
            <strong>测试集</strong>
            <div className="row" style={{ gap: 10, alignItems: "center" }}>
              <span className="muted" style={{ fontSize: 13 }}>
                已选 {selectedSuiteIds.length} 个测试集 / {visibleChecklist.length} 个用例
              </span>
              <button
                type="button"
                className={allSuitesSelected ? "btn btn-primary" : "btn btn-muted"}
                style={{ minHeight: 32, padding: "0 12px" }}
                onClick={() => toggleAllSuites()}
                disabled={runningAll || rerunningFailed || Boolean(runningToolName)}
              >
                全选
              </button>
            </div>
          </div>
          <div className="stack" style={{ gap: 10 }}>
            {PLAYGROUND_CHECKLIST_SUITES.map((suite) => (
              <label key={suite.id} className="playgroundChecklistSuiteOption">
                <input
                  type="checkbox"
                  checked={selectedSuiteIds.includes(suite.id)}
                  onChange={() => toggleSuite(suite.id)}
                  disabled={runningAll || rerunningFailed || Boolean(runningToolName)}
                />
                <div className="playgroundChecklistSuiteText">
                  <span className="playgroundChecklistSuiteLabel">
                    {suite.label}
                    {suite.defaultSelected ? <span className="playgroundChecklistSuiteDefault">默认</span> : null}
                  </span>
                  <span className="muted">{suite.description}</span>
                </div>
              </label>
            ))}
          </div>
        </div>

        <div className="stack">
          {visibleChecklist.map((item) => (
            <div
              key={item.toolName}
              className={`playgroundChecklistCard ${selectedChecklistItem?.toolName === item.toolName ? "selected" : ""}`}
              onClick={() => setSelectedToolName(item.toolName)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  setSelectedToolName(item.toolName);
                }
              }}
              role="button"
              tabIndex={0}
            >
              <div className="playgroundChecklistCardBody">
                <div className="playgroundChecklistMain">
                  <span
                    className={`playgroundChecklistDot ${statusClass(item.status)}`}
                    aria-label={statusLabel(item.status)}
                    title={statusLabel(item.status)}
                  />
                  <div className="playgroundChecklistText">
                    <div className="playgroundChecklistTitleRow">
                      <div className="playgroundChecklistTitleLead">
                        <strong>{item.label}</strong>
                        <span className="playgroundChecklistSuiteBadge">{item.suiteLabel}</span>
                        <span className={`playgroundChecklistInlineStatus ${statusClass(item.status)}`}>
                          {getDisplayStatusText(item)}
                        </span>
                        <div className="playgroundChecklistHint">
                          <button
                            type="button"
                            className="playgroundChecklistHintButton"
                            aria-label={`${item.label} 说明`}
                          >
                            ?
                          </button>
                          <div className="playgroundChecklistTooltip" role="tooltip">
                            <div>{item.description}</div>
                            <div>状态：{statusLabel(item.status)}</div>
                            <div>当前阶段：{item.currentStage ? STAGE_LABELS[item.currentStage] : "未开始"}</div>
                            <div>最近测试：{formatDateTime(item.lastRunAt)}</div>
                            {item.lastPassedAt ? <div>最近通过：{formatDateTime(item.lastPassedAt)}</div> : null}
                            {item.errorMessage ? <div>失败原因：{item.errorMessage}</div> : null}
                          </div>
                        </div>
                      </div>
                    </div>
                    {shouldShowStageSummary(item) ? (
                      <div className="playgroundChecklistStageText">{getCurrentStageText(item)}</div>
                    ) : null}
                    <div className="playgroundChecklistProgress">
                      {PROGRESS_SEGMENTS.map((segment, index) => (
                        <span
                          key={segment.label}
                          className={`playgroundChecklistProgressSegment ${getProgressSegmentClass(item, index)}`}
                        />
                      ))}
                    </div>
                    <div className="playgroundChecklistMeta">
                      <span>最近测试：{formatDateTime(item.lastRunAt)}</span>
                      {getShortError(item) ? (
                        <>
                          <span>·</span>
                          <span className="playgroundChecklistErrorText">{getShortError(item)}</span>
                        </>
                      ) : null}
                    </div>
                  </div>
                </div>
                <div className="playgroundChecklistActions">
                  <button
                    className="btn btn-primary"
                    onClick={(event) => {
                      event.stopPropagation();
                      void runSingleChecklist(item.toolName);
                    }}
                    disabled={runningAll || rerunningFailed || Boolean(runningToolName)}
                  >
                    {runningToolName === item.toolName ? "测试中..." : "测试"}
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="panel stack">
        <h2 style={{ margin: 0 }}>详情</h2>
        {!selectedChecklistItem ? (
          <div className="softBox muted">先选择一个 AI，再查看某个工具的验收详情。</div>
        ) : (
          <>
            <div className="softBox stack">
              <div className="row" style={{ justifyContent: "space-between" }}>
                <div className="row" style={{ gap: 10, alignItems: "center" }}>
                  <strong>{selectedChecklistItem.label}</strong>
                  <span className="playgroundChecklistSuiteBadge">{selectedChecklistItem.suiteLabel}</span>
                </div>
                <span className={`status-pill ${statusClass(selectedChecklistItem.status)}`}>{statusLabel(selectedChecklistItem.status)}</span>
              </div>
              <div className="muted">{selectedChecklistItem.description}</div>
            </div>

            <div className="softBox stack">
              <strong>当前状态</strong>
              <div className="playgroundStatusHeadline">
                <span className="muted">状态：{getDisplayStatusText(selectedChecklistItem)}</span>
                <span className="muted">开始时间：{formatDateTime(selectedChecklistItem.lastRunAt)}</span>
                <span className="muted">当前阶段开始：{formatDateTime(selectedChecklistItem.stageStartedAt)}</span>
              </div>
              <div className="playgroundChecklistProgress detail">
                {PROGRESS_SEGMENTS.map((segment, index) => (
                  <div key={segment.label} className="playgroundChecklistProgressDetailItem">
                    <span className="playgroundChecklistProgressLabel">{segment.label}</span>
                    <span
                      className={`playgroundChecklistProgressSegment ${getProgressSegmentClass(selectedChecklistItem, index)}`}
                      aria-label={segment.label}
                      title={segment.label}
                    />
                  </div>
                ))}
              </div>
              {shouldShowStageSummary(selectedChecklistItem) ? (
                <div className="playgroundStatusMessage">{getCurrentStageText(selectedChecklistItem)}</div>
              ) : null}
              {selectedChecklistItem.errorMessage ? (
                <div className="playgroundStatusError">{selectedChecklistItem.errorMessage}</div>
              ) : null}
            </div>

            <div className="softBox stack">
              <strong>阶段轨迹</strong>
              {selectedChecklistItem.stageHistory.length === 0 ? (
                <div className="muted">这个工具还没有最近一次运行轨迹。</div>
              ) : (
                <div className="playgroundStageHistory">
                  {selectedChecklistItem.stageHistory.map((entry) => (
                    <div key={`${entry.stage}-${entry.startedAt}`} className="playgroundStageHistoryItem">
                      <div className="row" style={{ justifyContent: "space-between" }}>
                        <strong>{entry.label}</strong>
                        <span className="muted" style={{ fontSize: 12 }}>
                          {formatDateTime(entry.startedAt)}
                          {entry.completedAt ? ` → ${formatDateTime(entry.completedAt)}` : ""}
                        </span>
                      </div>
                      {entry.message ? <div className="muted">{entry.message}</div> : null}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="softBox stack">
              <strong>测试 Prompt</strong>
              <div className="stack" style={{ gap: 8 }}>
                <pre className="playgroundPre">{selectedChecklistItem.systemPrompt}</pre>
                <pre className="playgroundPre">{selectedChecklistItem.userPrompt}</pre>
              </div>
              <div className="muted" style={{ fontSize: 13 }}>通过规则：{selectedChecklistItem.passRule}</div>
            </div>

            <div className="softBox stack">
              <strong>初始 Sandbox Files</strong>
              <PlaygroundSandboxFilesBrowser
                title="初始文件"
                files={selectedChecklistItem.sandboxFiles}
                emptyText="这个测试不需要预置文件。"
              />
            </div>

            {selectedChecklistItem.traceSummary ? (
              <>
                <div className="softBox stack">
                  <strong>Final Output</strong>
                  <pre className="playgroundPre">{selectedChecklistItem.traceSummary.result.finalText || "(empty)"}</pre>
                </div>

                <div className="softBox stack">
                  <strong>Tool Calls</strong>
                  {selectedChecklistItem.traceSummary.result.toolCalls.length === 0 ? (
                    <div className="muted">本次没有 tool call。</div>
                  ) : (
                    selectedChecklistItem.traceSummary.result.toolCalls.map((call) => (
                      <div key={call.id} className="playgroundTraceCard">
                        <div className="row" style={{ justifyContent: "space-between" }}>
                          <strong>{call.toolName}</strong>
                          <span className="muted" style={{ fontSize: 12 }}>{call.at}</span>
                        </div>
                        <pre className="playgroundPre">{call.rawArguments}</pre>
                      </div>
                    ))
                  )}
                </div>

                <div className="softBox stack">
                  <strong>Tool Results</strong>
                  {selectedChecklistItem.traceSummary.result.toolExecutions.map((execution) => (
                    <div key={execution.id} className="playgroundTraceCard">
                      <div className="row" style={{ justifyContent: "space-between" }}>
                        <strong>{execution.toolName}</strong>
                        <span className={`status-pill ${execution.ok ? "success" : "error"}`}>
                          {execution.ok ? "ok" : "error"}
                        </span>
                      </div>
                      <pre className="playgroundPre">{JSON.stringify(execution.result, null, 2)}</pre>
                    </div>
                  ))}
                </div>

                <div className="softBox stack">
                  <strong>Sandbox After Run</strong>
                  <PlaygroundSandboxFilesBrowser
                    title="运行后文件"
                    files={selectedChecklistItem.traceSummary.result.sandboxFilesAfter}
                    emptyText="运行后没有 sandbox 文件。"
                  />
                </div>
              </>
            ) : (
              <div className="softBox muted">这个工具还没有可展示的最近一次运行 trace。</div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
