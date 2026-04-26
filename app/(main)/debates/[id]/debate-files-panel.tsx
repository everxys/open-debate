"use client";

import { type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactElement, useEffect, useMemo, useState } from "react";
import { Tree, type NodeApi } from "react-arborist";

import type { FsNode } from "@/lib/fs-tree";

type DebateFilesContextMenuTarget =
  | { type: "root" }
  | { type: "node"; path: string; nodeType: FsNode["type"] };

export type DebateFilesContextMenuValue = {
  x: number;
  y: number;
  target: DebateFilesContextMenuTarget;
};

function countTreeNodes(nodes: FsNode[]) {
  let total = 0;
  const stack = [...nodes];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    total += 1;
    if (node.children?.length) {
      for (const child of node.children) stack.push(child);
    }
  }
  return total;
}

function DebateFilesToolbar(props: {
  nodeCount: number;
  selectedCount: number;
  downloading: boolean;
  loading: boolean;
  onDownload: () => void;
  onRefresh: () => void;
}) {
  const downloadLabel = props.downloading
    ? "下载中..."
    : `下载选中${props.selectedCount > 0 ? `（${props.selectedCount}）` : ""}`;
  return (
    <div className="debateFilesToolbar">
      <div className="debateFilesToolbarMain">
        <div className="debateFilesToolbarTitleRow">
          <strong>辩论文件</strong>
        </div>
        <div className="debateFilesToolbarStats">
          {props.loading ? (
            <span className="muted debateFilesToolbarStat">正在读取文件树</span>
          ) : props.nodeCount > 0 ? (
            <>
              <span className="muted debateFilesToolbarStat">共 {props.nodeCount} 项</span>
              {props.selectedCount > 0 ? (
                <span className="muted debateFilesToolbarStat">已选 {props.selectedCount} 项</span>
              ) : null}
            </>
          ) : (
            <span className="muted debateFilesToolbarStat">尚未生成可浏览文件</span>
          )}
        </div>
      </div>
      <div className="debateFilesToolbarActions">
        <button
          className="btn debateFilesAction"
          type="button"
          disabled={props.selectedCount === 0 || props.downloading}
          onClick={props.onDownload}
        >
          <span className="debateFilesActionLabel" data-label={downloadLabel}>
            {downloadLabel}
          </span>
        </button>
        <button className="btn debateFilesAction" type="button" disabled={props.loading} onClick={props.onRefresh}>
          <span className="debateFilesActionLabel" data-label="刷新">
            刷新
          </span>
        </button>
      </div>
    </div>
  );
}

function DebateFilesContextMenu(props: {
  menu: DebateFilesContextMenuValue | null;
  selectedCount: number;
  downloading: boolean;
  onClose: () => void;
  onOpenFileInfo: (virtualPath: string) => void;
  onDownload: () => void;
}) {
  if (!props.menu) return null;
  const menu = props.menu;
  const canOpenFileInfo = menu.target.type === "node" && menu.target.nodeType === "file";

  return (
    <div className="contextOverlay" onClick={props.onClose}>
      <div className="contextMenu" style={{ left: menu.x, top: menu.y }} onClick={(event) => event.stopPropagation()}>
        <button
          className="contextMenuItem"
          type="button"
          disabled={!canOpenFileInfo}
          onClick={() => {
            if (!canOpenFileInfo || menu.target.type !== "node") return;
            props.onOpenFileInfo(menu.target.path);
          }}
        >
          查看文件状态与时间线
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

export function DebateFilesPanel(props: {
  selectedCount: number;
  downloading: boolean;
  loading: boolean;
  hasFiles: boolean;
  tree: FsNode[];
  renderNode: (props: { node: NodeApi<FsNode>; style: CSSProperties }) => ReactElement;
  contextMenu: DebateFilesContextMenuValue | null;
  onDownload: () => void;
  onRefresh: () => void;
  onRootContextMenu: (event: ReactMouseEvent<HTMLDivElement>) => void;
  onCloseContextMenu: () => void;
  onOpenFileInfo: (virtualPath: string) => void;
}) {
  const [maxTreeHeight, setMaxTreeHeight] = useState(520);
  const rowHeight = 48;
  const nodeCount = useMemo(() => countTreeNodes(props.tree), [props.tree]);

  const treeHeight = useMemo(() => {
    const estimatedRows = Math.max(1, nodeCount);
    return Math.min(maxTreeHeight, Math.max(128, estimatedRows * rowHeight + 8));
  }, [maxTreeHeight, nodeCount]);

  useEffect(() => {
    const syncMaxTreeHeight = () => {
      const viewportHeight = window.innerHeight || 900;
      const viewportWidth = window.innerWidth || 1440;
      const ratio = viewportWidth <= 720 ? 0.48 : viewportWidth <= 1180 ? 0.56 : 0.62;
      const next = Math.max(260, Math.floor(viewportHeight * ratio));
      setMaxTreeHeight((current) => (current === next ? current : next));
    };

    syncMaxTreeHeight();
    window.addEventListener("resize", syncMaxTreeHeight);
    return () => {
      window.removeEventListener("resize", syncMaxTreeHeight);
    };
  }, []);

  return (
    <div className="debateFilesLayout">
      <div className="softBox">
        <DebateFilesToolbar
          nodeCount={nodeCount}
          selectedCount={props.selectedCount}
          downloading={props.downloading}
          loading={props.loading}
          onDownload={props.onDownload}
          onRefresh={props.onRefresh}
        />
      </div>
      {props.loading ? (
        <div className="softBox muted debateFilesEmptyState">读取中...</div>
      ) : !props.hasFiles ? (
        <div className="softBox muted debateFilesEmptyState">暂无文件（通常需要至少一轮发言后才会逐步生成）。</div>
      ) : (
        <div className="softBox debateFilesTreeCard">
          <div className="debateFilesTreeFrame" onContextMenu={props.onRootContextMenu}>
            <Tree<FsNode> data={props.tree} width="100%" height={treeHeight} indent={18} rowHeight={rowHeight} openByDefault={false}>
              {props.renderNode}
            </Tree>
          </div>
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
