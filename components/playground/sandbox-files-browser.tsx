"use client";

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { Tree, type NodeApi } from "react-arborist";

import { createFsTreeModel, normalizeFsPath, type FsNode } from "@/lib/fs-tree";
import type {
  PlaygroundSandboxFileInput,
  PlaygroundSandboxFileSnapshot,
  PlaygroundSandboxFileScope
} from "@/lib/playground/types";

type BrowserFile = {
  id: string;
  scope: PlaygroundSandboxFileScope;
  path: string;
  content: string;
  size?: number;
  version?: number;
};

function toVirtualPath(scope: PlaygroundSandboxFileScope, path: string) {
  return `${scope}/${normalizeFsPath(path)}`;
}

const TreeRow = function TreeRow(props: {
  node: NodeApi<FsNode>;
  style: CSSProperties;
  activePath: string;
  onSelect: (path: string) => void;
}) {
  const { node, style, activePath, onSelect } = props;
  const data = node.data;
  const isDir = data.type === "dir";
  const isActive = data.type === "file" && data.path === activePath;

  return (
    <div
      style={style}
      className={`treeRow ${isActive ? "treeItemActive" : ""}`}
      onClick={() => {
        if (isDir) node.toggle();
        else onSelect(data.path);
      }}
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
};

export function PlaygroundSandboxFilesBrowser(props: {
  title: string;
  files: PlaygroundSandboxFileInput[] | PlaygroundSandboxFileSnapshot[];
  emptyText: string;
}) {
  const browserFiles = useMemo<BrowserFile[]>(
    () =>
      props.files.map((file) => ({
        id: `${file.scope}:${file.path}`,
        scope: file.scope,
        path: file.path,
        content: file.content,
        size: "size" in file ? file.size : undefined,
        version: "version" in file ? file.version : undefined
      })),
    [props.files]
  );

  const treeModel = useMemo(
    () =>
      createFsTreeModel({
        normalizePath: normalizeFsPath
      }),
    []
  );

  const treeData = useMemo(() => treeModel.reset(browserFiles.map((file) => toVirtualPath(file.scope, file.path))), [browserFiles, treeModel]);
  const fileByVirtualPath = useMemo(() => {
    const map = new Map<string, BrowserFile>();
    for (const file of browserFiles) {
      map.set(toVirtualPath(file.scope, file.path), file);
    }
    return map;
  }, [browserFiles]);

  const [activePath, setActivePath] = useState("");

  useEffect(() => {
    if (!browserFiles.length) {
      setActivePath("");
      return;
    }
    setActivePath((current) => (current && fileByVirtualPath.has(current) ? current : toVirtualPath(browserFiles[0].scope, browserFiles[0].path)));
  }, [browserFiles, fileByVirtualPath]);

  const activeFile = activePath ? fileByVirtualPath.get(activePath) ?? null : null;
  const treeHeight = Math.min(Math.max(browserFiles.length * 34 + 24, 220), 360);

  return (
    <div className="playgroundFileBrowser">
      <div className="softBox stack filesTreeBox playgroundFileBrowserTree">
        <div className="treeHeader">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <strong>{props.title}</strong>
            <span className="muted">{browserFiles.length} 个文件</span>
          </div>
        </div>
        {browserFiles.length === 0 ? (
          <div className="muted">{props.emptyText}</div>
        ) : (
          <div className="treeRoot">
            <Tree<FsNode> data={treeData} width="100%" height={treeHeight} indent={16} rowHeight={34} openByDefault={false}>
              {(treeProps) => (
                <TreeRow
                  node={treeProps.node}
                  style={treeProps.style}
                  activePath={activePath}
                  onSelect={setActivePath}
                />
              )}
            </Tree>
          </div>
        )}
      </div>

      <div className="playgroundFileBrowserPreview softBox stack">
        {!activeFile ? (
          <div className="muted">{props.emptyText}</div>
        ) : (
          <>
            <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
              <div className="stack" style={{ gap: 4, minWidth: 0 }}>
                <strong style={{ overflowWrap: "anywhere" }}>{activeFile.scope}:{activeFile.path}</strong>
                <div className="muted" style={{ fontSize: 12 }}>
                  {typeof activeFile.version === "number" ? `v${activeFile.version} · ` : ""}
                  {typeof activeFile.size === "number" ? `${activeFile.size} chars` : `${activeFile.content.length} chars`}
                </div>
              </div>
            </div>
            <pre className="playgroundPre">{activeFile.content}</pre>
          </>
        )}
      </div>
    </div>
  );
}
