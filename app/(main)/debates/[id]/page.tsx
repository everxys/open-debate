"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import {
  Fragment,
  memo,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type MutableRefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { Tree, type NodeApi } from "react-arborist";

import { useAutoDismissToast } from "@/components/ui/use-toast";
import { MarkdownView } from "@/components/ui/markdown";
import { createFsTreeModel, type FsNode, normalizeFsPath } from "@/lib/fs-tree";
import {
  formatRequiredDeliverableSummary,
  normalizeDebateWorkflow,
  type NormalizedDebateWorkflow
} from "@/lib/workflow";

type Agent = {
  id: string;
  name: string;
  provider: string;
  model: string;
};

type DebateAgent = {
  id: string;
  debateAgentId: string;
  displayName: string;
  name: string;
  provider: string;
  contextLength: number | null;
  maxInputTokens: number | null;
  maxOutputTokens: number | null;
  turnOrder: number;
  turnCount: number;
};

type Debate = {
  id: string;
  question: string;
  status: string;
  currentTurn: number;
  maxTurns: number;
  tokenUsed: number;
  isShared: boolean;
  isOwner: boolean;
  consensusReached: boolean;
  consensusSummary: {
    leadingSolution: string;
    score: number;
  } | null;
  agents: DebateAgent[];
};

type Turn = {
  id: string;
  turnNumber: number;
  debateAgentId: string | null;
  seatNumber: number | null;
  content: string;
  parseStatus: string;
  tokenUsed: number;
  createdAt: string;
  agent: {
    name: string;
    provider: string;
  };
  structuredOutput: {
    proposed_solution?: string;
    arguments?: Array<{ type: "support" | "rebuttal"; content: string }>;
    agreement_score?: number;
  } | null;
};

type LeftTab = "status" | "participants" | "workflow" | "memory";

type LeftTabIconName = "status" | "participants" | "workflow" | "memory";

type WorkflowRulesState = {
  markdown: string;
  loading: boolean;
};

type DebateDirectoryPhaseInfo = {
  phaseId: string;
  title: string;
  kind: "analysis" | "election" | "deliberation" | "finalization";
  description: string | null;
  injectedPrompt: string | null;
};

type AllFilesMeta =
  | { scope: "debate"; path: string }
  | { scope: "agent"; debateAgentId: string; seat: string; agentName: string; path: string };

type AllFilesContextMenuState =
  | null
  | {
      x: number;
      y: number;
      target:
        | { type: "root" }
        | { type: "node"; path: string; nodeType: FsNode["type"] };
    };

type AllFilesContextMenuValue = NonNullable<AllFilesContextMenuState>;

type AllFilesDownloadProgress = {
  loadedBytes: number;
  totalBytes: number | null;
};

type AllFileInfoState = {
  displayPath: string;
  charCount: number;
  byteSize: number;
  createdAt: string;
  updatedAt: string;
};

const WORKFLOW_RULES_DISABLED_MARKDOWN = [
  "**Workflow 规则（未启用）**",
  "",
  "- 本场辩论没有启用 workflow（默认关闭）。",
  "- 如需启用：在策略里创建 `debate/workflow.json`，然后用该策略新建辩论。",
  "",
  "- 注意：workflow 在“创建辩论”时复制到辩论共享文件 `workflow.json`，已有辩论不会自动更新。"
].join("\n");

const WORKFLOW_RULES_ERROR_MARKDOWN = "**Workflow 规则**\n\n- 读取失败（网络错误或内容非 JSON）。";

function formatWorkflowRulesMarkdown(raw: string) {
  let parsedJson: unknown = null;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    parsedJson = null;
  }
  const parsed = normalizeDebateWorkflow(parsedJson);
  if (!parsed || !parsed.enabled) {
    return WORKFLOW_RULES_DISABLED_MARKDOWN;
  }

  const rules: string[] = [];
  rules.push("**Workflow 规则**");
  rules.push("");
  rules.push(`- 版本：v${parsed.workflowVersion}`);
  rules.push("- 状态：已启用");
  rules.push("");

  rules.push("**阶段机**");
  rules.push(`- 开局注入提示词：${parsed.promptPolicies.openingPrompt ? "已配置" : "未配置"}`);
  if (parsed.phaseMachine.phases.length === 0) {
    rules.push("- （未配置）");
  } else {
    for (const phase of parsed.phaseMachine.phases) {
      rules.push(
        `- ${phase.title}${phase.description ? `：${phase.description}` : ""}${phase.minRounds ? `（至少 ${phase.minRounds} 轮）` : ""}${phase.injectedPrompt ? "［已配置阶段提示词］" : ""}`
      );
    }
  }
  rules.push("");

  rules.push("**官方投票（选举）**");
  rules.push(`- 允许投票起始轮次：第 ${parsed.election.startRound} 轮起`);
  rules.push(
    `- 阶段切换：Phase 2 从第 ${parsed.phaseMachine.transitionRules.election.startRound} 轮开始；自动开选举票=${parsed.phaseMachine.transitionRules.election.autoOpen ? "是" : "否"}`
  );
  rules.push(`- 选举角色：${parsed.election.roles.length ? parsed.election.roles.join(" / ") : "（无，禁止 election）"}`);
  rules.push(`- 平票处理：${parsed.voting.governance.tieBreaker === "seat_order" ? "按席位顺序决胜" : "重新投票"}`);
  rules.push(`- 最大平票重投次数：${parsed.voting.governance.maxTieRounds}`);
  rules.push(`- 平票后建议模式：${parsed.voting.governance.fallbackMode ?? "（无）"}`);
  rules.push(
    `- 选举后顺序约束（下一轮边界生效）：${
      parsed.election.speakingOrder.firstRole || parsed.election.speakingOrder.lastRole
        ? `首位=${parsed.election.speakingOrder.firstRole ?? "（无）"}；末位=${parsed.election.speakingOrder.lastRole ?? "（无）"}`
        : "无"
    }`
  );
  rules.push("");

  rules.push("**输出与交付**");
  rules.push(
    `- Phase 4 进入条件：共识达成=${parsed.phaseMachine.transitionRules.finalization.enterOnConsensus ? "是" : "否"}；打开最终票=${parsed.phaseMachine.transitionRules.finalization.enterOnCustomVote ? "是" : "否"}`
  );
  rules.push(
    `- 完成限制：必须先进入 Phase 4 才能完成=${parsed.phaseMachine.transitionRules.finalization.requirePhaseForCompletion ? "是" : "否"}`
  );
  rules.push(`- 输出格式：${parsed.promptPolicies.responseFormat.requireMarkdown ? "Markdown" : "不强制 Markdown"}`);
  rules.push(`- 禁止原始 JSON：${parsed.promptPolicies.responseFormat.forbidRawJson ? "是" : "否"}`);
  rules.push(
    `- 单轮输出预算：讨论=${parsed.promptPolicies.outputBudget.discussionMaxTokens ?? "不设上限"}；写作=${parsed.promptPolicies.outputBudget.writingMaxTokens ?? "不设上限"}`
  );
  rules.push(`- Round 1 公平性提示：${parsed.promptPolicies.round1Fairness ? "开启" : "关闭"}`);
  rules.push(
    `- 允许写入路径：${parsed.deliverables.allowedPaths.length ? parsed.deliverables.allowedPaths.join(" / ") : "（无）"}`
  );
  if (parsed.ideaBank.rawIdeaBankPath || Object.values(parsed.ideaBank.derivedFiles).some(Boolean)) {
    rules.push(
      `- 原始点子库：${parsed.ideaBank.rawIdeaBankPath ?? "（无）"}`
    );
    rules.push(
      `- 点子筛选结果文件：${[
        parsed.ideaBank.derivedFiles.selectedSTierPath,
        parsed.ideaBank.derivedFiles.selectedATierPath,
        parsed.ideaBank.derivedFiles.rejectedOrMergedPath,
        parsed.ideaBank.derivedFiles.eventMappingsPath,
        parsed.ideaBank.derivedFiles.newlyInventedIdeasPath
      ]
        .filter((item): item is string => Boolean(item))
        .join(" / ") || "（无）"}`
    );
  }
  rules.push(
    `- 必交文件：${
      parsed.deliverables.requiredFiles.length
        ? parsed.deliverables.requiredFiles.map((item) => formatRequiredDeliverableSummary(item, "display")).join(" / ")
        : "（无）"
    }`
  );
  rules.push("");

  rules.push("**轮次边界自动重排**");
  if (parsed.seatOrderRules.length === 0) {
    rules.push("- 无");
    return rules.join("\n");
  }

  for (const rule of parsed.seatOrderRules) {
    if (rule.policy.type === "reverse") {
      rules.push(`- 第 ${rule.afterRound} 轮结束后：反转席位顺序（第 ${rule.afterRound + 1} 轮生效）`);
    } else {
      rules.push(`- 第 ${rule.afterRound} 轮结束后：轮换席位顺序 offset=${rule.policy.offset}（第 ${rule.afterRound + 1} 轮生效）`);
    }
  }

  return rules.join("\n");
}

