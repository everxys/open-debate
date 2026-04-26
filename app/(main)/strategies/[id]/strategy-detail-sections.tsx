import Link from "next/link";

import type { StrategyDetail, WorkflowPromptDialogState } from "./strategy-detail-types";
import { formatLocalTime } from "./strategy-detail-utils";

export function WorkflowPromptDialog(props: {
  dialog: WorkflowPromptDialogState;
  canEdit: boolean;
  onClose: () => void;
  onChangeValue: (value: string) => void;
  onApply: () => void;
}) {
  if (!props.dialog) return null;

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
            <strong>{props.dialog.title}</strong>
            <div className="muted">{props.dialog.description}</div>
          </div>
          <button className="btn" type="button" onClick={props.onClose}>
            关闭
          </button>
        </div>
        <textarea
          className="strategyPrompt"
          value={props.dialog.value}
          disabled={!props.canEdit}
          onChange={(event) => props.onChangeValue(event.target.value)}
          style={{ height: "60vh", resize: "none", overflowY: "auto" }}
          autoFocus
        />
        <div className="row" style={{ justifyContent: "space-between" }}>
          <span className="muted">{props.dialog.value.length.toLocaleString()} 字符</span>
          <div className="row">
            <button className="btn" type="button" onClick={props.onClose}>
              取消
            </button>
            {props.canEdit ? (
              <button className="btn btn-primary" type="button" onClick={props.onApply}>
                应用修改
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

export function StrategyOverviewSection(props: {
  detail: StrategyDetail;
  name: string;
  description: string;
  isShared: boolean;
  canSave: boolean;
  isSavingAll: boolean;
  isSaving: boolean;
  workflowPhasePromptsSaving: boolean;
  workflowContextAccessSaving: boolean;
  workflowSummarizerSaving: boolean;
  isFavoriting: boolean;
  isForking: boolean;
  onChangeName: (value: string) => void;
  onChangeDescription: (value: string) => void;
  onChangeShared: (value: boolean) => void;
  onSaveAll: () => void;
  onToggleFavorite: () => void;
  onFork: () => void;
}) {
  const saving =
    props.isSavingAll ||
    props.isSaving ||
    props.workflowPhasePromptsSaving ||
    props.workflowContextAccessSaving ||
    props.workflowSummarizerSaving;

  return (
    <section className="panel stack">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start", gap: 16, flexWrap: "wrap" }}>
        <div className="stack" style={{ gap: 6 }}>
          <div className="row" style={{ gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <h2 style={{ margin: 0 }}>策略概览</h2>
            <span className="muted">{props.detail.canEdit ? "可编辑" : "只读（来自社区分享）"}</span>
          </div>
          <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
            <span className="muted">最近更新：{formatLocalTime(props.detail.updatedAt)}</span>
            <span className="muted">共享状态：{props.isShared ? "已共享" : "未共享"}</span>
            {props.detail.isShared ? (
              <span className="muted">收藏 {props.detail.favoriteCount ?? 0} · Fork {props.detail.forkCount ?? 0}</span>
            ) : null}
          </div>
        </div>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <Link className="btn" href="/strategies">
            返回
          </Link>
          <Link className="btn btn-primary" href={`/workspaces/new?strategyId=${props.detail.id}`}>
            创建工作台
          </Link>
          {props.detail.canEdit ? (
            <button
              className="btn btn-primary"
              disabled={!props.canSave || saving}
              onClick={props.onSaveAll}
            >
              {saving ? "保存中..." : "保存全部"}
            </button>
          ) : (
            <>
              <button className="btn" disabled={props.isFavoriting} onClick={props.onToggleFavorite}>
                {props.isFavoriting ? "处理中..." : props.detail.isFavorited ? "取消收藏" : "收藏"}
              </button>
              <button className="btn" disabled={props.isForking} onClick={props.onFork}>
                {props.isForking ? "Fork 中..." : "Fork"}
              </button>
            </>
          )}
        </div>
      </div>

      <div className="grid" style={{ gap: 12 }}>
        <div className="field">
          <label>策略名称</label>
          <input value={props.name} disabled={!props.detail.canEdit} onChange={(event) => props.onChangeName(event.target.value)} />
        </div>
        <div className="field">
          <label>描述（可选）</label>
          <textarea
            value={props.description}
            disabled={!props.detail.canEdit}
            onChange={(event) => props.onChangeDescription(event.target.value)}
          />
        </div>
      </div>

      <label className="row" style={{ alignItems: "center", gap: 8 }}>
        <input
          type="checkbox"
          checked={props.isShared}
          disabled={!props.detail.canEdit}
          onChange={(event) => props.onChangeShared(event.target.checked)}
        />
        <span>分享到社区</span>
      </label>
    </section>
  );
}

export function StrategyAdvancedSection(props: {
  canEdit: boolean;
  isExportingFolder: boolean;
  isImportingFolder: boolean;
  isDeleting: boolean;
  onDownloadFolder: () => void;
  onOpenFolderImport: () => void;
  onDelete: () => void;
}) {
  return (
    <details className="panel">
      <summary
        className="row"
        style={{ cursor: "pointer", justifyContent: "space-between", alignItems: "center", gap: 12 }}
      >
        <div className="row" style={{ gap: 8, alignItems: "center" }}>
          <strong>导入 / 导出 / 高级操作</strong>
          <span className="muted">备份与覆盖</span>
        </div>
        <span className="muted">{props.canEdit ? "查看 / 编辑" : "查看"}</span>
      </summary>
      <div className="stack" style={{ marginTop: 12 }}>
        <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
          <button className="btn" disabled={props.isExportingFolder} onClick={props.onDownloadFolder}>
            {props.isExportingFolder ? "导出中..." : "下载文件夹"}
          </button>
          {props.canEdit ? (
            <button className="btn" disabled={props.isImportingFolder} onClick={props.onOpenFolderImport}>
              {props.isImportingFolder ? "导入中..." : "上传文件夹覆盖"}
            </button>
          ) : null}
          {props.canEdit ? (
            <button className="btn btn-danger" disabled={props.isDeleting} onClick={props.onDelete}>
              {props.isDeleting ? "删除中..." : "删除策略"}
            </button>
          ) : null}
        </div>
        <div className="muted">覆盖前先备份。</div>
      </div>
    </details>
  );
}
