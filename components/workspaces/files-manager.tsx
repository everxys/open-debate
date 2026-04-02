"use client";

import MonacoEditor from "@monaco-editor/react";
import type { CSSProperties, MouseEvent as ReactMouseEvent, MutableRefObject } from "react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Tree, type NodeApi } from "react-arborist";

import { Portal } from "@/components/ui/portal";
import { useAutoDismissToast } from "@/components/ui/use-toast";
import { type FsNode, isKeepMarkerPath, joinFsPath, normalizeFsPath } from "@/lib/fs-tree";
import { useFsTree } from "@/lib/use-fs-tree";

type WorkspaceFile = {
  path: string;
  createdAt: string;
  updatedAt: string;
};

type WorkspaceFileWithContent = WorkspaceFile & { content: string };

type ContextTarget =
  | { type: "root" }
  | { type: "dir"; path: string }
  | { type: "file"; path: string };

function joinPath(base: string, leaf: string) {
  return joinFsPath(base, leaf);
}

function normalizeInputPath(value: string) {
  return normalizeFsPath(value);
}

function isInternalDirMarker(path: string) {
  return isKeepMarkerPath(path);
}

const TreeRow = memo(
  function TreeRow(props: {
    node: NodeApi<FsNode>;
    style: CSSProperties;
    activePath: string;
    dragOverDir: string | null;
    readOnly: boolean;
    actionsRef: MutableRefObject<{
      openFile: (path: string) => void;
      openContextMenu: (event: ReactMouseEvent<HTMLElement>, target: ContextTarget) => void;
      moveFile: (fromPath: string, toPath: string) => void;
    }>;
    setDragOverDir: (next: string | null | ((current: string | null) => string | null)) => void;
  }) {
    const { node, style, activePath, dragOverDir, readOnly, actionsRef, setDragOverDir } = props;
    const data = node.data;
    const isDir = data.type === "dir";
    const isActive = data.type === "file" && data.path === activePath;
    const dropActive = isDir && dragOverDir === data.path;

    return (
      <div
        style={style}
        className={`treeRow ${isActive ? "treeItemActive" : ""} ${dropActive ? "treeDropActive" : ""}`}
        onClick={() => {
          if (data.type === "file") actionsRef.current.openFile(data.path);
          else node.toggle();
        }}
        onContextMenu={(event) =>
          actionsRef.current.openContextMenu(
            event,
            isDir ? { type: "dir", path: data.path } : { type: "file", path: data.path }
          )
        }
        data-tree-type={isDir ? "dir" : "file"}
        data-tree-path={data.path}
        draggable={data.type === "file" && !readOnly}
        onDragStart={(event) => {
          if (readOnly || data.type !== "file") return;
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("application/x-open-debate-path", data.path);
          event.dataTransfer.setData("text/plain", data.path);
        }}
        onDragOver={(event) => {
          if (readOnly || !isDir) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          setDragOverDir((current) => (current === data.path ? current : data.path));
          if (!node.isOpen) node.open();
        }}
        onDragLeave={() => {
          if (!isDir) return;
          setDragOverDir((current) => (current === data.path ? null : current));
        }}
        onDrop={(event) => {
          if (readOnly || !isDir) return;
          event.preventDefault();
          const from =
            event.dataTransfer.getData("application/x-open-debate-path") || event.dataTransfer.getData("text/plain");
          setDragOverDir(null);
          if (!from) return;
          const filename = from.split("/").filter(Boolean).slice(-1)[0] ?? "";
          if (!filename) return;
          const to = joinPath(data.path, filename);
          actionsRef.current.moveFile(from, to);
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
  },
  (a, b) => {
    if (a.readOnly !== b.readOnly) return false;
    if (a.activePath !== b.activePath) return false;
    if (a.dragOverDir !== b.dragOverDir) return false;
    if (a.node.id !== b.node.id) return false;
    if (a.node.isOpen !== b.node.isOpen) return false;
    const at = a.style.transform ?? a.style.top;
    const bt = b.style.transform ?? b.style.top;
    return at === bt;
  }
);

export function WorkspaceFilesManager({
  workspaceId,
  readOnly,
  onChanged
}: {
  workspaceId: string;
  readOnly?: boolean;
  onChanged?: () => void;
}) {
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [contentByPath, setContentByPath] = useState<Record<string, string>>({});
  const [tabs, setTabs] = useState<Array<{ path: string; draft: string }>>([]);
  const [activePath, setActivePath] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isOpening, setIsOpening] = useState(false);
  const [creatingPath, setCreatingPath] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; target: ContextTarget } | null>(null);
  const [dragOverDir, setDragOverDir] = useState<string | null>(null);
  const { toast, showToast } = useAutoDismissToast(1200);
  const { treeData, reset: resetTree, upsertPath, deletePath, deletePaths, movePath } = useFsTree({
    normalizePath: normalizeInputPath,
    isDirMarker: isInternalDirMarker
  });
  const actionsRef = useRef<{
    openFile: (path: string) => void;
    openContextMenu: (event: ReactMouseEvent<HTMLElement>, target: ContextTarget) => void;
    moveFile: (fromPath: string, toPath: string) => void;
  }>({
    openFile: () => {},
    openContextMenu: () => {},
    moveFile: () => {}
  });

  async function load() {
    if (!workspaceId) return;
    const response = await fetch(`/api/workspaces/${workspaceId}/files`, { cache: "no-store" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      showToast("error", payload.error?.message ?? "加载工作台文件失败");
      return;
    }
    const nextFiles: WorkspaceFile[] = payload.data ?? [];
    setFiles(nextFiles);
    setContentByPath({});
    resetTree(nextFiles.map((file) => file.path));
  }

  useEffect(() => {
    setTabs([]);
    setActivePath("");
    void load();
  }, [workspaceId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!contextMenu) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setContextMenu(null);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [contextMenu]);

  const displayFiles = useMemo(() => files.filter((file) => !isInternalDirMarker(file.path)), [files]);
  const filesByPath = useMemo(() => new Set(files.map((file) => file.path)), [files]);

  const activeTab = useMemo(() => tabs.find((tab) => tab.path === activePath) ?? null, [tabs, activePath]);
  const activeFile = useMemo(() => files.find((file) => file.path === activePath) ?? null, [files, activePath]);

  const dirtyPaths = useMemo(() => {
    const dirty = new Set<string>();
    for (const tab of tabs) {
      const saved = contentByPath[tab.path] ?? "";
      if (tab.draft !== saved) dirty.add(tab.path);
    }
    return dirty;
  }, [tabs, contentByPath]);

  async function openFile(path: string) {
    if (!workspaceId || !filesByPath.has(path)) return;
    if (tabs.some((tab) => tab.path === path)) {
      setActivePath(path);
      return;
    }

    setIsOpening(true);
    try {
      const cached = contentByPath[path];
      if (cached !== undefined) {
        setTabs((current) => [...current, { path, draft: cached }]);
        setActivePath(path);
        return;
      }

      const response = await fetch(`/api/workspaces/${workspaceId}/files?path=${encodeURIComponent(path)}`, {
        cache: "no-store"
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        showToast("error", payload.error?.message ?? "读取工作台文件失败");
        return;
      }
      const file = payload.data as WorkspaceFileWithContent;
      setContentByPath((current) => ({ ...current, [path]: file.content ?? "" }));
      setTabs((current) => [...current, { path, draft: file.content ?? "" }]);
      setActivePath(path);
    } finally {
      setIsOpening(false);
    }
  }

  function closeTab(path: string) {
    setTabs((current) => {
      const remaining = current.filter((tab) => tab.path !== path);
      if (activePath === path) setActivePath(remaining[remaining.length - 1]?.path ?? "");
      return remaining;
    });
  }

  useEffect(() => {
    if (!activePath) return;
    if (tabs.some((tab) => tab.path === activePath)) return;
    setActivePath(tabs[tabs.length - 1]?.path ?? "");
  }, [tabs, activePath]);

  function openContextMenu(event: ReactMouseEvent<HTMLElement>, target: ContextTarget) {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({ x: event.clientX, y: event.clientY, target });
  }

  function inferContextTargetAtPoint(x: number, y: number): ContextTarget {
    const el = document.elementFromPoint(x, y);
    if (!el) return { type: "root" };
    const hit = el.closest<HTMLElement>("[data-tree-type]");
    const type = hit?.dataset.treeType;
    const path = hit?.dataset.treePath;
    if (type === "file" && path) return { type: "file", path };
    if (type === "dir" && path !== undefined) return { type: "dir", path };
    return { type: "root" };
  }

  async function createFileAt(baseDir: string) {
    if (readOnly) return;
    const raw = window.prompt("新建文件：输入相对路径（例如 workspace/ideas/raw-idea-bank.md）");
    if (!raw) return;
    const leaf = normalizeInputPath(raw);
    const path = normalizeInputPath(joinPath(baseDir, leaf));
    if (!path) return;
    if (path.endsWith("/")) {
      showToast("error", "路径必须是文件，不是目录");
      return;
    }
    if (path.includes("..")) {
      showToast("error", "路径不能包含 ..");
      return;
    }
    if (files.some((file) => file.path === path)) {
      showToast("error", "文件已存在");
      return;
    }

    setCreatingPath(path);
    try {
      const response = await fetch(`/api/workspaces/${workspaceId}/files`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, content: "" })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        showToast("error", payload.error?.message ?? "创建失败");
        return;
      }
      const created: WorkspaceFile = payload.data;
      setFiles((current) => {
        const others = current.filter((item) => item.path !== created.path);
        return [...others, created].sort((a, b) => a.path.localeCompare(b.path));
      });
      setContentByPath((current) => ({ ...current, [created.path]: "" }));
      upsertPath(created.path);
      onChanged?.();
      void openFile(created.path);
      showToast("success", "已创建");
    } finally {
      setCreatingPath(null);
    }
  }

  async function createFolderAt(baseDir: string) {
    if (readOnly) return;
    const raw = window.prompt("新建文件夹：输入相对路径（例如 workspace/ideas 或 workspace/reference）");
    if (!raw) return;
    const folder = normalizeInputPath(raw).replace(/\/+$/, "");
    const dirPath = normalizeInputPath(joinPath(normalizeInputPath(baseDir), folder)).replace(/\/+$/, "");
    if (!dirPath) return;
    if (dirPath.includes("..")) {
      showToast("error", "路径不能包含 ..");
      return;
    }
    const markerPath = `${dirPath}/.keep`;
    if (files.some((file) => file.path === markerPath)) {
      showToast("success", "文件夹已存在");
      return;
    }

    setCreatingPath(markerPath);
    try {
      const response = await fetch(`/api/workspaces/${workspaceId}/files`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: markerPath, content: "" })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        showToast("error", payload.error?.message ?? "创建失败");
        return;
      }
      const created: WorkspaceFile = payload.data;
      setFiles((current) => {
        const others = current.filter((item) => item.path !== created.path);
        return [...others, created].sort((a, b) => a.path.localeCompare(b.path));
      });
      setContentByPath((current) => ({ ...current, [created.path]: "" }));
      upsertPath(created.path);
      onChanged?.();
      showToast("success", "已创建文件夹");
    } finally {
      setCreatingPath(null);
    }
  }

  async function deleteFile(path: string) {
    if (!path || isDeleting || readOnly) return;
    setIsDeleting(true);
    try {
      const response = await fetch(`/api/workspaces/${workspaceId}/files`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        showToast("error", payload.error?.message ?? "删除失败");
        return;
      }
      setFiles((current) => current.filter((item) => item.path !== path));
      deletePath(path);
      setContentByPath((current) => {
        const next = { ...current };
        delete next[path];
        return next;
      });
      setTabs((current) => current.filter((tab) => tab.path !== path));
      if (activePath === path) setActivePath("");
      onChanged?.();
      showToast("success", "已删除");
    } finally {
      setIsDeleting(false);
    }
  }

  async function moveFile(fromPath: string, toPath: string) {
    if (readOnly) return;
    const from = normalizeInputPath(fromPath);
    const to = normalizeInputPath(toPath);
    if (!from || !to || from === to) return;
    let response: Response;
    try {
      response = await fetch(`/api/workspaces/${workspaceId}/files`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fromPath: from, toPath: to })
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showToast("error", `Failed to fetch: ${message}`);
      return;
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      showToast("error", payload.error?.message ?? "移动失败");
      return;
    }
    const moved: WorkspaceFile = payload.data;
    setFiles((current) => {
      const removed = current.filter((file) => file.path !== from);
      const original = current.find((file) => file.path === from);
      const keep = original ? { ...original, path: moved.path, updatedAt: moved.updatedAt } : moved;
      return [...removed, keep].sort((a, b) => a.path.localeCompare(b.path));
    });
    movePath(from, moved.path);
    setContentByPath((current) => {
      if (!(from in current)) return current;
      const next = { ...current };
      next[to] = next[from];
      delete next[from];
      return next;
    });
    setTabs((current) => current.map((tab) => (tab.path === from ? { ...tab, path: to } : tab)));
    if (activePath === from) setActivePath(to);
    onChanged?.();
    showToast("success", "已移动");
  }

  async function deleteFolder(dirPath: string) {
    if (isDeleting || readOnly) return;
    const prefix = dirPath ? `${dirPath.replace(/\/+$/, "")}/` : "";
    const targets = files.map((file) => file.path).filter((path) => path.startsWith(prefix));
    if (targets.length === 0) return;
    const ok = window.confirm(`删除文件夹 "${dirPath}/"（共 ${targets.length} 项）？`);
    if (!ok) return;

    setIsDeleting(true);
    try {
      const response = await fetch(`/api/workspaces/${workspaceId}/files`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prefix: dirPath })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        showToast("error", payload.error?.message ?? "删除失败");
        return;
      }
      setFiles((current) => current.filter((file) => !file.path.startsWith(prefix)));
      deletePaths(targets);
      setContentByPath((current) => {
        const next: Record<string, string> = {};
        for (const [key, value] of Object.entries(current)) {
          if (!key.startsWith(prefix)) next[key] = value;
        }
        return next;
      });
      setTabs((current) => current.filter((tab) => !tab.path.startsWith(prefix)));
      if (activePath.startsWith(prefix)) setActivePath("");
      onChanged?.();
      showToast("success", "已删除");
    } finally {
      setIsDeleting(false);
    }
  }

  async function save() {
    if (!activePath || isSaving || readOnly) return;
    const content = activeTab?.draft ?? "";
    setIsSaving(true);
    try {
      const response = await fetch(`/api/workspaces/${workspaceId}/files`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: activePath, content })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        showToast("error", payload.error?.message ?? "保存失败");
        return;
      }
      const updated: WorkspaceFileWithContent = payload.data;
      setFiles((current) => {
        const others = current.filter((file) => file.path !== updated.path);
        const meta: WorkspaceFile = { path: updated.path, createdAt: updated.createdAt, updatedAt: updated.updatedAt };
        return [...others, meta].sort((a, b) => a.path.localeCompare(b.path));
      });
      setContentByPath((current) => ({ ...current, [updated.path]: updated.content ?? "" }));
      onChanged?.();
      showToast("success", "已保存");
    } finally {
      setIsSaving(false);
    }
  }

  actionsRef.current.openFile = (path: string) => void openFile(path);
  actionsRef.current.openContextMenu = openContextMenu;
  actionsRef.current.moveFile = (fromPath: string, toPath: string) => void moveFile(fromPath, toPath);

  return (
    <>
      {toast ? (
        <Portal>
          <div className={`toast ${toast.type === "success" ? "toast-success" : "toast-error"}`} role="status" aria-live="polite">
            {toast.text}
          </div>
        </Portal>
      ) : null}

      <div className="grid grid-2" style={{ gap: 16, alignItems: "start" }}>
        <section className="panel stack">
          <div
            className="softBox stack filesTreeBox"
            onContextMenu={(event) => openContextMenu(event, { type: "root" })}
            onDragOver={(event) => {
              if (readOnly) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              setDragOverDir((current) => (current === "" ? current : ""));
            }}
            onDragLeave={() => setDragOverDir((current) => (current === "" ? null : current))}
            onDrop={(event) => {
              if (readOnly) return;
              event.preventDefault();
              const from =
                event.dataTransfer.getData("application/x-open-debate-path") || event.dataTransfer.getData("text/plain");
              setDragOverDir(null);
              if (!from) return;
              const filename = from.split("/").filter(Boolean).slice(-1)[0] ?? "";
              if (!filename) return;
              void moveFile(from, filename);
            }}
          >
            <div className="treeHeader">
              <div className="row" style={{ justifyContent: "space-between" }}>
                <strong>私有文件</strong>
                <span className="muted">{displayFiles.length} 个文件</span>
              </div>
            </div>

            {files.length > 0 ? (
              <div className={`treeRoot ${dragOverDir === "" ? "treeDropActive" : ""}`}>
                <Tree<FsNode> data={treeData} width="100%" height={620} indent={18} rowHeight={34} openByDefault={false}>
                  {(props) => (
                    <TreeRow
                      node={props.node}
                      style={props.style}
                      activePath={activePath}
                      dragOverDir={dragOverDir}
                      readOnly={Boolean(readOnly)}
                      actionsRef={actionsRef}
                      setDragOverDir={setDragOverDir}
                    />
                  )}
                </Tree>
              </div>
            ) : (
              <div className="muted">暂无私有文件</div>
            )}
          </div>
        </section>

        <section className="panel stack">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <div>
              <h2 style={{ margin: 0 }}>文件编辑</h2>
              <div className="muted">{activePath || "请选择一个文件"}</div>
            </div>
            <div className="row">
              <button className="btn" disabled={!activePath || isSaving || isOpening || Boolean(readOnly)} onClick={() => void save()}>
                {isSaving ? "保存中..." : "保存"}
              </button>
              <button
                className="btn btn-danger"
                disabled={!activePath || isDeleting || isOpening || Boolean(readOnly)}
                onClick={() => void deleteFile(activePath)}
              >
                {isDeleting ? "删除中..." : "删除"}
              </button>
            </div>
          </div>

          <div className="tabsBar">
            {tabs.map((tab) => {
              const name = tab.path.split("/").filter(Boolean).slice(-1)[0] ?? tab.path;
              const active = tab.path === activePath;
              const dirty = dirtyPaths.has(tab.path);
              return (
                <button key={tab.path} className={`tab ${active ? "tabActive" : ""}`} onClick={() => setActivePath(tab.path)} title={tab.path}>
                  <span className="tabName">{name}</span>
                  {dirty ? <span className="tabDirtyDot" aria-hidden="true" /> : null}
                  <span
                    className="tabClose"
                    role="button"
                    aria-label="Close tab"
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      closeTab(tab.path);
                    }}
                  >
                    ×
                  </span>
                </button>
              );
            })}
          </div>

          <div className="editorBox">
            <MonacoEditor
              language="markdown"
              theme="vs"
              value={activeTab?.draft ?? ""}
              onChange={(value) => {
                const next = value ?? "";
                setTabs((current) => current.map((tab) => (tab.path === activePath ? { ...tab, draft: next } : tab)));
              }}
              options={{
                readOnly: !activePath || Boolean(readOnly),
                minimap: { enabled: false },
                fontSize: 14,
                lineHeight: 22,
                scrollBeyondLastLine: false,
                wordWrap: "on",
                renderWhitespace: "selection",
                renderControlCharacters: false,
                tabSize: 2,
                folding: true
              }}
              height={520}
            />
          </div>

          {activeFile ? <div className="hint">最后更新：{new Date(activeFile.updatedAt).toLocaleString()}</div> : null}
        </section>
      </div>

      {contextMenu ? (
        <Portal>
          <div
            className="contextOverlay"
            onClick={() => setContextMenu(null)}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              const nextTarget = inferContextTargetAtPoint(event.clientX, event.clientY);
              setContextMenu({ x: event.clientX, y: event.clientY, target: nextTarget });
            }}
          >
            <div
              className="contextMenu"
              style={{ left: contextMenu.x, top: contextMenu.y }}
              onClick={(event) => event.stopPropagation()}
            >
              <button
                className="contextMenuItem"
                disabled={Boolean(creatingPath) || Boolean(readOnly)}
                onClick={() => {
                  const base =
                    contextMenu.target.type === "dir"
                      ? contextMenu.target.path
                      : contextMenu.target.type === "root"
                        ? ""
                        : contextMenu.target.type === "file"
                          ? contextMenu.target.path.split("/").slice(0, -1).join("/")
                          : "";
                  setContextMenu(null);
                  void createFolderAt(base);
                }}
              >
                {creatingPath ? "新建中..." : "新建文件夹"}
              </button>

              <button
                className="contextMenuItem"
                disabled={Boolean(creatingPath) || Boolean(readOnly)}
                onClick={() => {
                  const base =
                    contextMenu.target.type === "dir"
                      ? contextMenu.target.path
                      : contextMenu.target.type === "root"
                        ? ""
                        : contextMenu.target.type === "file"
                          ? contextMenu.target.path.split("/").slice(0, -1).join("/")
                          : "";
                  setContextMenu(null);
                  void createFileAt(base);
                }}
              >
                {creatingPath ? "新建中..." : "新建文件"}
              </button>

              {contextMenu.target.type === "file" ? (
                <button
                  className="contextMenuItem contextMenuDanger"
                  disabled={isDeleting || Boolean(readOnly)}
                  onClick={() => {
                    const path = contextMenu.target.type === "file" ? contextMenu.target.path : "";
                    setContextMenu(null);
                    void deleteFile(path);
                  }}
                >
                  删除文件
                </button>
              ) : contextMenu.target.type === "dir" ? (
                <button
                  className="contextMenuItem contextMenuDanger"
                  disabled={isDeleting || Boolean(readOnly)}
                  onClick={() => {
                    const dirPath = contextMenu.target.type === "dir" ? contextMenu.target.path : "";
                    setContextMenu(null);
                    void deleteFolder(dirPath);
                  }}
                >
                  删除文件夹
                </button>
              ) : null}
            </div>
          </div>
        </Portal>
      ) : null}
    </>
  );
}