async function fetchWorkflowRulesMarkdown(debateId: string) {
  const response = await fetch(`/api/debates/${debateId}/files?path=${encodeURIComponent("workflow.json")}`, {
    cache: "no-store"
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    return null;
  }
  const content = String(payload.data?.content ?? "");
  return content.trim() ? content : null;
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${Math.floor(value)} B`;
}

function parseWorkflowConfig(raw: string | null) {
  if (!raw) return null;
  try {
    return normalizeDebateWorkflow(JSON.parse(raw));
  } catch {
    return null;
  }
}

function getWorkflowMinimumAnalysisRounds(workflow: NormalizedDebateWorkflow | null) {
  if (!workflow?.enabled) return 0;
  const analysisPhase = workflow.phaseMachine.phases.find((phase) => phase.kind === "analysis");
  const analysisMinRounds = analysisPhase?.minRounds ?? 0;
  return Math.max(workflow.phaseMachine.transitionRules.election.startRound - 1, analysisMinRounds);
}

function getWorkflowPhaseMinRounds(
  workflow: NormalizedDebateWorkflow | null,
  kind: "analysis" | "election" | "deliberation" | "finalization",
  fallback = 0
) {
  const minRounds = workflow?.phaseMachine.phases.find((phase) => phase.kind === kind)?.minRounds;
  return typeof minRounds === "number" && Number.isFinite(minRounds) && minRounds >= 0 ? Math.floor(minRounds) : fallback;
}

function getWorkflowEarliestDeliberationRound(workflow: NormalizedDebateWorkflow | null) {
  if (!workflow?.enabled) return 1;
  return getWorkflowMinimumAnalysisRounds(workflow) + getWorkflowPhaseMinRounds(workflow, "election", 1) + 1;
}

function getWorkflowEarliestFinalizationRound(workflow: NormalizedDebateWorkflow | null) {
  if (!workflow?.enabled) return 1;
  return getWorkflowEarliestDeliberationRound(workflow) + getWorkflowPhaseMinRounds(workflow, "deliberation", 0);
}

function resolveDirectoryPhaseForRound(
  workflow: NormalizedDebateWorkflow | null,
  round: number,
  allowFinalization = false,
  openVote: OfficialVoteOpenState | null = null,
  currentRound: number | null = null
): DebateDirectoryPhaseInfo | null {
  if (!workflow?.enabled) return null;
  const phaseByKind = new Map(workflow.phaseMachine.phases.map((phase) => [phase.kind, phase] as const));
  if (openVote && currentRound !== null && round === currentRound) {
    if (openVote.kind === "election") {
      return phaseByKind.get("election") ?? null;
    }
    return phaseByKind.get("finalization") ?? null;
  }
  if (allowFinalization && round >= getWorkflowEarliestFinalizationRound(workflow)) {
    return phaseByKind.get("finalization") ?? null;
  }
  if (round >= getWorkflowEarliestDeliberationRound(workflow)) {
    return phaseByKind.get("deliberation") ?? null;
  }
  if (round >= workflow.phaseMachine.transitionRules.election.startRound) {
    return phaseByKind.get("election") ?? null;
  }
  return phaseByKind.get("analysis") ?? null;
}

function isPhaseEntryRound(workflow: NormalizedDebateWorkflow | null, round: number, kind: DebateDirectoryPhaseInfo["kind"]) {
  if (!workflow?.enabled) return false;
  if (kind === "analysis") return round === 1;
  if (kind === "election") return round === workflow.phaseMachine.transitionRules.election.startRound;
  if (kind === "deliberation") return round === getWorkflowEarliestDeliberationRound(workflow);
  return round === getWorkflowEarliestFinalizationRound(workflow);
}

function parseDownloadFileName(header: string | null, fallbackDebateId: string) {
  return header?.match(/filename=\"([^\"]+)\"/i)?.[1] ?? `debate-${fallbackDebateId}-files.zip`;
}

async function readDownloadBlobWithProgress(
  response: Response,
  onProgress: (progress: AllFilesDownloadProgress) => void
) {
  const totalBytesHeader = Number(response.headers.get("content-length"));
  const totalBytes = Number.isFinite(totalBytesHeader) && totalBytesHeader > 0 ? totalBytesHeader : null;
  const reader = response.body?.getReader();

  if (!reader) {
    const blob = await response.blob();
    onProgress({ loadedBytes: blob.size, totalBytes: totalBytes ?? blob.size });
    return blob;
  }

  const chunks: Uint8Array[] = [];
  let loadedBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(value);
    loadedBytes += value.byteLength;
    onProgress({ loadedBytes, totalBytes });
  }

  const blob = new Blob(chunks, { type: "application/zip" });
  onProgress({ loadedBytes: loadedBytes || blob.size, totalBytes: totalBytes ?? blob.size });
  return blob;
}

async function fetchAllFileInfoPayload(input: {
  debateId: string;
  meta: AllFilesMeta;
}) {
  const response = await fetch(`/api/debates/${input.debateId}/file-info`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      input.meta.scope === "debate"
        ? { scope: "debate", path: input.meta.path }
        : { scope: "agent", debateAgentId: input.meta.debateAgentId, path: input.meta.path }
    )
  });
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

function buildAllFilesMetaByVirtualPath(items: unknown[]) {
  const next: Record<string, AllFilesMeta> = {};

  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    const scope = entry.scope === "agent" ? "agent" : "debate";
    const path = String(entry.path ?? "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
    if (!path) continue;

    if (scope === "debate") {
      next[`debate/${path}`] = { scope: "debate", path };
      continue;
    }

    const debateAgentId = String(entry.debateAgentId ?? "").trim();
    if (!debateAgentId) continue;
    const agentName = String(entry.agentName ?? "Unknown").trim() || "Unknown";
    const turnOrderRaw = Number(entry.turnOrder);
    const seatNumber = Number.isFinite(turnOrderRaw) && turnOrderRaw > 0 ? Math.floor(turnOrderRaw) : null;
    const seat = seatNumber ? `Seat-${seatNumber}` : "Seat-?";
    const folderName = `${seat} ${agentName} (${debateAgentId.slice(0, 4)})`;
    next[`agents/${folderName}/${path}`] = { scope: "agent", debateAgentId, seat, agentName, path };
  }

  return next;
}

function computeNextAllFilesSelection(input: {
  path: string;
  anchor: string;
  visiblePaths: string[];
  selectedPaths: string[];
  mode: "click" | "contextmenu";
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}) {
  const extend = input.ctrlKey || input.metaKey;
  const selectedPathSet = new Set(input.selectedPaths);

  if (input.mode === "contextmenu" && selectedPathSet.has(input.path)) {
    return { selectedPaths: input.selectedPaths, anchor: input.path };
  }

  let nextSelectedPaths: string[] = [input.path];
  if (input.shiftKey) {
    const anchor =
      input.anchor && input.visiblePaths.includes(input.anchor) ? input.anchor : input.path;
    const start = input.visiblePaths.indexOf(anchor);
    const end = input.visiblePaths.indexOf(input.path);
    if (start >= 0 && end >= 0) {
      const [from, to] = start <= end ? [start, end] : [end, start];
      const range = input.visiblePaths.slice(from, to + 1);
      nextSelectedPaths = extend ? Array.from(new Set([...input.selectedPaths, ...range])) : range;
    }
  } else if (extend) {
    nextSelectedPaths = selectedPathSet.has(input.path)
      ? input.selectedPaths.filter((item) => item !== input.path)
      : [...input.selectedPaths, input.path];
  }

  if (nextSelectedPaths.length === 0) nextSelectedPaths = [input.path];
  return { selectedPaths: nextSelectedPaths, anchor: input.path };
}

function UsageBar({ ratio }: { ratio: number | null }) {
  const pct = ratio === null ? null : Math.max(0, Math.min(100, Math.round(ratio * 100)));
  const color =
    pct === null
      ? "rgba(148, 163, 184, 0.65)"
      : pct < 55
        ? "rgba(34, 197, 94, 0.95)"
        : pct < 80
          ? "rgba(245, 158, 11, 0.95)"
          : "rgba(239, 68, 68, 0.95)";

  return (
    <span className="row" style={{ gap: 8, alignItems: "center" }}>
      <span
        aria-hidden="true"
        style={{
          width: 120,
          height: 8,
          borderRadius: 999,
          background: "rgba(148, 163, 184, 0.22)",
          overflow: "hidden"
        }}
      >
        <span
          style={{
            display: "block",
            height: "100%",
            width: pct === null ? "0%" : `${pct}%`,
            background: color
          }}
        />
      </span>
      <span className="muted" style={{ minWidth: 64, textAlign: "right" }}>
        {pct === null ? "未统计" : `${pct}%`}
      </span>
    </span>
  );
}

const AllFilesTreeRow = memo(
  function AllFilesTreeRow(props: {
    node: NodeApi<FsNode>;
    style: CSSProperties;
    activeVirtualPath: string;
    selectedVirtualPaths: ReadonlySet<string>;
    actionsRef: MutableRefObject<{
      openVirtualPath: (virtualPath: string) => void;
      clickVirtualPath: (node: NodeApi<FsNode>, event: ReactMouseEvent<HTMLDivElement>) => void;
      openContextMenu: (node: NodeApi<FsNode>, event: ReactMouseEvent<HTMLDivElement>) => void;
    }>;
  }) {
    const { node, style, activeVirtualPath, selectedVirtualPaths, actionsRef } = props;
    const data = node.data;
    const isDir = data.type === "dir";
    const isActive = data.path === activeVirtualPath;
    const isSelected = selectedVirtualPaths.has(data.path);

    return (
      <div
        style={style}
        className={`treeRow ${isActive || isSelected ? "treeItemActive" : ""}`}
        onClick={(event) => actionsRef.current.clickVirtualPath(node, event)}
        onContextMenu={(event) => actionsRef.current.openContextMenu(node, event)}
      >
        {isDir ? (
          <span className="treeIcon" aria-hidden="true">
            {node.isOpen ? "▾" : "▸"}
          </span>
        ) : (
          <span className="treeIcon treeIconFile" aria-hidden="true" />
        )}
        <span className={`treeLabel ${isDir ? "treeDirLabel" : ""}`}>{isDir ? `${data.name}/` : data.name}</span>
      </div>
    );
  },
  (a, b) => {
    if (a.activeVirtualPath !== b.activeVirtualPath) return false;
    if (a.node.id !== b.node.id) return false;
    if (a.node.isOpen !== b.node.isOpen) return false;
    const at = a.style.transform ?? a.style.top;
    const bt = b.style.transform ?? b.style.top;
    return at === bt;
  }
);

function FileInfoDialog(props: {
  open: boolean;
  loading: boolean;
  info: AllFileInfoState | null;
  onClose: () => void;
}) {
  if (!props.open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={props.onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15, 23, 42, 0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        zIndex: 1001
      }}
    >
      <div className="panel stack" onClick={(event) => event.stopPropagation()} style={{ width: "min(560px, 100%)" }}>
        <div className="row" style={{ justifyContent: "space-between", gap: 8 }}>
          <strong>文件信息</strong>
          <button className="btn" type="button" onClick={props.onClose}>
            关闭
          </button>
        </div>
        {props.loading ? (
          <div className="muted">读取中...</div>
        ) : props.info ? (
          <div className="stack" style={{ gap: 10 }}>
            <div className="panel">
              <div className="muted" style={{ marginBottom: 6 }}>
                路径
              </div>
              <div style={{ wordBreak: "break-all" }}>{props.info.displayPath}</div>
            </div>
            <div className="grid grid-2" style={{ gap: 10 }}>
              <div className="panel stack" style={{ gap: 6 }}>
                <span className="muted">字数</span>
                <strong>{props.info.charCount.toLocaleString()}</strong>
              </div>
              <div className="panel stack" style={{ gap: 6 }}>
                <span className="muted">大小</span>
                <strong>{props.info.byteSize.toLocaleString()} bytes</strong>
              </div>
              <div className="panel stack" style={{ gap: 6 }}>
                <span className="muted">创建时间</span>
                <strong>{props.info.createdAt ? new Date(props.info.createdAt).toLocaleString() : "-"}</strong>
              </div>
              <div className="panel stack" style={{ gap: 6 }}>
                <span className="muted">修改时间</span>
                <strong>{props.info.updatedAt ? new Date(props.info.updatedAt).toLocaleString() : "-"}</strong>
              </div>
            </div>
          </div>
        ) : (
          <div className="muted">暂无可显示的信息</div>
        )}
      </div>
    </div>
  );
}

function DownloadProgressDialog(props: {
  progress: AllFilesDownloadProgress | null;
  progressPct: number | null;
}) {
  if (!props.progress) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15, 23, 42, 0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        zIndex: 1001
      }}
    >
      <div className="panel stack" style={{ width: "min(520px, 100%)", gap: 12 }}>
        <div className="row" style={{ justifyContent: "space-between", gap: 8 }}>
          <strong style={{ fontSize: 14 }}>下载进度</strong>
          <span className="muted">
            {formatBytes(props.progress.loadedBytes)}
            {props.progress.totalBytes ? ` / ${formatBytes(props.progress.totalBytes)}` : ""}
            {props.progressPct !== null ? ` · ${props.progressPct}%` : " · 准备中..."}
          </span>
        </div>
        <div
          style={{
            width: "100%",
            height: 12,
            borderRadius: 999,
            overflow: "hidden",
            background: "rgba(148, 163, 184, 0.18)"
          }}
        >
          <div
            className={props.progressPct === null ? "downloadProgressBarIndeterminate" : ""}
            style={{
              height: "100%",
              width: props.progressPct === null ? "35%" : `${props.progressPct}%`,
              borderRadius: 999,
              background:
                "linear-gradient(90deg, rgba(37, 99, 235, 0.85), rgba(59, 130, 246, 0.95), rgba(96, 165, 250, 0.9))"
            }}
          />
        </div>
        <div className="muted">文件准备完成后会自动开始浏览器下载。</div>
      </div>
    </div>
  );
}

function WorkflowRulesPanel(props: {
  markdown: string;
  loading: boolean;
  onRefresh: () => void;
}) {
  return (
    <div className="panel stack">
      <div className="row" style={{ justifyContent: "space-between", gap: 8 }}>
        <strong style={{ fontSize: 14 }}>Workflow 规则</strong>
        <button className="btn" type="button" disabled={props.loading} onClick={props.onRefresh}>
          刷新
        </button>
      </div>
      <MarkdownView className="md-compact" value={props.markdown || "**Workflow 规则**\n\n- 读取中..."} />
    </div>
  );
}

function DebateFilesToolbar(props: {
  selectedCount: number;
  downloading: boolean;
  loading: boolean;
  onDownload: () => void;
  onRefresh: () => void;
}) {
  return (
    <div className="row" style={{ justifyContent: "space-between", gap: 8 }}>
      <strong>辩论文件</strong>
      <div className="row" style={{ gap: 8 }}>
        <button
          className="btn"
          type="button"
          disabled={props.selectedCount === 0 || props.downloading}
          onClick={props.onDownload}
        >
          {props.downloading ? "下载中..." : `下载选中${props.selectedCount > 0 ? `（${props.selectedCount}）` : ""}`}
        </button>
        <button className="btn" type="button" disabled={props.loading} onClick={props.onRefresh}>
          刷新
        </button>
      </div>
    </div>
  );
}

function DebateFilesContextMenu(props: {
  menu: AllFilesContextMenuValue | null;
  selectedCount: number;
  downloading: boolean;
  onClose: () => void;
  onOpenFileInfo: (virtualPath: string) => void;
  onDownload: () => void;
}) {
  if (!props.menu) return null;

  const canOpenFileInfo = props.menu.target.type === "node" && props.menu.target.nodeType === "file";

  return (
    <div className="contextOverlay" onClick={props.onClose}>
      <div
        className="contextMenu"
        style={{ left: props.menu.x, top: props.menu.y }}
        onClick={(event) => event.stopPropagation()}
      >
        <button
          className="contextMenuItem"
          type="button"
          disabled={!canOpenFileInfo}
          onClick={() => {
            if (!canOpenFileInfo) return;
            props.onOpenFileInfo(props.menu.target.path);
          }}
        >
          获取文件信息
        </button>
        <button
          className="contextMenuItem"
          type="button"
          disabled={props.selectedCount === 0 || props.downloading}
          onClick={props.onDownload}
        >
          {props.downloading
            ? "下载中..."
            : props.selectedCount > 0
              ? `下载选中项（${props.selectedCount}）`
              : "下载选中项"}
        </button>
      </div>
    </div>
  );
}

function DebateFilesPanel(props: {
  selectedCount: number;
  downloading: boolean;
  loading: boolean;
  hasFiles: boolean;
  tree: FsNode[];
  renderNode: (props: { node: NodeApi<FsNode>; style: CSSProperties }) => JSX.Element;
  contextMenu: AllFilesContextMenuValue | null;
  onDownload: () => void;
  onRefresh: () => void;
  onRootContextMenu: (event: ReactMouseEvent<HTMLDivElement>) => void;
  onCloseContextMenu: () => void;
  onOpenFileInfo: (virtualPath: string) => void;
}) {
  return (
    <div className="panel stack">
      <DebateFilesToolbar
        selectedCount={props.selectedCount}
        downloading={props.downloading}
        loading={props.loading}
        onDownload={props.onDownload}
        onRefresh={props.onRefresh}
      />
      {props.loading ? (
        <div className="muted">读取中...</div>
      ) : !props.hasFiles ? (
        <div className="muted">暂无文件（通常需要至少一轮发言后才会逐步生成）。</div>
      ) : (
        <div className="treeRoot" style={{ maxHeight: "calc(100vh - 260px)" }} onContextMenu={props.onRootContextMenu}>
          <Tree<FsNode> data={props.tree} width="100%" height={560} indent={18} rowHeight={34} openByDefault={false}>
            {props.renderNode}
          </Tree>
        </div>
      )}
      <DebateFilesContextMenu
        menu={props.contextMenu}
        selectedCount={props.selectedCount}
        downloading={props.downloading}
        onClose={props.onCloseContextMenu}
        onOpenFileInfo={props.onOpenFileInfo}
        onDownload={props.onDownload}
      />
    </div>
  );
}

function ParticipantsPanel(props: {
  canAddAgent: boolean;
  agentCount: number;
  availableAgents: Agent[];
  newAgentId: string;
  isAddingAgent: boolean;
  isOwner: boolean;
  debateStatus: string;
  agents: DebateAgent[];
  resettingUsageByDebateAgentId: Record<string, boolean>;
  contextTotalsByDebateAgentId: Record<
    string,
    {
      sessionPromptTokens: number;
      contextLength: number | null;
      ratio: number | null;
      sessionId?: number;
    }
  >;
  onChangeNewAgentId: (value: string) => void;
  onAddAgent: () => void;
  onResetUsageSession: (debateAgentId: string) => void;
}) {
  return (
    <Fragment>
      {props.canAddAgent ? (
        <div className="panel">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <strong>加入新的 AI（会排在最后）</strong>
            <span className="muted">当前 {props.agentCount}</span>
          </div>
          <div className="stack" style={{ gap: 10 }}>
            <div style={{ width: "100%", minWidth: 0, maxWidth: "100%", overflow: "hidden" }}>
              <select
                value={props.newAgentId}
                onChange={(event) => props.onChangeNewAgentId(event.target.value)}
                style={{
                  width: "100%",
                  minWidth: 0,
                  maxWidth: "100%",
                  display: "block",
                  boxSizing: "border-box"
                }}
              >
                <option value="">选择一个 AI 配置</option>
                {props.availableAgents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name} · {agent.provider} · {agent.model}
                  </option>
                ))}
              </select>
            </div>
            <button
              className="btn btn-primary"
              disabled={!props.newAgentId || props.isAddingAgent}
              onClick={props.onAddAgent}
              style={{ alignSelf: "flex-start" }}
            >
              加入
            </button>
          </div>
          <div className="muted">仅支持进行中/暂停中的辩论加入。</div>
        </div>
      ) : null}
      {props.isOwner ? (
        <div className="panel">
          <strong>上下文累计</strong>
          <div className="muted">本段累计：按“本段（新会话/新 segment）开始后”的 prompt tokens 增量计算，最多 100%。</div>
        </div>
      ) : null}
      {props.agents.map((agent) => {
        const totals = props.contextTotalsByDebateAgentId[agent.debateAgentId] ?? null;
        const ratio = typeof totals?.ratio === "number" && Number.isFinite(totals.ratio) ? totals.ratio : null;

        return (
          <div className="panel" key={agent.debateAgentId}>
            <div className="row" style={{ justifyContent: "space-between", gap: 8, alignItems: "flex-start", flexWrap: "wrap" }}>
              <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>
                #{agent.turnOrder} {agent.displayName}
                <span className="muted">
                  {" "}
                  · {agent.name} · 发言 {agent.turnCount}
                </span>
              </span>
              {props.isOwner ? (
                <div className="row" style={{ gap: 6 }}>
                  <button
                    className="btn"
                    type="button"
                    disabled={Boolean(props.resettingUsageByDebateAgentId[agent.debateAgentId])}
                    onClick={() => props.onResetUsageSession(agent.debateAgentId)}
                  >
                    新会话
                  </button>
                </div>
              ) : null}
            </div>
            <div className="stack muted" style={{ gap: 4, marginTop: 8 }}>
              <div>总上下文：{agent.contextLength ? agent.contextLength.toLocaleString() : "未配置"}</div>
              <div>单次最大输入：{agent.maxInputTokens ? agent.maxInputTokens.toLocaleString() : "未配置"}</div>
              <div>单次最大输出：{agent.maxOutputTokens ? agent.maxOutputTokens.toLocaleString() : "未配置"}</div>
            </div>
            {props.isOwner ? (
              <div className="row" style={{ justifyContent: "space-between", gap: 10, marginTop: 8, flexWrap: "wrap", alignItems: "center" }}>
                <span className="muted">
                  本段累计
                  {ratio === null ? " · 等待首轮统计" : ""}
                </span>
                <UsageBar ratio={ratio} />
              </div>
            ) : null}
          </div>
        );
      })}
    </Fragment>
  );
}

function StatusQuestionPanel(props: {
  debate: Debate;
  questionVersion: number | null;
  questionDraft: string;
  questionDirty: boolean;
  isSavingQuestion: boolean;
  onOpenZoom: () => void;
  onOpenHistory: () => void;
  onSave: () => void;
  onChangeDraft: (next: string) => void;
}) {
  const editable = props.debate.isOwner && ["pending", "paused"].includes(props.debate.status);

  return (
    <Fragment>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
        <strong>问题</strong>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn" type="button" onClick={props.onOpenZoom}>
            放大
          </button>
          {props.debate.isOwner ? (
            <button className="btn" type="button" onClick={props.onOpenHistory}>
              {props.questionVersion ? `版本 v${props.questionVersion}` : "版本历史"}
            </button>
          ) : null}
          {editable ? (
            <button className="btn btn-primary" disabled={props.isSavingQuestion || !props.questionDirty} type="button" onClick={props.onSave}>
              {props.isSavingQuestion ? "保存中..." : "保存"}
            </button>
          ) : null}
        </div>
      </div>
      {editable ? (
        <LineNumberTextarea
          value={props.questionDraft}
          onChange={props.onChangeDraft}
          maxLength={50_000}
          height={160}
          readOnly={!props.debate.isOwner}
          baseline={props.debate.question}
        />
      ) : (
        <div className="panel" style={{ whiteSpace: "pre-wrap", maxHeight: 200, overflowY: "auto" }}>
          {props.debate.question}
        </div>
      )}
      {editable ? (
        <div className="row" style={{ justifyContent: "space-between" }}>
          <span className="muted">{props.questionDraft.length.toLocaleString()}/50,000</span>
          <span className="muted">
            {props.debate.status === "pending" ? "开始后需先暂停才能编辑" : "保存后会把 diff 全局通知所有 AI"}
          </span>
        </div>
      ) : null}
    </Fragment>
  );
}

function StatusSummaryPanel(props: {
  debate: Debate;
  agentCount: number;
  completedRounds: number;
  liveAgentName: string;
  liveDisplayRound: number | null;
  liveDisplayMessage: number | null;
  liveStatus: string;
}) {
  return (
    <Fragment>
      {props.debate.status === "running" ? (
        <div className="row" style={{ justifyContent: "space-between" }}>
          <strong>
            当前：{props.liveAgentName || "未知"}
            {props.liveDisplayRound ? ` · 第 ${props.liveDisplayRound} 轮` : ""}
            {props.liveDisplayMessage
              ? (() => {
                  const turnInRound =
                    props.agentCount > 0 ? ((props.liveDisplayMessage - 1) % props.agentCount) + 1 : null;
                  return ` · #${props.liveDisplayMessage}${turnInRound ? `（第 ${turnInRound} 回）` : ""}`;
                })()
              : ""}
          </strong>
          <span className="muted">{props.liveStatus || "运行中"}</span>
        </div>
      ) : null}
      <div className="muted">
        轮次 {props.completedRounds}/{props.debate.maxTurns <= 0 ? "∞" : props.debate.maxTurns} · 参与者 {props.agentCount}
      </div>
      <div className="muted">token {props.debate.tokenUsed}</div>
      <div className="muted">
        共识: {props.debate.consensusReached ? "已达成" : "未达成"}
        {props.debate.consensusSummary
          ? ` · ${props.debate.consensusSummary.leadingSolution} · ${props.debate.consensusSummary.score}`
          : ""}
      </div>
    </Fragment>
  );
}

function LeftTabIcon({ name }: { name: LeftTabIconName }) {
  const baseProps = {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.7,
    strokeLinecap: "round",
    strokeLinejoin: "round"
  } as const;

  if (name === "status") {
    return (
      <svg {...baseProps}>
        <circle cx="12" cy="12" r="8" />
        <path d="M12 8v4" />
        <path d="M12 16h.01" />
      </svg>
    );
  }
  if (name === "participants") {
    return (
      <svg {...baseProps}>
        <circle cx="9" cy="9" r="3" />
        <path d="M4.5 18c0-2.8 2.6-5 5.5-5s5.5 2.2 5.5 5" />
        <circle cx="17" cy="10" r="2.5" />
        <path d="M15.5 18c0-1.8 1.6-3.2 3.5-3.2 1.2 0 2.3.6 3 1.5" />
      </svg>
    );
  }
  if (name === "workflow") {
    return (
      <svg {...baseProps}>
        <rect x="4" y="4" width="6" height="6" rx="1.2" />
        <rect x="14" y="14" width="6" height="6" rx="1.2" />
        <path d="M10 7h4" />
        <path d="M14 7v7" />
      </svg>
    );
  }
  return (
    <svg {...baseProps}>
      <path d="M6 5h9l3 3v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z" />
      <path d="M9 9h6" />
      <path d="M9 13h6" />
      <path d="M9 17h4" />
    </svg>
  );
}

type OfficialVoteClosed =
  | {
      status: "closed";
      kind: "election";
      roundNumber: number;
      title: string;
      result: {
        ballots: Array<{
          debateAgentId: string;
          voter: string;
          voterSeat?: string;
          selections: Record<string, string>;
          reason?: string;
          at: string;
        }>;
        roles: string[];
        roleCounts: Record<string, Record<string, number>>;
        winners: Record<string, string | null>;
      };
      closedAt: string;
      createdAt: string;
    }
  | {
      status: "closed";
      kind: "custom";
      roundNumber: number;
      title: string;
      prompt: string;
      result: {
        ballots: Array<{
          debateAgentId: string;
          voter: string;
          voterSeat?: string;
          choice: string;
          reason?: string;
          at: string;
        }>;
        counts: Record<string, number>;
        winner: string | null;
      };
      closedAt: string;
      createdAt: string;
    };

type OfficialVoteOpenState = {
  status: "open";
  kind: "election" | "custom";
  roundNumber: number;
  title: string;
  tieRound: number;
};

type GenerationDiagnosticEntry = {
  at: string;
  turnNumber: number;
  roundNumber: number;
  debateAgentId: string;
  seatNumber: number | null;
  agentName: string;
  provider: string;
  model: string;
  requestedMaxTokens: number;
  finishReason: string | null;
  toolCallsCount: number;
  rawChars: number;
  persistedChars: number;
  parseStatus: string;
  structuredOutput: boolean;
  voteOnlyOverride: boolean;
};

type GenerationDiagnosticSummary = {
  title: string;
  tone: "good" | "warn" | "danger";
  conclusion: string;
  evidence: string[];
};

function summarizeGenerationDiagnostic(entry: GenerationDiagnosticEntry): GenerationDiagnosticSummary {
  const finishReason = (entry.finishReason ?? "").toLowerCase();
  const rawChars = Number.isFinite(entry.rawChars) ? entry.rawChars : 0;
  const persistedChars = Number.isFinite(entry.persistedChars) ? entry.persistedChars : 0;
  const evidence: string[] = [];

  if (entry.voteOnlyOverride) {
    evidence.push("当前轮是选举投票轮，业务逻辑会把正文统一替换成固定投票内容。");
    if (rawChars > 0 || persistedChars > 0) {
      evidence.push(`原始正文 ${rawChars} 字，最终落库 ${persistedChars} 字。`);
    }
    if (entry.finishReason) {
      evidence.push(`模型停止原因：${entry.finishReason}。`);
    }
    return {
      title: "业务逻辑覆盖",
      tone: "warn",
      conclusion: "这条发言不是页面截断，而是被投票轮的业务规则覆盖成固定内容。",
      evidence
    };
  }

  if (
    finishReason === "length" ||
    finishReason === "max_tokens" ||
    finishReason === "max_output_tokens" ||
    finishReason === "model_length" ||
    finishReason === "model_context_window_exceeded" ||
    finishReason === "output_limit"
  ) {
    evidence.push(`模型停止原因是 ${entry.finishReason ?? "length"}。`);
    evidence.push(`本轮请求的输出上限是 ${entry.requestedMaxTokens} tokens。`);
    evidence.push(`原始正文 ${rawChars} 字，最终落库 ${persistedChars} 字。`);
    return {
      title: "平台截断",
      tone: "danger",
      conclusion: "这条正文更像是被模型平台的单次输出上限截断了，而不是前端少显示。",
      evidence
    };
  }

  if (
    entry.toolCallsCount > 0 ||
    finishReason === "tool_calls" ||
    finishReason === "function_call"
  ) {
    evidence.push(`本轮触发了 ${entry.toolCallsCount} 次工具调用。`);
    if (entry.finishReason) {
      evidence.push(`模型停止原因：${entry.finishReason}。`);
    }
    evidence.push(`原始正文 ${rawChars} 字，最终落库 ${persistedChars} 字。`);
    return {
      title: "工具打断",
      tone: "warn",
      conclusion: "这条输出更像是在准备或触发工具调用时结束，正文不完整主要是工具流程中断了自然续写。",
      evidence
    };
  }

  if (persistedChars < rawChars) {
    evidence.push(`原始正文 ${rawChars} 字，最终落库 ${persistedChars} 字，说明落库前被重新整理过。`);
    if (entry.structuredOutput && entry.parseStatus === "ok") {
      evidence.push("本轮命中了结构化解析，正文可能被整理成更短的结构化结果。");
    } else {
      evidence.push("没有发现投票覆盖或工具调用，更像是业务侧对正文做了整理/裁剪。");
    }
    return {
      title: "业务侧改写",
      tone: "warn",
      conclusion: "原始生成比最终看到的更长，这条内容更像是落库前被业务逻辑整理过。",
      evidence
    };
  }

  evidence.push(`模型停止原因：${entry.finishReason ?? "未提供"}。`);
  evidence.push(`原始正文 ${rawChars} 字，最终落库 ${persistedChars} 字。`);
  if (entry.structuredOutput && entry.parseStatus === "ok") {
    evidence.push("本轮结构化解析正常完成。");
  }
  return {
    title: "正常结束",
    tone: "good",
    conclusion: "这条发言更像是模型正常收尾，不像平台截断、工具打断或业务覆盖。",
    evidence
  };
}

function LineNumberTextarea(props: {
  value: string;
  onChange: (next: string) => void;
  baseline?: string | null;
  readOnly?: boolean;
  autoFocus?: boolean;
  maxLength?: number;
  height: number | string;
}) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const gutterRef = useRef<HTMLDivElement | null>(null);
  const [lineCount, setLineCount] = useState(1);

  useEffect(() => {
    const next = props.value ? props.value.replace(/\r\n/g, "\n").split("\n").length : 1;
    setLineCount(Math.max(1, next));
  }, [props.value]);

  const markers = useMemo(() => {
    if (props.baseline === undefined || props.baseline === null) return [];
    const oldLines = props.baseline.replace(/\r\n/g, "\n").split("\n");
    const newLines = props.value.replace(/\r\n/g, "\n").split("\n");

    // Fast path: exact match
    if (oldLines.length === newLines.length) {
      let same = true;
      for (let i = 0; i < oldLines.length; i += 1) {
        if (oldLines[i] !== newLines[i]) {
          same = false;
          break;
        }
      }
      if (same) return [];
    }

    // Shrink by common prefix/suffix to make diff stable and cheap.
    let prefix = 0;
    while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
      prefix += 1;
    }
    let suffix = 0;
    while (
      suffix < oldLines.length - prefix &&
      suffix < newLines.length - prefix &&
      oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
    ) {
      suffix += 1;
    }

    const oldMid = oldLines.slice(prefix, oldLines.length - suffix);
    const newMid = newLines.slice(prefix, newLines.length - suffix);

    const out: Array<{ add?: boolean; del?: boolean; change?: boolean } | null> = Array.from(
      { length: newLines.length },
      () => null
    );

    // Guard: if the middle block is too large, fallback to simple block marking.
    const MAX_CELLS = 1_500_000;
    if (oldMid.length * newMid.length > MAX_CELLS) {
      // Mark the entire middle as changed/add and attach deletion marker near the start.
      for (let i = 0; i < newMid.length; i += 1) {
        const idx = prefix + i;
        out[idx] = { change: true };
      }
      if (oldMid.length > newMid.length) {
        const target = Math.min(prefix + newMid.length, Math.max(0, newLines.length - 1));
        out[target] = { ...(out[target] ?? {}), del: true };
      }
      if (newMid.length > oldMid.length) {
        for (let i = prefix + oldMid.length; i < prefix + newMid.length; i += 1) {
          out[i] = { ...(out[i] ?? {}), add: true };
        }
      }
      return out;
    }

    // Stable line-level alignment using Levenshtein with substitution (change) cost=1.
    const n = oldMid.length;
    const m = newMid.length;
    const dirs = new Uint8Array((n + 1) * (m + 1));
    const idx = (i: number, j: number) => i * (m + 1) + j;

    const costs = new Uint32Array(m + 1);
    for (let j = 0; j <= m; j += 1) {
      costs[j] = j;
      if (j > 0) dirs[idx(0, j)] = 2; // insert
    }
    for (let i = 1; i <= n; i += 1) {
      let prevDiag = costs[0];
      costs[0] = i;
      dirs[idx(i, 0)] = 1; // delete
      for (let j = 1; j <= m; j += 1) {
        const up = (costs[j] + 1) >>> 0;
        const left = (costs[j - 1] + 1) >>> 0;
        const subCost = oldMid[i - 1] === newMid[j - 1] ? 0 : 1;
        const diag = (prevDiag + subCost) >>> 0;

        let best = diag;
        let dir: 0 | 1 | 2 = 0;
        if (up < best) {
          best = up;
          dir = 1;
        }
        if (left < best) {
          best = left;
          dir = 2;
        }

        prevDiag = costs[j];
        costs[j] = best;
        dirs[idx(i, j)] = dir;
      }
    }

    // Backtrack to produce markers.
    let i = n;
    let j = m;
    let pendingDel = 0;
    while (i > 0 || j > 0) {
      const dir = dirs[idx(i, j)];
      if (i > 0 && j > 0 && dir === 0) {
        const sameLine = oldMid[i - 1] === newMid[j - 1];
        if (!sameLine) {
          out[prefix + (j - 1)] = { ...(out[prefix + (j - 1)] ?? {}), change: true };
        }
        if (pendingDel > 0 && !sameLine) {
          out[prefix + (j - 1)] = { ...(out[prefix + (j - 1)] ?? {}), del: true };
          pendingDel = 0;
        }
        i -= 1;
        j -= 1;
      } else if (i > 0 && (j === 0 || dir === 1)) {
        pendingDel += 1;
        i -= 1;
      } else {
        // insert
        if (pendingDel > 0) {
          out[prefix + (j - 1)] = { ...(out[prefix + (j - 1)] ?? {}), change: true };
          pendingDel = 0;
        } else {
          out[prefix + (j - 1)] = { ...(out[prefix + (j - 1)] ?? {}), add: true };
        }
        j -= 1;
      }
    }

    if (pendingDel > 0) {
      const target = Math.min(prefix, Math.max(0, newLines.length - 1));
      out[target] = { ...(out[target] ?? {}), del: true };
    }

    return out;
  }, [props.baseline, props.value]);

  function syncScroll() {
    const textarea = textareaRef.current;
    const gutter = gutterRef.current;
    if (!textarea || !gutter) return;
    gutter.scrollTop = textarea.scrollTop;
  }

  return (
    <div
      className="panel"
      style={{
        display: "grid",
        gridTemplateColumns: "64px 1fr",
        padding: 0,
        overflow: "hidden",
        height: props.height
      }}
    >
      <div
        ref={gutterRef}
        className="muted"
        style={{
          padding: "10px 8px",
          borderRight: "1px solid var(--line)",
          overflow: "hidden",
          userSelect: "none",
          fontFamily:
            "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
          fontSize: 12,
          lineHeight: "20px",
          textAlign: "right",
          background: "rgba(15, 23, 42, 0.02)"
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
          {Array.from({ length: lineCount }, (_, index) => {
            const marker = markers[index];
            const hasMarker = Boolean(marker?.add || marker?.del || marker?.change);
            const chipBg = marker?.add
              ? "rgba(22, 163, 74, 0.22)"
              : marker?.del
                ? "rgba(220, 38, 38, 0.22)"
                : marker?.change
                  ? "rgba(37, 99, 235, 0.18)"
                  : "transparent";

            return (
              <div
                key={index}
                style={{
                  display: "flex",
                  justifyContent: "flex-end",
                  alignItems: "center",
                  height: 20
                }}
              >
                <span
                  style={{
                    display: "inline-flex",
                    justifyContent: "flex-end",
                    minWidth: 44,
                    padding: "0 6px",
                    borderRadius: 6,
                    background: hasMarker ? chipBg : "transparent"
                  }}
                >
                  {index + 1}
                </span>
              </div>
            );
          })}
        </div>
      </div>
      <textarea
        ref={textareaRef}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        readOnly={props.readOnly}
        autoFocus={props.autoFocus}
        maxLength={props.maxLength}
        onScroll={syncScroll}
        style={{
          width: "100%",
          height: "100%",
          padding: "10px 12px",
          border: "none",
          borderRadius: 0,
          resize: "none",
          overflowY: "auto",
          outline: "none",
          fontFamily:
            "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
          fontSize: 12,
          lineHeight: "20px"
        }}
      />
    </div>
  );
}

export default function DebateDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const [leftTab, setLeftTab] = useState<LeftTab>("status");
  const [debate, setDebate] = useState<Debate | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [newAgentId, setNewAgentId] = useState<string>("");
  const [isAddingAgent, setIsAddingAgent] = useState(false);
  const [questionZoomOpen, setQuestionZoomOpen] = useState(false);
  const [questionDraft, setQuestionDraft] = useState("");
  const [questionDirty, setQuestionDirty] = useState(false);
  const [isSavingQuestion, setIsSavingQuestion] = useState(false);
  const [questionVersion, setQuestionVersion] = useState<number | null>(null);
  const [questionHistoryOpen, setQuestionHistoryOpen] = useState(false);
  const [questionHistoryLoading, setQuestionHistoryLoading] = useState(false);
  const [questionHistoryError, setQuestionHistoryError] = useState<string>("");
  const [questionHistory, setQuestionHistory] = useState<Array<{ version: number; path: string; at: string }>>([]);
  const [diffFromVersion, setDiffFromVersion] = useState<number | null>(null);
  const [diffToVersion, setDiffToVersion] = useState<number | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffRows, setDiffRows] = useState<
    Array<
      | { kind: "skip"; leftSkip: number; rightSkip: number }
      | {
          kind: "row";
          type: "same" | "add" | "del" | "change";
          leftNo: number | null;
          rightNo: number | null;
          leftText: string;
          rightText: string;
        }
    >
  >([]);
  const [saveSuccessOpen, setSaveSuccessOpen] = useState(false);
  const [saveSuccessVersion, setSaveSuccessVersion] = useState<number | null>(null);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [memoryTitle, setMemoryTitle] = useState("");
  const [memoryPath, setMemoryPath] = useState("");
  const [memoryUpdatedAt, setMemoryUpdatedAt] = useState<string>("");
  const [memoryContent, setMemoryContent] = useState("");
  const [memoryLoading, setMemoryLoading] = useState(false);
  const [memoryTarget, setMemoryTarget] = useState<
    | null
    | { scope: "debate"; path: string }
    | { scope: "agent"; debateAgentId: string; path: string }
  >(null);
  const [memoryTail, setMemoryTail] = useState(false);
  const [memoryMaxChars, setMemoryMaxChars] = useState<number | null>(null);
  const [memoryTruncation, setMemoryTruncation] = useState<{
    truncated: boolean;
    totalChars: number;
    shownChars: number;
    slice: "head" | "tail" | "full";
  } | null>(null);
  const memoryContentRef = useRef<HTMLDivElement | null>(null);
  const [diagnosticsDialog, setDiagnosticsDialog] = useState<{
    turnNumber: number;
    entry: GenerationDiagnosticEntry | null;
    loading: boolean;
  } | null>(null);
  const [allFilesLoading, setAllFilesLoading] = useState(false);
  const [allFilesMetaByVirtualPath, setAllFilesMetaByVirtualPath] = useState<
    Record<string, AllFilesMeta>
  >({});
  const [activeAllFileVirtualPath, setActiveAllFileVirtualPath] = useState("");
  const [selectedAllFileVirtualPaths, setSelectedAllFileVirtualPaths] = useState<string[]>([]);
  const [allFilesSelectionAnchor, setAllFilesSelectionAnchor] = useState("");
  const [allFilesContextMenu, setAllFilesContextMenu] = useState<AllFilesContextMenuState>(null);
  const [allFilesDownloading, setAllFilesDownloading] = useState(false);
  const [allFilesDownloadProgress, setAllFilesDownloadProgress] = useState<AllFilesDownloadProgress | null>(null);
  const [allFileInfoOpen, setAllFileInfoOpen] = useState(false);
  const [allFileInfoLoading, setAllFileInfoLoading] = useState(false);
  const [allFileInfo, setAllFileInfo] = useState<AllFileInfoState | null>(null);
  const allFilesLoadedRef = useRef(false);
  const [liveRoundNumber, setLiveRoundNumber] = useState<number | null>(null);
  const [liveMessageNumber, setLiveMessageNumber] = useState<number | null>(null);
  const [liveAgentName, setLiveAgentName] = useState<string>("");
  const [liveStatus, setLiveStatus] = useState<string>("");
  const [liveText, setLiveText] = useState<string>("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [activeTurnId, setActiveTurnId] = useState<string>("");
  const [activeVoteRound, setActiveVoteRound] = useState<number | null>(null);
  const [followLatest, setFollowLatest] = useState(false);
  const viewerScrollRef = useRef<HTMLDivElement | null>(null);
  const [isReorderingSeats, setIsReorderingSeats] = useState(false);
  const [votePathsByRound, setVotePathsByRound] = useState<Record<number, string>>({});
  const [voteByRound, setVoteByRound] = useState<Record<number, OfficialVoteClosed>>({});
  const [openVoteState, setOpenVoteState] = useState<OfficialVoteOpenState | null>(null);
  const [voteLoadingRound, setVoteLoadingRound] = useState<number | null>(null);
  const [openRoundsByNumber, setOpenRoundsByNumber] = useState<Record<number, boolean>>({});
  const [workflowRulesState, setWorkflowRulesState] = useState<WorkflowRulesState>({ markdown: "", loading: false });
  const [workflowConfig, setWorkflowConfig] = useState<NormalizedDebateWorkflow | null>(null);
  const [injectedPromptDialog, setInjectedPromptDialog] = useState<null | {
    round: number;
    phaseTitle: string;
    prompt: string;
  }>(null);
  const lastLoadErrorAtRef = useRef(0);
  const lastVoteIndexAtRef = useRef(0);
  const lastContextUsageAtRef = useRef(0);
  const activeDebateIdRef = useRef<string>("");
  const loadingDebateIdRef = useRef<string | null>(null);
  const lastTurnNumberRef = useRef(0);
  const { toast, showToast } = useAutoDismissToast(1200);
  const preWrapStyle = useMemo(
    () =>
      ({
        margin: 0,
        whiteSpace: "pre-wrap",
        overflowWrap: "anywhere",
        wordBreak: "break-word"
      }) as const,
    []
  );
  const [contextUsageByDebateAgentId, setContextUsageByDebateAgentId] = useState<
    Record<
      string,
      {
        promptTokens: number;
        contextLength: number | null;
        ratio: number | null;
        source?: "api" | "estimate";
        at: string;
        turnNumber: number;
      }
    >
  >({});
  const [contextTotalsByDebateAgentId, setContextTotalsByDebateAgentId] = useState<
    Record<
      string,
      {
        sessionPromptTokens: number;
        contextLength: number | null;
        ratio: number | null;
        sessionId?: number;
      }
    >
  >({});
  const [resettingUsageByDebateAgentId, setResettingUsageByDebateAgentId] = useState<Record<string, boolean>>({});

  const leftTabStorageKey = useMemo(() => (id ? `debate_left_tab_${id}` : ""), [id]);

  function isLeftTab(value: unknown): value is LeftTab {
    return value === "status" || value === "participants" || value === "workflow" || value === "memory";
  }

  useEffect(() => {
    if (!leftTabStorageKey) return;
    try {
      const raw = window.localStorage.getItem(leftTabStorageKey);
      if (isLeftTab(raw)) setLeftTab(raw);
    } catch {
      // ignore
    }
  }, [leftTabStorageKey]);

  useEffect(() => {
    if (!leftTabStorageKey) return;
    try {
      window.localStorage.setItem(leftTabStorageKey, leftTab);
    } catch {
      // ignore
    }
  }, [leftTabStorageKey, leftTab]);

  async function loadDebate() {
    if (!id) return;
    const expectedId = id;
    if (loadingDebateIdRef.current === expectedId) return;
    loadingDebateIdRef.current = expectedId;
    try {
      const after = lastTurnNumberRef.current;
      const turnsUrl = after > 0 ? `/api/debates/${expectedId}/turns?after=${after}` : `/api/debates/${expectedId}/turns`;
      const [debateResponse, turnsResponse] = await Promise.all([
        fetch(`/api/debates/${expectedId}`, { cache: "no-store" }),
        fetch(turnsUrl, { cache: "no-store" })
      ]);
      const debatePayload = await debateResponse.json().catch(() => ({}));
      const turnsPayload = await turnsResponse.json().catch(() => ({}));

      if (activeDebateIdRef.current && activeDebateIdRef.current !== expectedId) {
        return;
      }

      if (debateResponse.ok) {
        setDebate(debatePayload.data ?? null);
        const now = Date.now();
        if (now - lastVoteIndexAtRef.current > 5000) {
          lastVoteIndexAtRef.current = now;
          void loadVoteIndex();
          void loadOpenVoteState();
        }
        const isOwner = Boolean(debatePayload.data?.isOwner);
        if (isOwner) {
          if (now - lastContextUsageAtRef.current > 1500) {
            lastContextUsageAtRef.current = now;
            void loadContextUsage();
            void loadContextUsageTotals();
          }
        }
      } else {
        const message = debatePayload?.error?.message ?? "加载辩论失败";
        const now = Date.now();
        if (now - lastLoadErrorAtRef.current > 5000) {
          lastLoadErrorAtRef.current = now;
          showToast("error", message);
        }
      }

      if (turnsResponse.ok) {
        const incoming = Array.isArray(turnsPayload.data) ? (turnsPayload.data as Turn[]) : [];
        if (after > 0) {
          if (incoming.length > 0) {
            setTurns((current) => {
              const merged = [...current, ...incoming];
              const last = merged.length ? merged[merged.length - 1] : null;
              lastTurnNumberRef.current = last && typeof last.turnNumber === "number" ? Math.floor(last.turnNumber) : lastTurnNumberRef.current;
              return merged;
            });
          }
        } else {
          setTurns(incoming);
          const last = incoming.length ? incoming[incoming.length - 1] : null;
          lastTurnNumberRef.current = last && typeof last.turnNumber === "number" ? Math.floor(last.turnNumber) : 0;
        }
      }
    } catch (error) {
      console.error(error);
      const now = Date.now();
      if (now - lastLoadErrorAtRef.current > 5000) {
        lastLoadErrorAtRef.current = now;
        showToast("error", "网络错误：加载失败（将自动重试）");
      }
    } finally {
      if (loadingDebateIdRef.current === expectedId) loadingDebateIdRef.current = null;
    }
  }

  async function loadContextUsage() {
    if (!id) return null;
    try {
      const response = await fetch(`/api/debates/${id}/files?path=${encodeURIComponent("context/usage.json")}`, {
        cache: "no-store"
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) return null;

      const content = String(payload.data?.content ?? "");
      let parsed: unknown = null;
      try {
        parsed = content ? JSON.parse(content) : null;
      } catch {
        parsed = null;
      }
      const by =
        parsed && typeof parsed === "object" && (parsed as any).byDebateAgentId && typeof (parsed as any).byDebateAgentId === "object"
          ? (((parsed as any).byDebateAgentId as Record<string, unknown>) ?? {})
          : {};
      const next: typeof contextUsageByDebateAgentId = {};
      for (const [debateAgentId, value] of Object.entries(by)) {
        if (!value || typeof value !== "object") continue;
        const v = value as Record<string, unknown>;
        const promptTokens = Number(v.promptTokens);
        const contextLengthRaw = Number(v.contextLength);
        const contextLength =
          Number.isFinite(contextLengthRaw) && contextLengthRaw > 0 ? Math.floor(contextLengthRaw) : null;
        const ratioRaw = Number(v.ratio);
        const ratio = Number.isFinite(ratioRaw) && ratioRaw >= 0 ? ratioRaw : null;
        const source = v.source === "estimate" ? "estimate" : "api";
        const at = String(v.at ?? "");
        const turnNumber = Number(v.turnNumber);
        if (!Number.isFinite(promptTokens) || promptTokens <= 0) continue;
        next[debateAgentId] = {
          promptTokens: Math.floor(promptTokens),
          contextLength,
          ratio,
          source,
          at,
          turnNumber: Number.isFinite(turnNumber) ? Math.floor(turnNumber) : 0
        };
      }
      setContextUsageByDebateAgentId(next);
      return next;
    } catch {
      return null;
    }
  }

  async function loadContextUsageTotals() {
    if (!id) return null;
    try {
      const response = await fetch(`/api/debates/${id}/files?path=${encodeURIComponent("context/usage_totals.json")}`, {
        cache: "no-store"
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) return null;
      const content = String(payload.data?.content ?? "");
      let parsed: unknown = null;
      try {
        parsed = content ? JSON.parse(content) : null;
      } catch {
        parsed = null;
      }
      const by =
        parsed && typeof parsed === "object" && (parsed as any).byDebateAgentId && typeof (parsed as any).byDebateAgentId === "object"
          ? (((parsed as any).byDebateAgentId as Record<string, unknown>) ?? {})
          : {};
      const next: typeof contextTotalsByDebateAgentId = {};
      for (const [debateAgentId, value] of Object.entries(by)) {
        if (!value || typeof value !== "object") continue;
        const v = value as Record<string, unknown>;
        const sessionPromptTokens = Number((v as any).sessionPromptTokens ?? (v as any).totalPromptTokens);
        const contextLengthRaw = Number(v.contextLength);
        const contextLength =
          Number.isFinite(contextLengthRaw) && contextLengthRaw > 0 ? Math.floor(contextLengthRaw) : null;
        const ratioRaw = Number(v.ratio);
        const ratio = Number.isFinite(ratioRaw) && ratioRaw >= 0 ? ratioRaw : null;
        const sessionId = Number((v as any).sessionId);
        if (!Number.isFinite(sessionPromptTokens) || sessionPromptTokens < 0) continue;
        next[debateAgentId] = {
          sessionPromptTokens: Math.floor(sessionPromptTokens),
          contextLength,
          ratio,
          ...(Number.isFinite(sessionId) && sessionId >= 1 ? { sessionId: Math.floor(sessionId) } : {})
        };
      }
      setContextTotalsByDebateAgentId(next);
      return next;
    } catch {
      return null;
    }
  }

  async function resetAgentUsageSession(debateAgentId: string) {
    if (!id || !debateAgentId) return;
    if (resettingUsageByDebateAgentId[debateAgentId]) return;
    const ok = window.confirm("仅对该席位：重置“本段累计”到 0（开始新的会话累计）。确定吗？");
    if (!ok) return;
    setResettingUsageByDebateAgentId((cur) => ({ ...cur, [debateAgentId]: true }));
    try {
      const response = await fetch(`/api/debates/${id}/context/usage/session/reset`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ debateAgentId })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        showToast("error", payload.error?.message ?? "重置失败");
        return;
      }
      showToast("success", "已开始新会话（该席位）");
      void loadContextUsageTotals();
    } catch (error) {
      console.error(error);
      showToast("error", "网络错误：重置失败");
    } finally {
      setResettingUsageByDebateAgentId((cur) => ({ ...cur, [debateAgentId]: false }));
    }
  }

  async function loadWorkflowRules() {
    if (!id) return null;
    if (workflowRulesState.loading) return null;
    setWorkflowRulesState((current) => ({ ...current, loading: true }));
    try {
      const content = await fetchWorkflowRulesMarkdown(id);
      if (!content) {
        setWorkflowConfig(parseWorkflowConfig(null));
        setWorkflowRulesState({ markdown: formatWorkflowRulesMarkdown("{}"), loading: false });
        return null;
      }
      setWorkflowConfig(parseWorkflowConfig(content));
      setWorkflowRulesState({ markdown: formatWorkflowRulesMarkdown(content), loading: false });
      return content;
    } catch {
      setWorkflowConfig(null);
      setWorkflowRulesState({ markdown: WORKFLOW_RULES_ERROR_MARKDOWN, loading: false });
      return null;
    } finally {
      setWorkflowRulesState((current) => (current.loading ? { ...current, loading: false } : current));
    }
  }

  useEffect(() => {
    if (!id) {
      return;
    }

    activeDebateIdRef.current = id;
    loadingDebateIdRef.current = null;
    lastTurnNumberRef.current = 0;
    lastLoadErrorAtRef.current = 0;
    lastVoteIndexAtRef.current = 0;
    lastContextUsageAtRef.current = 0;
    allFilesLoadedRef.current = false;
    setDebate(null);
    setTurns([]);
    setIsStreaming(false);
    setLiveRoundNumber(null);
    setLiveMessageNumber(null);
    setLiveAgentName("");
    setLiveStatus("");
    setLiveText("");
    setActiveTurnId("");
    setActiveVoteRound(null);
    setVotePathsByRound({});
    setVoteByRound({});
    setOpenVoteState(null);
    setVoteLoadingRound(null);
    setInjectedPromptDialog(null);
    setDiagnosticsDialog(null);
    setContextUsageByDebateAgentId({});
    setContextTotalsByDebateAgentId({});
    setResettingUsageByDebateAgentId({});
    setMemoryOpen(false);
    setMemoryTitle("");
    setMemoryPath("");
    setMemoryUpdatedAt("");
    setMemoryContent("");
    setMemoryLoading(false);
    setMemoryTarget(null);
    setMemoryTail(false);
    setMemoryMaxChars(null);
    setMemoryTruncation(null);
    setAllFilesMetaByVirtualPath({});
    setActiveAllFileVirtualPath("");
    setOpenRoundsByNumber({});
    void loadDebate().catch(() => {});
    void loadQuestionVersionMeta();
    void loadWorkflowRules();
    const timer = setInterval(() => {
      void loadDebate().catch(() => {});
    }, 1500);

    return () => {
      clearInterval(timer);
    };
  }, [id]);

  useEffect(() => {
    if (!id) return;
    if (leftTab !== "memory") return;
    if (!debate?.isOwner) return;
    void loadAllFilesIndex().catch(() => {});
  }, [id, leftTab, debate?.isOwner]);

  async function loadQuestionVersionMeta() {
    if (!id) return null;
    try {
      const response = await fetch(`/api/debates/${id}/files?path=${encodeURIComponent("question/history.json")}`);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setQuestionVersion(null);
        return null;
      }
      const content = String(payload.data?.content ?? "");
      const parsed = JSON.parse(content) as Array<{ version: number }>;
      const last = parsed.length ? parsed[parsed.length - 1] : null;
      const version = last && typeof last.version === "number" ? last.version : null;
      setQuestionVersion(version);
      return version;
    } catch {
      setQuestionVersion(null);
      return null;
    }
  }

  async function loadVoteIndex() {
    if (!id) return;
    try {
      const response = await fetch(`/api/debates/${id}/files?prefix=${encodeURIComponent("votes/round-")}`, {
        cache: "no-store"
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) return;
      const paths = Array.isArray(payload.data) ? (payload.data as unknown[]).map((x) => String(x)) : [];
      const next: Record<number, string> = {};
      for (const path of paths) {
        const normalized = path.replace(/\\/g, "/");
        const match = normalized.match(/^votes\/round-([0-9]{1,6})\.json$/);
        if (!match) continue;
        const round = Number(match[1]);
        if (!Number.isFinite(round)) continue;
        next[round] = normalized;
      }
      setVotePathsByRound(next);
    } catch {
    }
  }

  async function loadOpenVoteState() {
    if (!id) return null;
    try {
      const response = await fetch(`/api/debates/${id}/files?path=${encodeURIComponent("votes/open.json")}`, {
        cache: "no-store"
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setOpenVoteState(null);
        return null;
      }
      const content = String(payload.data?.content ?? "");
      const parsed = JSON.parse(content) as Record<string, unknown>;
      if (parsed?.status !== "open") {
        setOpenVoteState(null);
        return null;
      }
      const roundNumber = Number(parsed.roundNumber);
      const tieRoundRaw =
        parsed.meta && typeof parsed.meta === "object" ? Number((parsed.meta as Record<string, unknown>).tieRound) : 0;
      const next: OfficialVoteOpenState = {
        status: "open",
        kind: parsed.kind === "election" ? "election" : "custom",
        roundNumber: Number.isFinite(roundNumber) && roundNumber > 0 ? Math.floor(roundNumber) : 1,
        title: String(parsed.title ?? "投票"),
        tieRound: Number.isFinite(tieRoundRaw) && tieRoundRaw > 0 ? Math.floor(tieRoundRaw) : 0
      };
      setOpenVoteState(next);
      return next;
    } catch {
      setOpenVoteState(null);
      return null;
    }
  }

  async function loadVoteRound(round: number) {
    if (!id) return null;
    const path = votePathsByRound[round];
    if (!path) return null;
    if (voteLoadingRound === round) return null;
    setVoteLoadingRound(round);
    try {
      const response = await fetch(`/api/debates/${id}/files?path=${encodeURIComponent(path)}`, { cache: "no-store" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) return null;
      const content = String(payload.data?.content ?? "");
      const parsed = JSON.parse(content) as OfficialVoteClosed;
      if (!parsed || typeof parsed !== "object") return null;
      setVoteByRound((current) => ({ ...current, [round]: parsed }));
      return parsed;
    } catch {
      return null;
    } finally {
      setVoteLoadingRound((current) => (current === round ? null : current));
    }
  }

  function buildQuestionCompareRows(oldText: string, newText: string) {
    const oldLines = oldText.replace(/\r\n/g, "\n").split("\n");
    const newLines = newText.replace(/\r\n/g, "\n").split("\n");

    let prefix = 0;
    while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
      prefix += 1;
    }
    let suffix = 0;
    while (
      suffix < oldLines.length - prefix &&
      suffix < newLines.length - prefix &&
      oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
    ) {
      suffix += 1;
    }

    const headOld = oldLines.slice(0, prefix);
    const headNew = newLines.slice(0, prefix);
    const midOld = oldLines.slice(prefix, oldLines.length - suffix);
    const midNew = newLines.slice(prefix, newLines.length - suffix);
    const tailOld = oldLines.slice(oldLines.length - suffix);
    const tailNew = newLines.slice(newLines.length - suffix);

    type Row =
      | { kind: "skip"; leftSkip: number; rightSkip: number }
      | {
          kind: "row";
          type: "same" | "add" | "del" | "change";
          leftNo: number | null;
          rightNo: number | null;
          leftText: string;
          rightText: string;
        };

    const rows: Row[] = [];
    const MAX_CONTEXT = 60;
    const KEEP = 18;

    let oldNo = 1;
    let newNo = 1;

    function pushSameLines(lines: string[]) {
      for (const line of lines) {
        rows.push({
          kind: "row",
          type: "same",
          leftNo: oldNo,
          rightNo: newNo,
          leftText: line,
          rightText: line
        });
        oldNo += 1;
        newNo += 1;
      }
    }

    function pushContext(lines: string[]) {
      if (lines.length <= MAX_CONTEXT) {
        pushSameLines(lines);
        return;
      }
      const head = lines.slice(0, KEEP);
      const tail = lines.slice(lines.length - KEEP);
      pushSameLines(head);
      const skipped = lines.length - head.length - tail.length;
      rows.push({ kind: "skip", leftSkip: skipped, rightSkip: skipped });
      oldNo += skipped;
      newNo += skipped;
      pushSameLines(tail);
    }

    pushContext(headOld);

    const maxMid = Math.max(midOld.length, midNew.length);
    for (let i = 0; i < maxMid; i += 1) {
      const left = midOld[i];
      const right = midNew[i];
      if (typeof left === "string" && typeof right === "string") {
        if (left === right) {
          rows.push({
            kind: "row",
            type: "same",
            leftNo: oldNo,
            rightNo: newNo,
            leftText: left,
            rightText: right
          });
        } else {
          rows.push({
            kind: "row",
            type: "change",
            leftNo: oldNo,
            rightNo: newNo,
            leftText: left,
            rightText: right
          });
        }
        oldNo += 1;
        newNo += 1;
      } else if (typeof left === "string") {
        rows.push({
          kind: "row",
          type: "del",
          leftNo: oldNo,
          rightNo: null,
          leftText: left,
          rightText: ""
        });
        oldNo += 1;
      } else if (typeof right === "string") {
        rows.push({
          kind: "row",
          type: "add",
          leftNo: null,
          rightNo: newNo,
          leftText: "",
          rightText: right
        });
        newNo += 1;
      }
    }

    pushContext(tailOld);
    // ensure symmetry in case of weird split
    void headNew;
    void tailNew;

    return rows;
  }

  async function openQuestionHistory() {
    if (!id) return;
    setQuestionHistoryOpen(true);
    setQuestionHistoryLoading(true);
    setQuestionHistoryError("");
    setQuestionHistory([]);
    setDiffRows([]);
    try {
      const response = await fetch(`/api/debates/${id}/files?path=${encodeURIComponent("question/history.json")}`);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 404 && payload.error?.code === "NOT_FOUND") {
          setQuestionHistoryError("暂无历史版本（第一次保存后会开始记录）。");
          return;
        }
        setQuestionHistoryError(payload.error?.message ?? "加载失败");
        return;
      }
      const content = String(payload.data?.content ?? "");
      const parsed = JSON.parse(content) as Array<{ version: number; path: string; at: string }>;
      const normalized = Array.isArray(parsed)
        ? parsed
            .map((item) => ({
              version: Number(item.version),
              path: String(item.path),
              at: String(item.at ?? "")
            }))
            .filter((item) => Number.isFinite(item.version) && item.version > 0 && item.path)
        : [];
      setQuestionHistory(normalized);
      if (normalized.length >= 2) {
        setDiffFromVersion(normalized[normalized.length - 2].version);
        setDiffToVersion(normalized[normalized.length - 1].version);
      } else if (normalized.length === 1) {
        setDiffFromVersion(normalized[0].version);
        setDiffToVersion(normalized[0].version);
      } else {
        setDiffFromVersion(null);
        setDiffToVersion(null);
      }
    } catch {
      setQuestionHistoryError("加载失败");
    } finally {
      setQuestionHistoryLoading(false);
    }
  }

  async function refreshQuestionDiff() {
    if (!id) return;
    if (!diffFromVersion || !diffToVersion) return;
    const from = questionHistory.find((item) => item.version === diffFromVersion);
    const to = questionHistory.find((item) => item.version === diffToVersion);
    if (!from || !to) return;
    setDiffLoading(true);
    setDiffRows([]);
    try {
      const [fromRes, toRes] = await Promise.all([
        fetch(`/api/debates/${id}/files?path=${encodeURIComponent(from.path)}`),
        fetch(`/api/debates/${id}/files?path=${encodeURIComponent(to.path)}`)
      ]);
      const [fromPayload, toPayload] = await Promise.all([
        fromRes.json().catch(() => ({})),
        toRes.json().catch(() => ({}))
      ]);
      if (!fromRes.ok) {
        setDiffRows([
          { kind: "row", type: "change", leftNo: null, rightNo: null, leftText: fromPayload.error?.message ?? "读取失败", rightText: "" }
        ]);
        return;
      }
      if (!toRes.ok) {
        setDiffRows([
          { kind: "row", type: "change", leftNo: null, rightNo: null, leftText: toPayload.error?.message ?? "读取失败", rightText: "" }
        ]);
        return;
      }
      const fromText = String(fromPayload.data?.content ?? "");
      const toText = String(toPayload.data?.content ?? "");
      setDiffRows(buildQuestionCompareRows(fromText, toText));
    } finally {
      setDiffLoading(false);
    }
  }

  useEffect(() => {
    if (!id) return;
    async function loadAgents() {
      try {
        const response = await fetch("/api/agents");
        const payload = await response.json().catch(() => ({}));
        if (response.ok) {
          setAgents(payload.data ?? []);
        }
      } catch {
      }
    }
    void loadAgents().catch(() => {});
  }, [id]);

  useEffect(() => {
    if (!debate) return;
    if (!questionDirty) {
      setQuestionDraft(debate.question ?? "");
    }
  }, [debate, questionDirty]);

  useEffect(() => {
    if (!id || !debate || !["running", "paused"].includes(debate.status)) return;

    const source = new EventSource(`/api/debates/${id}/events`);
    source.addEventListener("turn_start", (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent).data) as {
          progress?: { roundNumber: number; messageNumber: number; agentName: string };
        };
        if (!payload.progress) return;
        setIsStreaming(debate.status === "running");
        setLiveRoundNumber(payload.progress.roundNumber);
        setLiveMessageNumber((current) => {
          const next = payload.progress?.messageNumber;
          return typeof next === "number" ? next : current;
        });
        setLiveAgentName(payload.progress.agentName);
        setLiveStatus(debate.status === "paused" ? "已暂停（当前发言完成前保留实时草稿）" : "生成中...");
        setLiveText((current) => {
          const nextMessageNumber = payload.progress?.messageNumber;
          const sameTurn = typeof nextMessageNumber === "number" && nextMessageNumber === liveMessageNumber;
          return sameTurn && current ? current : "";
        });
      } catch {
      }
    });
    source.addEventListener("status", (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent).data) as { message?: string };
        if (payload.message) setLiveStatus(payload.message);
      } catch {
      }
    });
    source.addEventListener("chunk", (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent).data) as {
          text?: string;
          agentName?: string;
          turnNumber?: number;
        };
        if (typeof payload.turnNumber === "number") setLiveMessageNumber(payload.turnNumber);
        if (typeof payload.agentName === "string") setLiveAgentName(payload.agentName);
        if (typeof payload.text === "string") setLiveText((current) => current + payload.text);
      } catch {
      }
    });
    source.addEventListener("turn_end", () => {
      setLiveStatus("本轮完成（等待保存/下一轮）");
      setIsStreaming(false);
    });
    source.onerror = () => {
      source.close();
      setIsStreaming(false);
    };

    return () => {
      source.close();
    };
  }, [id, debate?.status, liveMessageNumber]);

  useEffect(() => {
    if (!questionHistoryOpen) return;
    if (questionHistoryLoading) return;
    if (diffLoading) return;
    if (!diffFromVersion || !diffToVersion) return;
    if (diffRows.length > 0) return;
    if (questionHistory.length < 1) return;
    void refreshQuestionDiff().catch(() => {});
  }, [
    questionHistoryOpen,
    questionHistoryLoading,
    questionHistory.length,
    diffLoading,
    diffFromVersion,
    diffToVersion,
    diffRows.length
  ]);

  async function action(name: "start" | "pause" | "resume" | "stop") {
    try {
      if (!id) return;
      if (name === "stop") {
        const ok = window.confirm("确定终止辩论吗？终止后将结束本场辩论（不可恢复），但不会删除记录。");
        if (!ok) return;
      }
      const response = await fetch(`/api/debates/${id}/${name}`, { method: "POST" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        showToast("error", payload.error?.message ?? "操作失败");
        return;
      }
      if (name === "pause") {
        showToast("success", "已请求暂停（本轮结束后生效）");
        setLiveStatus("已请求暂停（本轮结束后生效）");
      } else if (name === "stop") {
        showToast("success", "已终止");
        setIsStreaming(false);
      } else if (name === "resume") {
        showToast("success", "已恢复");
      } else if (name === "start") {
        showToast("success", "已开始");
      } else {
        showToast("success", "操作成功");
      }
      await loadDebate();
    } catch (error) {
      console.error(error);
      showToast("error", "网络错误：操作失败");
    }
  }

  async function toggleRun() {
    if (!debate) return;
    if (debate.status === "pending") return action("start");
    if (debate.status === "running") return action("pause");
    if (debate.status === "paused") return action("resume");
  }

  async function loadAllFilesIndex(force?: boolean) {
    if (!id) return null;
    if (!debate?.isOwner) return null;
    if (allFilesLoading) return null;
    if (allFilesLoadedRef.current && !force) return null;
    setAllFilesLoading(true);
    try {
      const response = await fetch(`/api/debates/${id}/all-files`, { cache: "no-store" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        showToast("error", payload.error?.message ?? "读取文件列表失败");
        return null;
      }

      const list = Array.isArray(payload.data) ? (payload.data as unknown[]) : [];
      const next = buildAllFilesMetaByVirtualPath(list);

      allFilesLoadedRef.current = true;
      setAllFilesMetaByVirtualPath(next);
      return next;
    } catch (error) {
      console.error(error);
      showToast("error", "网络错误：读取文件列表失败");
      return null;
    } finally {
      setAllFilesLoading(false);
    }
  }

  async function openDebateFileFromIndex(virtualPath: string) {
    if (!id) return;
    const meta = allFilesMetaByVirtualPath[virtualPath] ?? null;
    if (!meta) return;
    setActiveAllFileVirtualPath(virtualPath);

    const title = meta.scope === "debate" ? "辩论文件" : `${meta.seat} · ${meta.agentName} · 文件`;
    const displayPath = meta.scope === "debate" ? `debate/${meta.path}` : `agents/${meta.seat}/${meta.path}`;
    setMemoryOpen(true);
    setMemoryTitle(title);
    setMemoryPath(displayPath);
    setMemoryUpdatedAt("");
    setMemoryContent("");
    setMemoryTruncation(null);
    const isJsonl = meta.path.toLowerCase().endsWith(".jsonl");
    const defaultTail = isJsonl;
    setMemoryTail(defaultTail);
    setMemoryMaxChars(null);
    setMemoryTarget(meta.scope === "debate" ? { scope: "debate", path: meta.path } : { scope: "agent", debateAgentId: meta.debateAgentId, path: meta.path });
    await fetchMemoryTarget({
      target: meta.scope === "debate" ? { scope: "debate", path: meta.path } : { scope: "agent", debateAgentId: meta.debateAgentId, path: meta.path },
      tail: defaultTail,
      maxChars: null
    });
  }

  async function fetchMemoryTarget(input: {
    target:
      | { scope: "debate"; path: string }
      | { scope: "agent"; debateAgentId: string; path: string };
    tail: boolean;
    maxChars: number | null;
  }) {
    if (!id) return;
    setMemoryLoading(true);
    setMemoryTail(input.tail);
    setMemoryUpdatedAt("");
    setMemoryContent("");
    setMemoryTruncation(null);
    try {
      const maxCharsQuery = input.maxChars && Number.isFinite(input.maxChars) && input.maxChars > 0 ? `&maxChars=${Math.floor(input.maxChars)}` : "";
      const tailQuery = input.tail ? "&tail=1" : "";
      const url =
        input.target.scope === "debate"
          ? `/api/debates/${id}/files?path=${encodeURIComponent(input.target.path)}${tailQuery}${maxCharsQuery}`
          : `/api/debates/${id}/agents/${input.target.debateAgentId}/files?path=${encodeURIComponent(input.target.path)}${tailQuery}${maxCharsQuery}`;
      const response = await fetch(url, { cache: "no-store" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 404 && payload.error?.code === "NOT_FOUND") {
          setMemoryContent("尚未生成该文件（通常需要至少一轮发言后才会自动创建）。");
          return;
        }
        const message = payload.error?.message ?? "读取失败";
        setMemoryContent(message);
        showToast("error", message);
        return;
      }
      setMemoryContent(String(payload.data?.content ?? ""));
      setMemoryUpdatedAt(String(payload.data?.updatedAt ?? ""));
      if (payload.data?.truncated) {
        setMemoryTruncation({
          truncated: true,
          totalChars: Number(payload.data?.totalChars ?? 0) || 0,
          shownChars: Number(payload.data?.shownChars ?? 0) || 0,
          slice: (payload.data?.slice as "head" | "tail" | "full") ?? "full"
        });
      }
    } catch (error) {
      console.error(error);
      setMemoryContent("网络错误：读取失败");
      showToast("error", "网络错误：读取失败");
    } finally {
      setMemoryLoading(false);
    }
  }

  async function openGenerationDiagnostics(turnNumber: number) {
    if (!id || !Number.isFinite(turnNumber) || turnNumber <= 0) return;
    setDiagnosticsDialog({ turnNumber, entry: null, loading: true });
    try {
      const response = await fetch(
        `/api/debates/${id}/files?path=${encodeURIComponent("context/generation_diagnostics.jsonl")}`,
        { cache: "no-store" }
      );
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setDiagnosticsDialog({ turnNumber, entry: null, loading: false });
        return;
      }
      const content = String(payload.data?.content ?? "");
      const entries = content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line) as GenerationDiagnosticEntry;
          } catch {
            return null;
          }
        })
        .filter((item): item is GenerationDiagnosticEntry => Boolean(item));
      const entry = [...entries].reverse().find((item) => Number(item.turnNumber) === turnNumber) ?? null;
      setDiagnosticsDialog({ turnNumber, entry, loading: false });
    } catch (error) {
      console.error(error);
      setDiagnosticsDialog({ turnNumber, entry: null, loading: false });
    }
  }

  async function addAgent() {
    if (!id || !newAgentId || isAddingAgent) return;
    setIsAddingAgent(true);
    try {
      const response = await fetch(`/api/debates/${id}/agents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: newAgentId })
      });
      const payload = await response.json();
      if (!response.ok) {
        showToast("error", payload.error?.message ?? "加入失败");
        return;
      }
      setDebate(payload.data);
      setNewAgentId("");
      showToast("success", "已加入（排在最后）");
    } finally {
      setIsAddingAgent(false);
    }
  }

  async function reorderSeats(order: string[]) {
    if (!id) return;
    if (isReorderingSeats) return;
    setIsReorderingSeats(true);
    try {
      const response = await fetch(`/api/debates/${id}/agents/reorder`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        showToast("error", payload.error?.message ?? "调整失败");
        return;
      }
      showToast("success", "已调整席位顺序");
      await loadDebate();
    } finally {
      setIsReorderingSeats(false);
    }
  }

  async function moveSeat(debateAgentId: string, direction: -1 | 1) {
    if (!debate) return;
    const current = [...debate.agents].sort((a, b) => a.turnOrder - b.turnOrder);
    const index = current.findIndex((item) => item.debateAgentId === debateAgentId);
    if (index < 0) return;
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= current.length) return;
    const swapped = [...current];
    const temp = swapped[index];
    swapped[index] = swapped[nextIndex];
    swapped[nextIndex] = temp;
    await reorderSeats(swapped.map((item) => item.debateAgentId));
  }

  async function saveQuestion() {
    if (!id || !debate) return;
    if (debate.status === "running") {
      showToast("error", "请先暂停辩论再编辑问题");
      return;
    }
    if (!["pending", "paused"].includes(debate.status)) return;
    if (isSavingQuestion) return;
    if (questionDraft.trim().length < 10) {
      showToast("error", "问题至少 10 个字");
      return;
    }

    setIsSavingQuestion(true);
    try {
      const response = await fetch(`/api/debates/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: questionDraft })
      });
      const payload = await response.json();
      if (!response.ok) {
        showToast("error", payload.error?.message ?? "保存失败");
        return;
      }

      setQuestionDirty(false);
      setDebate((current) => (current ? { ...current, question: questionDraft } : current));
      const version = await loadQuestionVersionMeta();
      setSaveSuccessVersion(version);
      setSaveSuccessOpen(true);
      showToast("success", "已保存问题（diff 已全局通知）");
    } finally {
      setIsSavingQuestion(false);
    }
  }

  const agentCount = Math.max(1, debate?.agents.length ?? 0);
  const completedRounds = Math.floor((debate?.currentTurn ?? 0) / agentCount);
  const debateStatus = debate?.status ?? "";
  const participantCount = debate?.agents.length ?? 0;
  const isRoundBoundary = participantCount > 0 ? (debate?.currentTurn ?? 0) % participantCount === 0 : false;
  const canReorderSeats =
    Boolean(debate?.isOwner) &&
    ["pending", "paused"].includes(debateStatus) &&
    (debateStatus !== "paused" || isRoundBoundary);

  const latestTurn = turns.length ? turns[turns.length - 1] : null;

  const hasUnpersistedLiveDraft = useMemo(() => {
    if (!liveMessageNumber || !liveAgentName) return false;
    if (!liveText.trim()) return false;
    const latestTurnNumber = latestTurn?.turnNumber ?? 0;
    return latestTurnNumber < liveMessageNumber;
  }, [liveAgentName, liveMessageNumber, liveText, latestTurn?.turnNumber]);

  const liveAvailable = useMemo(() => {
    if (debateStatus === "running") return isStreaming || hasUnpersistedLiveDraft;
    if (debateStatus === "paused") return hasUnpersistedLiveDraft;
    return false;
  }, [debateStatus, hasUnpersistedLiveDraft, isStreaming]);

  const activeTurn = useMemo(() => {
    if (!activeTurnId) return null;
    return turns.find((turn) => turn.id === activeTurnId) ?? null;
  }, [turns, activeTurnId]);

  function buildVoteMarkdown(vote: OfficialVoteClosed) {
    const lines: string[] = [];
    lines.push(`# 第 ${vote.roundNumber} 轮 · 投票结果`);
    lines.push("");
    lines.push(`- 标题：${vote.title}`);
    lines.push("");

    if (vote.kind === "election") {
      const roles = Array.isArray(vote.result.roles)
        ? vote.result.roles
        : Object.keys((vote.result.roleCounts as Record<string, unknown>) ?? {});
      const winners = (vote.result.winners ?? {}) as Record<string, string | null>;
      const roleCounts = (vote.result.roleCounts ?? {}) as Record<string, Record<string, number>>;

      lines.push("## 结果");
      if (roles.length === 0) lines.push("- （未声明角色）");
      for (const role of roles) lines.push(`- ${role}：${winners?.[role] ?? "未能选出"}`);
      lines.push("");

      lines.push("## 票数");
      for (const role of roles) {
        const tally = Object.entries(roleCounts?.[role] ?? {})
          .map(([seat, count]) => ({ seat, count }))
          .sort((a, b) => b.count - a.count || a.seat.localeCompare(b.seat));
        lines.push(`### ${role}`);
        if (tally.length === 0) lines.push("- （无人投票）");
        for (const item of tally) lines.push(`- ${item.seat}: ${item.count}`);
        lines.push("");
      }

      lines.push("## 逐票明细");
      for (const ballot of vote.result.ballots ?? []) {
        const reason = ballot.reason ? ` · ${ballot.reason}` : "";
        const pairs = roles
          .map((role) => `${role}=${ballot.selections?.[role] ?? "?"}`)
          .join(" · ");
        const who = ballot.voterSeat ? `${ballot.voterSeat} · ${ballot.voter}` : ballot.voter;
        lines.push(`- ${who}: ${pairs}${reason}`);
      }

      return lines.join("\n");
    }

    const tally = Object.entries(vote.result.counts ?? {})
      .map(([choice, count]) => ({ choice, count }))
      .sort((a, b) => b.count - a.count || a.choice.localeCompare(b.choice));

    lines.push(`- Winner：${vote.result.winner ?? "未能选出"}`);
    lines.push("");
    lines.push(`- Prompt：${vote.prompt}`);
    lines.push("");

    lines.push("## 票数");
    if (tally.length === 0) lines.push("- （无人投票）");
    for (const item of tally) lines.push(`- ${item.choice}: ${item.count}`);
    lines.push("");

    lines.push("## 逐票明细");
    for (const ballot of vote.result.ballots ?? []) {
      const reason = ballot.reason ? ` · ${ballot.reason}` : "";
      const who = ballot.voterSeat ? `${ballot.voterSeat} · ${ballot.voter}` : ballot.voter;
      lines.push(`- ${who}: ${ballot.choice}${reason}`);
    }

    return lines.join("\n");
  }

  const activeVote = useMemo(() => {
    if (activeVoteRound === null) return null;
    return voteByRound[activeVoteRound] ?? null;
  }, [activeVoteRound, voteByRound]);

  const viewer = useMemo(() => {
    if (activeVoteRound !== null) {
      if (activeVote) return { kind: "vote" as const, vote: activeVote };
      return { kind: "vote_loading" as const, round: activeVoteRound };
    }
    if (activeTurn) return { kind: "turn" as const, turn: activeTurn };
    if (liveAvailable) return { kind: "live" as const };
    if (latestTurn) return { kind: "turn" as const, turn: latestTurn };
    return null;
  }, [activeVoteRound, activeVote, activeTurn, liveAvailable, latestTurn]);

  useEffect(() => {
    if (!followLatest) return;
    setActiveTurnId("");
    setActiveVoteRound(null);
  }, [followLatest]);

  useEffect(() => {
    if (!followLatest) return;
    if (activeVoteRound !== null) return;
    if (viewer?.kind !== "live" && viewer?.kind !== "turn") return;

    const el = viewerScrollRef.current;
    if (!el) return;
    const t = window.setTimeout(() => {
      const node = viewerScrollRef.current;
      if (!node) return;
      node.scrollTop = node.scrollHeight;
    }, 0);
    return () => window.clearTimeout(t);
  }, [followLatest, activeVoteRound, viewer?.kind, liveText, turns.length, latestTurn?.id]);

  const selectedViewerKey = useMemo(() => {
    if (activeVoteRound !== null) return `__vote_round_${activeVoteRound}`;
    if (activeTurnId) return activeTurnId;
    if (liveAvailable) return "__live__";
    return latestTurn?.id ?? "";
  }, [activeVoteRound, activeTurnId, liveAvailable, latestTurn?.id]);

  useEffect(() => {
    if (followLatest && viewer?.kind === "live") return;
    const node = viewerScrollRef.current;
    if (!node) return;
    node.scrollTop = 0;
  }, [followLatest, selectedViewerKey, viewer?.kind]);

  useEffect(() => {
    if (!memoryOpen || memoryLoading) return;
    const node = memoryContentRef.current;
    if (!node) return;
    const timer = window.setTimeout(() => {
      const current = memoryContentRef.current;
      if (!current) return;
      current.scrollTop = memoryTail ? current.scrollHeight : 0;
    }, 0);
    return () => window.clearTimeout(timer);
  }, [memoryContent, memoryLoading, memoryOpen, memoryTail, memoryTruncation?.slice]);

  const liveDisplayRound = typeof liveRoundNumber === "number" && liveRoundNumber > 0 ? liveRoundNumber : null;
  const liveDisplayMessage =
    typeof liveMessageNumber === "number" && liveMessageNumber > 0 ? liveMessageNumber : null;

  const turnsByRound = useMemo(() => {
    const map = new Map<number, Turn[]>();
    for (const turn of turns) {
      const round = Math.floor((turn.turnNumber - 1) / agentCount) + 1;
      const list = map.get(round) ?? [];
      list.push(turn);
      map.set(round, list);
    }
    return Array.from(map.entries()).sort((a, b) => a[0] - b[0]);
  }, [turns, agentCount]);

  const latestCompletedRound = turnsByRound.length > 0 ? turnsByRound[turnsByRound.length - 1]?.[0] ?? null : null;
  const currentDirectoryRound =
    (typeof liveDisplayRound === "number" && liveDisplayRound > 0 ? liveDisplayRound : null) ??
    latestCompletedRound ??
    (debate && debate.currentTurn > 0 ? Math.floor((debate.currentTurn - 1) / agentCount) + 1 : null);
  const currentDirectoryPhase = useMemo(() => {
    if (!currentDirectoryRound) return null;
    const mayBeFinalization = Boolean(debate?.consensusReached || debate?.status === "completed");
    return resolveDirectoryPhaseForRound(
      workflowConfig,
      currentDirectoryRound,
      mayBeFinalization,
      openVoteState,
      currentDirectoryRound
    );
  }, [currentDirectoryRound, debate?.consensusReached, debate?.status, workflowConfig, openVoteState]);

  useEffect(() => {
    if (turnsByRound.length < 1) return;
    const lastRound = turnsByRound[turnsByRound.length - 1]?.[0] ?? null;
    if (!lastRound) return;
    setOpenRoundsByNumber((current) => {
      if (Object.prototype.hasOwnProperty.call(current, String(lastRound))) return current;
      return { ...current, [lastRound]: true };
    });
  }, [turnsByRound.length]);

  const allFilesTreeModel = useMemo(
    () =>
      createFsTreeModel({
        normalizePath: normalizeFsPath
      }),
    []
  );
  const [allFilesTree, setAllFilesTree] = useState<FsNode[]>([]);
  const allFilesActionsRef = useRef<{
    openVirtualPath: (virtualPath: string) => void;
    clickVirtualPath: (node: NodeApi<FsNode>, event: ReactMouseEvent<HTMLDivElement>) => void;
    openContextMenu: (node: NodeApi<FsNode>, event: ReactMouseEvent<HTMLDivElement>) => void;
  }>({
    openVirtualPath: () => {},
    clickVirtualPath: () => {},
    openContextMenu: () => {}
  });
  const selectedAllFilesSet = useMemo(() => new Set(selectedAllFileVirtualPaths), [selectedAllFileVirtualPaths]);

  useEffect(() => {
    allFilesTreeModel.sync(Object.keys(allFilesMetaByVirtualPath));
    setAllFilesTree(allFilesTreeModel.getTree());
  }, [allFilesMetaByVirtualPath, allFilesTreeModel]);

  const allFilesTreePaths = useMemo(() => {
    const paths = new Set<string>();
    const stack = [...allFilesTree];
    while (stack.length > 0) {
      const node = stack.pop();
      if (!node) continue;
      paths.add(node.path);
      if (node.children?.length) {
        for (const child of node.children) stack.push(child);
      }
    }
    return paths;
  }, [allFilesTree]);

  useEffect(() => {
    setSelectedAllFileVirtualPaths((current) => current.filter((path) => allFilesTreePaths.has(path)));
    setAllFilesSelectionAnchor((current) => (current && allFilesTreePaths.has(current) ? current : ""));
  }, [allFilesTreePaths]);

  useEffect(() => {
    if (!allFilesContextMenu) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setAllFilesContextMenu(null);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [allFilesContextMenu]);

  const updateAllFilesSelection = useCallback(
    (node: NodeApi<FsNode>, event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }, mode: "click" | "contextmenu") => {
      const nextSelection = computeNextAllFilesSelection({
        path: node.data.path,
        anchor: allFilesSelectionAnchor,
        visiblePaths: node.tree.visibleNodes.map((item) => item.data.path),
        selectedPaths: selectedAllFileVirtualPaths,
        mode,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey
      });
      setSelectedAllFileVirtualPaths(nextSelection.selectedPaths);
      setAllFilesSelectionAnchor(nextSelection.anchor);
      return nextSelection.selectedPaths;
    },
    [allFilesSelectionAnchor, selectedAllFileVirtualPaths]
  );

  async function downloadSelectedAllFiles() {
    if (!id) return;
    if (selectedAllFileVirtualPaths.length === 0) {
      showToast("error", "请先选择文件或文件夹");
      return;
    }
    if (allFilesDownloading) return;

    setAllFilesDownloading(true);
    setAllFilesDownloadProgress({ loadedBytes: 0, totalBytes: null });
    try {
      const response = await fetch(`/api/debates/${id}/download`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paths: selectedAllFileVirtualPaths })
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        showToast("error", payload.error?.message ?? "下载失败");
        return;
      }
      const blob = await readDownloadBlobWithProgress(response, setAllFilesDownloadProgress);
      const fileName = parseDownloadFileName(response.headers.get("content-disposition"), id);

      const href = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = href;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(href), 1000);
      showToast("success", "已开始下载");
    } catch (error) {
      console.error(error);
      showToast("error", "网络错误：下载失败");
    } finally {
      setAllFilesDownloading(false);
      window.setTimeout(() => {
        setAllFilesDownloadProgress(null);
      }, 1200);
      setAllFilesContextMenu(null);
    }
  }

  async function openAllFileInfo(virtualPath: string) {
    if (!id) return;
    const meta = allFilesMetaByVirtualPath[virtualPath] ?? null;
    if (!meta) {
      showToast("error", "仅支持获取文件信息");
      return;
    }

    const displayPath = meta.scope === "debate" ? `debate/${meta.path}` : `agents/${meta.seat}/${meta.path}`;
    setAllFilesContextMenu(null);
    setAllFileInfoOpen(true);
    setAllFileInfoLoading(true);
    setAllFileInfo(null);

    try {
      const { response, payload } = await fetchAllFileInfoPayload({ debateId: id, meta });
      if (!response.ok) {
        showToast("error", payload.error?.message ?? "读取文件信息失败");
        setAllFileInfoOpen(false);
        return;
      }
      setAllFileInfo({
        displayPath,
        charCount: Number(payload.data?.charCount ?? 0) || 0,
        byteSize: Number(payload.data?.byteSize ?? 0) || 0,
        createdAt: String(payload.data?.createdAt ?? ""),
        updatedAt: String(payload.data?.updatedAt ?? "")
      });
    } catch (error) {
      console.error(error);
      showToast("error", "网络错误：读取文件信息失败");
      setAllFileInfoOpen(false);
    } finally {
      setAllFileInfoLoading(false);
    }
  }

  const renderAllFilesNode = useCallback(
    (props: { node: NodeApi<FsNode>; style: CSSProperties }) => (
      <AllFilesTreeRow
        node={props.node}
        style={props.style}
        activeVirtualPath={activeAllFileVirtualPath}
        selectedVirtualPaths={selectedAllFilesSet}
        actionsRef={allFilesActionsRef}
      />
    ),
    [activeAllFileVirtualPath, selectedAllFilesSet]
  );

  if (!debate) {
    return <div className="panel">加载中...</div>;
  }

  const downloadProgressPct =
    allFilesDownloadProgress && allFilesDownloadProgress.totalBytes && allFilesDownloadProgress.totalBytes > 0
      ? Math.max(
          0,
          Math.min(100, Math.round((allFilesDownloadProgress.loadedBytes / allFilesDownloadProgress.totalBytes) * 100))
        )
      : null;

  const availableAgents = agents;
  const canAddAgent =
    debate.isOwner &&
    ["running", "paused"].includes(debate.status) &&
    availableAgents.length > 0;

  const leftTabs: Array<{ id: LeftTab; label: string; icon: LeftTabIconName }> = [
    { id: "status", label: "辩论状态", icon: "status" },
    { id: "participants", label: "参与者", icon: "participants" },
    { id: "workflow", label: "Workflow", icon: "workflow" },
    { id: "memory", label: "文件", icon: "memory" }
  ];

  const leftTabTitle: Record<LeftTab, string> = {
    status: "辩论状态",
    participants: "参与者",
    workflow: "Workflow 规则",
    memory: "文件"
  };

  allFilesActionsRef.current.openVirtualPath = (virtualPath: string) => void openDebateFileFromIndex(virtualPath);
  allFilesActionsRef.current.clickVirtualPath = (node, event) => {
    setAllFilesContextMenu(null);
    updateAllFilesSelection(node, event, "click");
    if (event.shiftKey || event.ctrlKey || event.metaKey) return;
    if (node.data.type === "dir") {
      node.toggle();
      return;
    }
    void openDebateFileFromIndex(node.data.path);
  };
  allFilesActionsRef.current.openContextMenu = (node, event) => {
    event.preventDefault();
    event.stopPropagation();
    updateAllFilesSelection(node, event, "contextmenu");
    setAllFilesContextMenu({
      x: event.clientX,
      y: event.clientY,
      target: { type: "node", path: node.data.path, nodeType: node.data.type }
    });
  };

  return (
    <div className="grid" style={{ gridTemplateColumns: "52px 320px 2fr 1fr", alignItems: "start" }}>
      {toast ? (
        <div
          className={`toast ${toast.type === "success" ? "toast-success" : "toast-error"}`}
          role="status"
          aria-live="polite"
        >
          {toast.text}
        </div>
      ) : null}
      {injectedPromptDialog ? (
        <div
          role="dialog"
          aria-modal="true"
          onClick={() => setInjectedPromptDialog(null)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(15, 23, 42, 0.45)",
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "center",
            padding: 24,
            zIndex: 1000
          }}
        >
          <div
            className="panel stack"
            onClick={(event) => event.stopPropagation()}
            style={{ width: "min(980px, 100%)" }}
          >
            <div className="row" style={{ justifyContent: "space-between" }}>
              <div className="stack" style={{ gap: 4 }}>
                <strong>{injectedPromptDialog.phaseTitle} · 注入提示词</strong>
                <div className="muted">第 {injectedPromptDialog.round} 轮进入该阶段时自动注入到运行时 Prompt。</div>
              </div>
              <button className="btn" type="button" onClick={() => setInjectedPromptDialog(null)}>
                关闭
              </button>
            </div>
            <div className="panel" style={{ whiteSpace: "pre-wrap", maxHeight: "65vh", overflowY: "auto" }}>
              {injectedPromptDialog.prompt}
            </div>
          </div>
        </div>
      ) : null}
      {diagnosticsDialog ? (
        <div
          role="dialog"
          aria-modal="true"
          onClick={() => setDiagnosticsDialog(null)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(15, 23, 42, 0.45)",
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "center",
            padding: 24,
            zIndex: 1000
          }}
        >
          {(() => {
            const summary = diagnosticsDialog.entry ? summarizeGenerationDiagnostic(diagnosticsDialog.entry) : null;
            const summaryStyle =
              summary?.tone === "danger"
                ? { background: "rgba(239, 68, 68, 0.1)", borderColor: "rgba(239, 68, 68, 0.35)" }
                : summary?.tone === "warn"
                  ? { background: "rgba(245, 158, 11, 0.1)", borderColor: "rgba(245, 158, 11, 0.35)" }
                  : { background: "rgba(16, 185, 129, 0.1)", borderColor: "rgba(16, 185, 129, 0.35)" };
            return (
          <div
            className="panel stack"
            onClick={(event) => event.stopPropagation()}
            style={{ width: "min(860px, 100%)" }}
          >
            <div className="row" style={{ justifyContent: "space-between" }}>
              <div className="stack" style={{ gap: 4 }}>
                <strong>第 {diagnosticsDialog.turnNumber} 条发言 · 生成诊断</strong>
                <div className="muted">用于判断正文是被平台截断、工具打断，还是被业务逻辑覆盖。</div>
              </div>
              <button className="btn" type="button" onClick={() => setDiagnosticsDialog(null)}>
                关闭
              </button>
            </div>
            {diagnosticsDialog.loading ? (
              <div className="panel">读取中...</div>
            ) : diagnosticsDialog.entry ? (
              <div className="stack">
                <div className="panel stack" style={summaryStyle}>
                  <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
                    <strong>{summary?.title ?? "诊断结果"}</strong>
                    <span className="muted">
                      {diagnosticsDialog.entry.provider} / {diagnosticsDialog.entry.model}
                    </span>
                  </div>
                  <div>{summary?.conclusion}</div>
                  <div className="stack muted" style={{ gap: 6 }}>
                    {(summary?.evidence ?? []).map((item, index) => (
                      <div key={`${index}-${item}`}>- {item}</div>
                    ))}
                  </div>
                </div>
                <details className="panel">
                  <summary style={{ cursor: "pointer", fontWeight: 600 }}>查看原始诊断 JSON</summary>
                  <pre style={{ margin: "12px 0 0", whiteSpace: "pre-wrap", maxHeight: "45vh", overflowY: "auto" }}>
                    {JSON.stringify(diagnosticsDialog.entry, null, 2)}
                  </pre>
                </details>
              </div>
            ) : (
              <div className="panel">未找到该条发言的诊断记录。</div>
            )}
          </div>
            );
          })()}
        </div>
      ) : null}
      {saveSuccessOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          onClick={() => setSaveSuccessOpen(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(15, 23, 42, 0.45)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 24,
            zIndex: 1001
          }}
        >
          <div className="panel stack" onClick={(event) => event.stopPropagation()} style={{ width: "min(520px, 100%)" }}>
            <strong>保存成功</strong>
            <div className="muted">
              {saveSuccessVersion ? `当前版本：v${saveSuccessVersion}` : "已更新问题并生成版本"}
            </div>
            <div className="row" style={{ justifyContent: "flex-end" }}>
              <button className="btn" type="button" onClick={() => setSaveSuccessOpen(false)}>
                关闭
              </button>
              <button
                className="btn btn-primary"
                type="button"
                onClick={() => {
                  setSaveSuccessOpen(false);
                  void openQuestionHistory();
                }}
              >
                查看对比
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {questionZoomOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          onClick={() => setQuestionZoomOpen(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(15, 23, 42, 0.45)",
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "center",
            padding: 24,
            zIndex: 1000
          }}
        >
          <div
            className="panel stack"
            onClick={(event) => event.stopPropagation()}
            style={{ width: "min(980px, 100%)" }}
          >
            <div className="row" style={{ justifyContent: "space-between" }}>
              <strong>问题（放大查看）</strong>
              <button className="btn" type="button" onClick={() => setQuestionZoomOpen(false)}>
                关闭
              </button>
            </div>
            <LineNumberTextarea
              readOnly={!debate.isOwner || !["pending", "paused"].includes(debate.status)}
              value={["pending", "paused"].includes(debate.status) ? questionDraft : debate.question}
              onChange={(next) => {
                setQuestionDraft(next);
                setQuestionDirty(true);
              }}
              maxLength={50_000}
              height={"60vh"}
              autoFocus
              baseline={debate.question}
            />
            {debate.isOwner && ["pending", "paused"].includes(debate.status) ? (
              <div className="row" style={{ justifyContent: "space-between" }}>
                <span className="muted">{questionDraft.length.toLocaleString()}/50,000</span>
                <button
                  className="btn btn-primary"
                  disabled={isSavingQuestion || !questionDirty}
                  type="button"
                  onClick={() => void saveQuestion()}
                >
                  {isSavingQuestion ? "保存中..." : "保存"}
                </button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
      {questionHistoryOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          onClick={() => setQuestionHistoryOpen(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(15, 23, 42, 0.45)",
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "center",
            padding: 24,
            zIndex: 1000
          }}
        >
          <div
            className="panel stack"
            onClick={(event) => event.stopPropagation()}
            style={{ width: "min(1080px, 100%)" }}
          >
            <div className="row" style={{ justifyContent: "space-between" }}>
              <strong>问题版本与对比</strong>
              <div className="row" style={{ gap: 8 }}>
                <button className="btn" type="button" onClick={() => void openQuestionHistory()}>
                  刷新
                </button>
                <button className="btn" type="button" onClick={() => setQuestionHistoryOpen(false)}>
                  关闭
                </button>
              </div>
            </div>

            {questionHistoryLoading ? <div className="muted">加载中...</div> : null}
            {!questionHistoryLoading && questionHistoryError ? (
              <div className="muted">{questionHistoryError}</div>
            ) : null}

            {!questionHistoryLoading && !questionHistoryError ? (
              <div className="grid" style={{ gridTemplateColumns: "320px 1fr", alignItems: "start" }}>
                <div className="panel stack">
                  <strong>历史</strong>
                  <div className="muted">当前版本：v{questionVersion ?? (questionHistory.at(-1)?.version ?? 1)}</div>
                  <div className="stack" style={{ gap: 8, maxHeight: "60vh", overflowY: "auto" }}>
                    {questionHistory.length === 0 ? <div className="muted">暂无</div> : null}
                    {questionHistory.map((item) => (
                      <button
                        key={item.version}
                        type="button"
                        className="btn"
                        style={{
                          textAlign: "left",
                          borderColor:
                            item.version === diffToVersion || item.version === diffFromVersion
                              ? "rgba(38, 99, 235, 0.55)"
                              : undefined,
                          background:
                            item.version === diffToVersion || item.version === diffFromVersion
                              ? "rgba(38, 99, 235, 0.08)"
                              : undefined
                        }}
                        onClick={() => {
                          setDiffFromVersion(item.version);
                          setDiffToVersion(questionHistory.at(-1)?.version ?? item.version);
                        }}
                      >
                        <div>
                          <strong>v{item.version}</strong>
                        </div>
                        <div className="muted">{item.at ? new Date(item.at).toLocaleString() : ""}</div>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="panel stack">
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <strong>Diff</strong>
                    <div className="row" style={{ gap: 8 }}>
                      <select
                        value={diffFromVersion ?? ""}
                        onChange={(event) => setDiffFromVersion(event.target.value ? Number(event.target.value) : null)}
                      >
                        <option value="">From</option>
                        {questionHistory.map((item) => (
                          <option key={item.version} value={item.version}>
                            v{item.version}
                          </option>
                        ))}
                      </select>
                      <select
                        value={diffToVersion ?? ""}
                        onChange={(event) => setDiffToVersion(event.target.value ? Number(event.target.value) : null)}
                      >
                        <option value="">To</option>
                        {questionHistory.map((item) => (
                          <option key={item.version} value={item.version}>
                            v{item.version}
                          </option>
                        ))}
                      </select>
                      <button
                        className="btn btn-primary"
                        type="button"
                        disabled={diffLoading || !diffFromVersion || !diffToVersion}
                        onClick={() => void refreshQuestionDiff()}
                      >
                        {diffLoading ? "生成中..." : "生成 Diff"}
                      </button>
                    </div>
                  </div>

                  <div className="panel" style={{ height: "60vh", overflowY: "auto" }}>
                    {diffLoading ? <div className="muted">生成中...</div> : null}
                    {!diffLoading ? (
                      diffRows.length > 0 ? (
                        <div
                          style={{
                            display: "grid",
                            gridTemplateColumns: "1fr 1fr",
                            gap: 0,
                            fontFamily:
                              "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
                            fontSize: 12
                          }}
                        >
                          {diffRows.map((row, index) => {
                            if (row.kind === "skip") {
                              return (
                                <div
                                  key={`skip_${index}`}
                                  className="muted"
                                  style={{
                                    gridColumn: "1 / span 2",
                                    padding: "8px 10px"
                                  }}
                                >
                                  … 跳过 {row.leftSkip} 行未变更 …
                                </div>
                              );
                            }

                            const baseCell: CSSProperties = {
                              display: "flex",
                              gap: 10,
                              padding: "4px 10px",
                              whiteSpace: "pre-wrap",
                              alignItems: "flex-start"
                            };
                            const leftBg =
                              row.type === "del"
                                ? "rgba(220, 38, 38, 0.10)"
                                : row.type === "change"
                                  ? "rgba(37, 99, 235, 0.10)"
                                  : "transparent";
                            const rightBg =
                              row.type === "add"
                                ? "rgba(22, 163, 74, 0.10)"
                                : row.type === "change"
                                  ? "rgba(37, 99, 235, 0.10)"
                                  : "transparent";
                            const leftNoBg =
                              row.type === "del"
                                ? "rgba(220, 38, 38, 0.22)"
                                : row.type === "change"
                                  ? "rgba(37, 99, 235, 0.18)"
                                  : "transparent";
                            const rightNoBg =
                              row.type === "add"
                                ? "rgba(22, 163, 74, 0.22)"
                                : row.type === "change"
                                  ? "rgba(37, 99, 235, 0.18)"
                                  : "transparent";

                            return (
                              <Fragment key={`row_${index}`}>
                                <div style={{ ...baseCell, background: leftBg }}>
                                  <span
                                    className="muted"
                                    style={{
                                      width: 44,
                                      flex: "0 0 auto",
                                      textAlign: "right",
                                      background: leftNoBg,
                                      borderRadius: 6,
                                      padding: "0 6px",
                                      lineHeight: "18px",
                                      marginTop: 1
                                    }}
                                  >
                                    {row.leftNo ?? ""}
                                  </span>
                                  <span style={{ flex: 1 }}>{row.leftText}</span>
                                </div>
                                <div style={{ ...baseCell, background: rightBg }}>
                                  <span
                                    className="muted"
                                    style={{
                                      width: 44,
                                      flex: "0 0 auto",
                                      textAlign: "right",
                                      background: rightNoBg,
                                      borderRadius: 6,
                                      padding: "0 6px",
                                      lineHeight: "18px",
                                      marginTop: 1
                                    }}
                                  >
                                    {row.rightNo ?? ""}
                                  </span>
                                  <span style={{ flex: 1 }}>{row.rightText}</span>
                                </div>
                              </Fragment>
                            );
                          })}
                        </div>
                      ) : (
                        <div className="muted">选择版本并点击“生成 Diff”</div>
                      )
                    ) : null}
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
      <FileInfoDialog
        open={allFileInfoOpen}
        loading={allFileInfoLoading}
        info={allFileInfo}
        onClose={() => {
          setAllFileInfoOpen(false);
          setAllFileInfo(null);
        }}
      />
      <DownloadProgressDialog progress={allFilesDownloadProgress} progressPct={downloadProgressPct} />
      {memoryOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          onClick={() => {
            setMemoryOpen(false);
            setMemoryTarget(null);
          }}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(15, 23, 42, 0.45)",
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "center",
            padding: 24,
            zIndex: 1000
          }}
        >
          <div
            className="panel stack"
            onClick={(event) => event.stopPropagation()}
            style={{ width: "min(980px, 100%)" }}
          >
            <div className="row" style={{ justifyContent: "space-between" }}>
              <strong>{memoryTitle || "记忆文件"}</strong>
              <div className="row" style={{ gap: 8 }}>
                {memoryTarget ? (
                  <>
                    <button
                      className="btn"
                      type="button"
                      disabled={memoryLoading}
                      onClick={() => {
                        setMemoryTail(false);
                        void fetchMemoryTarget({ target: memoryTarget, tail: false, maxChars: memoryMaxChars });
                      }}
                      title="显示开头（适合查看 jsonl 的前半部分）"
                    >
                      开头
                    </button>
                    <button
                      className="btn"
                      type="button"
                      disabled={memoryLoading}
                      onClick={() => {
                        setMemoryTail(true);
                        void fetchMemoryTarget({ target: memoryTarget, tail: true, maxChars: memoryMaxChars });
                      }}
                      title="显示末尾（默认）"
                    >
                      末尾
                    </button>
                    {memoryTruncation?.truncated ? (
                      <button
                        className="btn"
                        type="button"
                        disabled={memoryLoading}
                        onClick={() => {
                          const next = Math.min(2_000_000, Math.max(250_000, (memoryMaxChars ?? 250_000) + 250_000));
                          setMemoryMaxChars(next);
                          void fetchMemoryTarget({ target: memoryTarget, tail: memoryTail, maxChars: next });
                        }}
                        title="增大读取上限（最多 2,000,000 chars）"
                      >
                        加载更多
                      </button>
                    ) : null}
                  </>
                ) : null}
                <button
                  className="btn"
                  type="button"
                  onClick={() => {
                    setMemoryOpen(false);
                    setMemoryTarget(null);
                  }}
                >
                  关闭
                </button>
              </div>
            </div>
            <div className="muted">
              {memoryPath}
              {memoryUpdatedAt ? ` · ${new Date(memoryUpdatedAt).toLocaleString()}` : ""}
            </div>
            {memoryTruncation?.truncated ? (
              <div className="muted">
                内容过大已截断：显示{memoryTruncation.slice === "tail" ? "末尾" : "开头"} {memoryTruncation.shownChars}/
                {memoryTruncation.totalChars} chars
              </div>
            ) : null}
            <div ref={memoryContentRef} className="panel" style={{ height: "70vh", overflowY: "auto" }}>
              {memoryLoading ? (
                <div className="muted">加载中...</div>
              ) : memoryPath.toLowerCase().endsWith(".md") ? (
                <MarkdownView value={memoryContent || "（空）"} />
              ) : (
                <pre style={preWrapStyle}>{memoryContent || "（空）"}</pre>
              )}
            </div>
          </div>
        </div>
      ) : null}

      <nav
        className="panel"
        aria-label="左侧栏"
        style={{
          padding: 6,
          maxHeight: "calc(100vh - 140px)",
          overflowY: "auto"
        }}
      >
        <div className="stack" style={{ gap: 6 }}>
          {leftTabs.map((tab) => {
            const selected = leftTab === tab.id;
            return (
              <button
                key={tab.id}
                className="btn leftTabButton"
                type="button"
                title={tab.label}
                aria-label={tab.label}
                aria-current={selected ? "page" : undefined}
                onClick={() => setLeftTab(tab.id)}
                style={{
                  borderColor: selected ? "rgba(38, 99, 235, 0.55)" : undefined,
                  background: selected ? "rgba(38, 99, 235, 0.08)" : undefined
                }}
              >
                <span className="leftTabIcon" aria-hidden="true">
                  <LeftTabIcon name={tab.icon} />
                </span>
              </button>
            );
          })}
        </div>
      </nav>

      <section className="panel stack" style={{ maxHeight: "calc(100vh - 140px)", overflowY: "auto" }}>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <strong style={{ fontSize: 14 }}>{leftTabTitle[leftTab]}</strong>
          <Link className="btn" href="/debates">
            返回列表
          </Link>
        </div>

        {!debate.isOwner ? <div className="muted">公开辩论（只读）</div> : null}

        {leftTab === "status" ? (
          <Fragment>
            <div>
              <span className={`badge badge-${debate.status}`}>{debate.status}</span>
            </div>
            <StatusQuestionPanel
              debate={debate}
              questionVersion={questionVersion}
              questionDraft={questionDraft}
              questionDirty={questionDirty}
              isSavingQuestion={isSavingQuestion}
              onOpenZoom={() => setQuestionZoomOpen(true)}
              onOpenHistory={() => void openQuestionHistory()}
              onSave={() => void saveQuestion()}
              onChangeDraft={(next) => {
                setQuestionDraft(next);
                setQuestionDirty(true);
              }}
            />
            <StatusSummaryPanel
              debate={debate}
              agentCount={agentCount}
              completedRounds={completedRounds}
              liveAgentName={liveAgentName}
              liveDisplayRound={liveDisplayRound}
              liveDisplayMessage={liveDisplayMessage}
              liveStatus={liveStatus}
            />
          </Fragment>
        ) : leftTab === "participants" ? (
          <ParticipantsPanel
            canAddAgent={canAddAgent}
            agentCount={debate.agents.length}
            availableAgents={availableAgents}
            newAgentId={newAgentId}
            isAddingAgent={isAddingAgent}
            isOwner={debate.isOwner}
            debateStatus={debateStatus}
            agents={debate.agents}
            resettingUsageByDebateAgentId={resettingUsageByDebateAgentId}
            contextTotalsByDebateAgentId={contextTotalsByDebateAgentId}
            onChangeNewAgentId={setNewAgentId}
            onAddAgent={() => void addAgent()}
            onResetUsageSession={(debateAgentId) => void resetAgentUsageSession(debateAgentId)}
          />
        ) : leftTab === "workflow" ? (
          <WorkflowRulesPanel
            markdown={workflowRulesState.markdown}
            loading={workflowRulesState.loading}
            onRefresh={() => void loadWorkflowRules()}
          />
        ) : debate.isOwner ? (
          <DebateFilesPanel
            selectedCount={selectedAllFileVirtualPaths.length}
            downloading={allFilesDownloading}
            loading={allFilesLoading}
            hasFiles={Object.keys(allFilesMetaByVirtualPath).length > 0}
            tree={allFilesTree}
            renderNode={renderAllFilesNode}
            contextMenu={allFilesContextMenu}
            onDownload={() => void downloadSelectedAllFiles()}
            onRefresh={() => void loadAllFilesIndex(true)}
            onRootContextMenu={(event) => {
              event.preventDefault();
              setAllFilesContextMenu({
                x: event.clientX,
                y: event.clientY,
                target: { type: "root" }
              });
            }}
            onCloseContextMenu={() => setAllFilesContextMenu(null)}
            onOpenFileInfo={(virtualPath) => void openAllFileInfo(virtualPath)}
          />
        ) : (
          <div className="muted">公开辩论不支持读取辩论文件。</div>
        )}
      </section>

      <section className="panel stack" style={{ height: "calc(100vh - 140px)", overflow: "hidden" }}>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2 style={{ margin: 0 }}>发言内容</h2>
          <div className="row" style={{ gap: 8 }}>
            <button
              className={`btn ${followLatest ? "btn-active" : ""}`}
              type="button"
              title="开启后自动滚动到最新输出"
              onClick={() => setFollowLatest((current) => !current)}
            >
              跟随最新
            </button>
            {activeTurnId || activeVoteRound !== null ? (
              <button
                className="btn"
                onClick={() => {
                  setActiveTurnId("");
                  setActiveVoteRound(null);
                }}
              >
                回到当前
              </button>
            ) : null}
          </div>
        </div>

        {viewer?.kind === "live" ? (
          <div className="stack" style={{ flex: 1, minHeight: 0 }}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <strong>
                当前：{liveAgentName || "未知"}
                {liveDisplayRound ? ` · 第 ${liveDisplayRound} 轮` : ""}
                {liveDisplayMessage
                  ? (() => {
                      const turnInRound = agentCount > 0 ? ((liveDisplayMessage - 1) % agentCount) + 1 : null;
                      return ` · #${liveDisplayMessage}${turnInRound ? `（第 ${turnInRound} 回）` : ""}`;
                    })()
                  : ""}
              </strong>
              <span className="muted">{liveStatus || "运行中"}</span>
            </div>
            <div ref={viewerScrollRef} className="panel" style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
              <MarkdownView value={liveText || "（等待输出）"} />
            </div>
          </div>
        ) : viewer?.kind === "vote_loading" ? (
          <div className="stack" style={{ flex: 1, minHeight: 0 }}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <strong>第 {viewer.round} 轮 · 投票结果</strong>
              <span className="muted">加载中...</span>
            </div>
            <div ref={viewerScrollRef} className="panel" style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
              <div className="muted">读取投票结果中...</div>
            </div>
          </div>
        ) : viewer?.kind === "vote" ? (
          <div className="stack" style={{ flex: 1, minHeight: 0 }}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <strong>第 {viewer.vote.roundNumber} 轮 · 投票结果</strong>
              <span className="muted">汇总</span>
            </div>
            <div ref={viewerScrollRef} className="panel" style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
              <MarkdownView value={buildVoteMarkdown(viewer.vote)} />
            </div>
          </div>
        ) : viewer?.kind === "turn" ? (
          <div className="stack" style={{ flex: 1, minHeight: 0 }}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <div className="stack" style={{ gap: 4 }}>
                <strong>
                  {(() => {
                    const round = Math.floor((viewer.turn.turnNumber - 1) / agentCount) + 1;
                    const turnInRound = ((viewer.turn.turnNumber - 1) % agentCount) + 1;
                    const seat = viewer.turn.seatNumber ? `Seat-${viewer.turn.seatNumber}` : "";
                    return `#${viewer.turn.turnNumber} · 第 ${round} 轮 第 ${turnInRound} 回${seat ? ` · ${seat}` : ""} · ${viewer.turn.agent.name}`;
                  })()}
                </strong>
                <span className="muted">{viewer.turn.content.length} chars</span>
              </div>
              <div className="row" style={{ gap: 8 }}>
                <button className="btn" type="button" onClick={() => void openGenerationDiagnostics(viewer.turn.turnNumber)}>
                  查看诊断结果
                </button>
                <span className="muted">{new Date(viewer.turn.createdAt).toLocaleTimeString()}</span>
              </div>
            </div>
            <div ref={viewerScrollRef} className="panel" style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
              <MarkdownView value={viewer.turn.content} />
            </div>
          </div>
        ) : (
          <div className="muted">还没有发言记录</div>
        )}
      </section>

      <section className="panel stack" style={{ maxHeight: "calc(100vh - 140px)", overflowY: "auto" }}>
        <div className="row" style={{ gap: 8 }}>
          {debate.isOwner && ["pending", "running", "paused"].includes(debate.status) ? (
            <button className="btn btn-primary" onClick={() => void toggleRun()}>
              {debate.status === "pending" ? "开始" : debate.status === "running" ? "暂停" : "恢复"}
            </button>
          ) : null}
          {debate.isOwner && ["pending", "running", "paused"].includes(debate.status) ? (
            <button className="btn btn-danger" onClick={() => void action("stop")}>
              终止
            </button>
          ) : null}
        </div>
        <h2 style={{ margin: 0 }}>发言目录</h2>
        {currentDirectoryPhase ? (
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <span className="softBox" style={{ padding: "4px 8px", fontSize: 12 }}>
              当前阶段：{currentDirectoryPhase.title}
            </span>
            <span className="muted">
              {currentDirectoryRound ? `第 ${currentDirectoryRound} 轮` : ""}
              {currentDirectoryPhase.description ? ` · ${currentDirectoryPhase.description}` : ""}
            </span>
          </div>
        ) : null}
        {turnsByRound.length === 0 && !liveAvailable ? <div className="muted">还没有发言记录</div> : null}

        {liveAvailable ? (
          <button
            type="button"
            className="btn"
            onClick={() => setActiveTurnId("")}
            style={{
              textAlign: "left",
              borderColor: selectedViewerKey === "__live__" ? "rgba(38, 99, 235, 0.55)" : undefined,
              background: selectedViewerKey === "__live__" ? "rgba(38, 99, 235, 0.08)" : undefined
            }}
          >
            <strong>
              {liveDisplayRound ? `第 ${liveDisplayRound} 轮` : "进行中"} · {liveAgentName || "未知"} · 生成中
            </strong>
            <span className="muted">{liveStatus ? ` · ${liveStatus}` : ""}</span>
          </button>
        ) : null}

        {turnsByRound.map(([round, roundTurns]) => {
          const isOpen = Boolean(openRoundsByNumber[round]);
          const phase = resolveDirectoryPhaseForRound(
            workflowConfig,
            round,
            Boolean(currentDirectoryPhase?.kind === "finalization"),
            openVoteState,
            currentDirectoryRound
          );
          const phaseEntryRound = phase ? isPhaseEntryRound(workflowConfig, round, phase.kind) : false;
          const hasInjectedPrompt = Boolean(phase?.injectedPrompt && phaseEntryRound);
          const isCurrentPhaseRound = Boolean(currentDirectoryRound === round);
          const hasVoteResult = Boolean(votePathsByRound[round]);
          return (
          <details
            key={round}
            open={isOpen}
            onToggle={(event) => {
              const nextOpen = (event.currentTarget as HTMLDetailsElement).open;
              setOpenRoundsByNumber((current) => ({ ...current, [round]: nextOpen }));
            }}
          >
            <summary style={{ cursor: "pointer" }}>
              <strong>第 {round} 轮</strong>
              <span className="muted"> · {roundTurns.length}/{agentCount}</span>
              {phase ? (
                <span
                  className="softBox"
                  style={{
                    marginLeft: 8,
                    padding: "2px 8px",
                    fontSize: 12,
                    borderColor: isCurrentPhaseRound ? "rgba(38, 99, 235, 0.35)" : undefined,
                    background: isCurrentPhaseRound ? "rgba(38, 99, 235, 0.1)" : undefined
                  }}
                >
                  {phase.title}
                  {isCurrentPhaseRound ? " · 当前" : ""}
                </span>
              ) : null}
              {hasInjectedPrompt ? (
                <span
                  className="softBox"
                  title="这一轮开始进入了带有自动注入提示词的新阶段，展开后可查看注入文本。"
                  style={{ marginLeft: 8, padding: "2px 8px", fontSize: 12 }}
                >
                  已注入提示词
                </span>
              ) : null}
              {hasVoteResult ? (
                <span
                  className="softBox"
                  title="这一轮已有可查看的官方投票结果。"
                  style={{ marginLeft: 8, padding: "2px 8px", fontSize: 12 }}
                >
                  有投票结果
                </span>
              ) : null}
            </summary>
            {isOpen ? (
              <div className="stack" style={{ marginTop: 10 }}>
                {phase ? (
                  <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <span className="muted">阶段：{phase.title}</span>
                    {phase.description ? <span className="muted">· {phase.description}</span> : null}
                    {hasInjectedPrompt ? (
                      <button
                        type="button"
                        className="btn"
                        title="查看这一阶段自动注入到运行时 Prompt 的文本"
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          if (!phase?.injectedPrompt) return;
                          setInjectedPromptDialog({
                            round,
                            phaseTitle: phase.title,
                            prompt: phase.injectedPrompt
                          });
                        }}
                      >
                        查看注入提示词
                      </button>
                    ) : null}
                  </div>
                ) : null}
                {votePathsByRound[round] ? (
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      setActiveTurnId("");
                      setActiveVoteRound(round);
                      void loadVoteRound(round);
                    }}
                    style={{
                      textAlign: "left",
                      borderColor:
                        selectedViewerKey === `__vote_round_${round}` ? "rgba(38, 99, 235, 0.55)" : undefined,
                      background:
                        selectedViewerKey === `__vote_round_${round}` ? "rgba(38, 99, 235, 0.08)" : undefined
                    }}
                  >
                    <span>投票结果</span>
                    <span className="muted"> · 汇总</span>
                  </button>
                ) : null}
                {roundTurns.map((turn) => {
                  const active = selectedViewerKey === turn.id;
                  return (
                    <button
                      key={turn.id}
                      type="button"
                      className="btn"
                      onClick={() => {
                        setActiveVoteRound(null);
                        setActiveTurnId(turn.id);
                      }}
                      style={{
                        textAlign: "left",
                        borderColor: active ? "rgba(38, 99, 235, 0.55)" : undefined,
                        background: active ? "rgba(38, 99, 235, 0.08)" : undefined
                    }}
                  >
                    <span>
                        {(() => {
                          const turnInRound = ((turn.turnNumber - 1) % agentCount) + 1;
                          const seat = turn.seatNumber ? `Seat-${turn.seatNumber}` : "";
                          return `#${turn.turnNumber} · 第 ${round} 轮 第 ${turnInRound} 回${seat ? ` · ${seat}` : ""} · ${turn.agent.name}`;
                        })()}
                    </span>
                    <span className="muted"> · {new Date(turn.createdAt).toLocaleTimeString()}</span>
                  </button>
                );
              })}
              </div>
            ) : null}
          </details>
        );
        })}
      </section>
    </div>
  );
}
