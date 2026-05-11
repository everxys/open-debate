"use client";

import MonacoEditor from "@monaco-editor/react";
import type { CSSProperties, MouseEvent as ReactMouseEvent, MutableRefObject, ReactNode } from "react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Tree, type NodeApi } from "react-arborist";

import { Button } from "@/components/ui/button";
import { ToastOutlet } from "@/components/ui/feedback";
import { Portal } from "@/components/ui/portal";
import { useAutoDismissToast } from "@/components/ui/use-toast";
import { type FsNode, isKeepMarkerPath, joinFsPath, normalizeFsPath } from "@/lib/fs-tree";
import { useFsTree } from "@/lib/use-fs-tree";

export type FileWorkspaceFile = {
  path: string;
  createdAt?: string;
  updatedAt?: string;
  content?: string;
};

export type FileWorkspaceFileWithContent = FileWorkspaceFile & {
  content: string;
};

export type FileWorkspaceTarget =
  | { type: "root" }
  | { type: "dir"; path: string }
  | { type: "file"; path: string };

export type FileWorkspaceToast = (type: "success" | "error", text: string) => void;

export type FileWorkspaceAdapter = {
  list: () => Promise<FileWorkspaceFile[]>;
  read: (path: string) => Promise<FileWorkspaceFileWithContent>;
  upsert: (path: string, content: string) => Promise<FileWorkspaceFileWithContent>;
  deleteFile: (path: string) => Promise<void>;
  deleteDirectory: (prefix: string) => Promise<void>;
  moveFile: (fromPath: string, toPath: string) => Promise<FileWorkspaceFile>;
};

type FileWorkspaceMenuContext = {
  target: FileWorkspaceTarget;
  close: () => void;
  readOnly: boolean;
  showToast: FileWorkspaceToast;
};

export type FileWorkspaceProps = {
  adapter: FileWorkspaceAdapter;
  resetKey: string;
  readOnly?: boolean;
  isTargetReadOnly?: (target: FileWorkspaceTarget) => boolean;
  onChanged?: () => void | Promise<void>;
  layout?: "fragment" | "grid";
  className?: string;
  sidebarHeader?: ReactNode;
  treeTitle?: ReactNode;
  treeEmptyText?: ReactNode;
  editorTitle?: ReactNode;
  editorEmptyPathText?: string;
  countLabel?: (count: number) => ReactNode;
  createFilePrompt?: string;
  createFolderPrompt?: string;
  showCreateFileButton?: boolean;
  renderPathBadge?: (target: Exclude<FileWorkspaceTarget, { type: "root" }>) => ReactNode;
  badgeVersion?: string;
  renderContextItems?: (context: FileWorkspaceMenuContext) => ReactNode;
  treeHeight?: number | "auto";
  editorHeight?: number | "auto";
  treeIndent?: number;
  rowHeight?: number;
};

type OpenTab = {
  path: string;
  draft: string;
};

type TreeActions = {
  openFile: (path: string) => void;
  openContextMenu: (event: ReactMouseEvent<HTMLElement>, target: FileWorkspaceTarget) => void;
  moveFile: (fromPath: string, toPath: string) => void;
};

function normalizeInputPath(value: string) {
  return normalizeFsPath(value);
}

function isInternalDirMarker(path: string) {
  return isKeepMarkerPath(path);
}

function joinPath(base: string, leaf: string) {
  return joinFsPath(base, leaf);
}

function pathBaseDir(target: FileWorkspaceTarget) {
  if (target.type === "dir") return target.path;
  if (target.type === "file") return target.path.split("/").slice(0, -1).join("/");
  return "";
}

function fileName(path: string) {
  return path.split("/").filter(Boolean).slice(-1)[0] ?? path;
}

function defaultCountLabel(count: number) {
  return `${count} 个文件`;
}

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return fallback;
}

function sortFiles(files: FileWorkspaceFile[]) {
  return [...files].sort((a, b) => a.path.localeCompare(b.path));
}

const TreeRow = memo(
  function TreeRow(props: {
    node: NodeApi<FsNode>;
    style: CSSProperties;
    activePath: string;
    dragOverDir: string | null;
    readOnly: boolean;
    targetReadOnly: boolean;
    badge: ReactNode;
    badgeVersion: string;
    actionsRef: MutableRefObject<TreeActions>;
    setDragOverDir: (next: string | null | ((current: string | null) => string | null)) => void;
  }) {
    const {
      node,
      style,
      activePath,
      dragOverDir,
      readOnly,
      targetReadOnly,
      badge,
      actionsRef,
      setDragOverDir
    } = props;
    const data = node.data;
    const isDir = data.type === "dir";
    const isActive = data.type === "file" && data.path === activePath;
    const dropActive = isDir && dragOverDir === data.path;
    const disabled = readOnly || targetReadOnly;

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
        draggable={data.type === "file" && !disabled}
        onDragStart={(event) => {
          if (disabled || data.type !== "file") return;
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("application/x-open-debate-path", data.path);
          event.dataTransfer.setData("text/plain", data.path);
        }}
        onDragOver={(event) => {
          if (disabled || !isDir) return;
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
          if (disabled || !isDir) return;
          event.preventDefault();
          const from =
            event.dataTransfer.getData("application/x-open-debate-path") ||
            event.dataTransfer.getData("text/plain");
          setDragOverDir(null);
          if (!from) return;
          const filename = fileName(from);
          if (!filename) return;
          actionsRef.current.moveFile(from, joinPath(data.path, filename));
        }}
      >
        {isDir ? (
          <span className="treeIcon" aria-hidden="true">
            {node.isOpen ? "▾" : "▸"}
          </span>
        ) : (
          <span className="treeIcon treeIconFile" aria-hidden="true" />
        )}
        <span className={`treeLabel ${isDir ? "treeDirLabel" : ""}`}>
          {isDir ? `${data.name}/` : data.name}
        </span>
        {badge}
      </div>
    );
  },
  (a, b) => {
    if (a.readOnly !== b.readOnly) return false;
    if (a.targetReadOnly !== b.targetReadOnly) return false;
    if (a.activePath !== b.activePath) return false;
    if (a.dragOverDir !== b.dragOverDir) return false;
    if (a.badgeVersion !== b.badgeVersion) return false;
    if (a.node.id !== b.node.id) return false;
    if (a.node.isOpen !== b.node.isOpen) return false;
    const at = a.style.transform ?? a.style.top;
    const bt = b.style.transform ?? b.style.top;
    return at === bt;
  }
);

export function FileWorkspace({
  adapter,
  resetKey,
  readOnly,
  isTargetReadOnly,
  onChanged,
  layout = "fragment",
  className,
  sidebarHeader,
  treeTitle = "目录",
  treeEmptyText = "暂无文件",
  editorTitle = "编辑",
  editorEmptyPathText = "",
  countLabel = defaultCountLabel,
  createFilePrompt = "新建文件：输入相对路径（例如 prompts/AGENTS.md）",
  createFolderPrompt = "新建文件夹：输入相对路径（例如 prompts 或 prompts/system）",
  showCreateFileButton = false,
  renderPathBadge,
  badgeVersion = "",
  renderContextItems,
  treeHeight = 620,
  editorHeight = 520,
  treeIndent = 18,
  rowHeight = 34
}: FileWorkspaceProps) {
  const adapterRef = useRef(adapter);
  adapterRef.current = adapter;

  const [files, setFiles] = useState<FileWorkspaceFile[]>([]);
  const [contentByPath, setContentByPath] = useState<Record<string, string>>({});
  const [tabs, setTabs] = useState<OpenTab[]>([]);
  const [activePath, setActivePath] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isOpening, setIsOpening] = useState(false);
  const [creatingPath, setCreatingPath] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; target: FileWorkspaceTarget } | null>(null);
  const [dragOverDir, setDragOverDir] = useState<string | null>(null);
  const [measuredTreeHeight, setMeasuredTreeHeight] = useState(520);
  const [measuredEditorHeight, setMeasuredEditorHeight] = useState(520);
  const treeRootRef = useRef<HTMLDivElement | null>(null);
  const editorBoxRef = useRef<HTMLDivElement | null>(null);
  const { toast, showToast } = useAutoDismissToast(1200);
  const { treeData, reset: resetTree, upsertPath, deletePath, deletePaths, movePath } = useFsTree({
    normalizePath: normalizeInputPath,
    isDirMarker: isInternalDirMarker
  });
  const actionsRef = useRef<TreeActions>({
    openFile: () => {},
    openContextMenu: () => {},
    moveFile: () => {}
  });

  const displayFiles = useMemo(() => files.filter((file) => !isInternalDirMarker(file.path)), [files]);
  const filesByPath = useMemo(() => new Set(files.map((file) => file.path)), [files]);
  const activeTab = useMemo(() => tabs.find((tab) => tab.path === activePath) ?? null, [tabs, activePath]);
  const activeFile = useMemo(() => files.find((file) => file.path === activePath) ?? null, [files, activePath]);
  const activeTargetReadOnly = Boolean(activePath && isTargetReadOnly?.({ type: "file", path: activePath }));
  const effectiveReadOnly = Boolean(readOnly);

  const dirtyPaths = useMemo(() => {
    const dirty = new Set<string>();
    for (const tab of tabs) {
      const saved = contentByPath[tab.path] ?? "";
      if (tab.draft !== saved) dirty.add(tab.path);
    }
    return dirty;
  }, [tabs, contentByPath]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const nextFiles = await adapterRef.current.list();
        if (cancelled) return;
        setFiles(sortFiles(nextFiles));
        setContentByPath({});
        setTabs([]);
        setActivePath("");
        resetTree(nextFiles.map((file) => file.path));
      } catch (error) {
        if (!cancelled) showToast("error", errorMessage(error, "加载文件失败"));
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [resetKey, resetTree, showToast]);

  useEffect(() => {
    if (!contextMenu) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setContextMenu(null);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [contextMenu]);

  useEffect(() => {
    if (treeHeight !== "auto") return;
    const node = treeRootRef.current;
    if (!node) return;
    const observer = new ResizeObserver(() => {
      setMeasuredTreeHeight(Math.max(node.clientHeight, 220));
    });
    observer.observe(node);
    setMeasuredTreeHeight(Math.max(node.clientHeight, 220));
    return () => observer.disconnect();
  }, [treeHeight]);

  useEffect(() => {
    if (editorHeight !== "auto") return;
    const node = editorBoxRef.current;
    if (!node) return;
    const observer = new ResizeObserver(() => {
      setMeasuredEditorHeight(Math.max(node.clientHeight, 260));
    });
    observer.observe(node);
    setMeasuredEditorHeight(Math.max(node.clientHeight, 260));
    return () => observer.disconnect();
  }, [editorHeight]);

  useEffect(() => {
    if (!activePath) return;
    if (tabs.some((tab) => tab.path === activePath)) return;
    setActivePath(tabs[tabs.length - 1]?.path ?? "");
  }, [tabs, activePath]);

  function upsertFileState(file: FileWorkspaceFile) {
    setFiles((current) => {
      const others = current.filter((item) => item.path !== file.path);
      return sortFiles([...others, file]);
    });
    upsertPath(file.path);
  }

  async function notifyChanged() {
    await onChanged?.();
  }

  async function openFile(path: string) {
    if (!filesByPath.has(path)) return;
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

      const file = await adapterRef.current.read(path);
      const content = file.content ?? "";
      setContentByPath((current) => ({ ...current, [path]: content }));
      setTabs((current) => [...current, { path, draft: content }]);
      setActivePath(path);
    } catch (error) {
      showToast("error", errorMessage(error, "读取文件失败"));
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

  function openContextMenu(event: ReactMouseEvent<HTMLElement>, target: FileWorkspaceTarget) {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({ x: event.clientX, y: event.clientY, target });
  }

  function inferContextTargetAtPoint(x: number, y: number): FileWorkspaceTarget {
    const el = document.elementFromPoint(x, y);
    if (!el) return { type: "root" };
    const hit = el.closest<HTMLElement>("[data-tree-type]");
    const type = hit?.dataset.treeType;
    const path = hit?.dataset.treePath;
    if (type === "file" && path) return { type: "file", path };
    if (type === "dir" && path !== undefined) return { type: "dir", path };
    return { type: "root" };
  }

  function targetIsReadOnly(target: FileWorkspaceTarget) {
    return effectiveReadOnly || Boolean(isTargetReadOnly?.(target));
  }

  async function createFileAt(baseDir: string) {
    if (targetIsReadOnly(baseDir ? { type: "dir", path: baseDir } : { type: "root" })) return;
    const raw = window.prompt(createFilePrompt);
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
      const created = await adapterRef.current.upsert(path, "");
      const meta: FileWorkspaceFile = {
        path: created.path,
        createdAt: created.createdAt,
        updatedAt: created.updatedAt,
        content: created.content
      };
      upsertFileState(meta);
      setContentByPath((current) => ({ ...current, [created.path]: created.content ?? "" }));
      setTabs((current) =>
        current.some((tab) => tab.path === created.path)
          ? current
          : [...current, { path: created.path, draft: created.content ?? "" }]
      );
      setActivePath(created.path);
      await notifyChanged();
      showToast("success", "已创建");
    } catch (error) {
      showToast("error", errorMessage(error, "创建失败"));
    } finally {
      setCreatingPath(null);
    }
  }

  async function createFolderAt(baseDir: string) {
    if (targetIsReadOnly(baseDir ? { type: "dir", path: baseDir } : { type: "root" })) return;
    const raw = window.prompt(createFolderPrompt);
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
      const created = await adapterRef.current.upsert(markerPath, "");
      upsertFileState({
        path: created.path,
        createdAt: created.createdAt,
        updatedAt: created.updatedAt,
        content: created.content
      });
      setContentByPath((current) => ({ ...current, [created.path]: created.content ?? "" }));
      await notifyChanged();
      showToast("success", "已创建文件夹");
    } catch (error) {
      showToast("error", errorMessage(error, "创建失败"));
    } finally {
      setCreatingPath(null);
    }
  }

  async function deleteFile(path: string) {
    if (!path || isDeleting || targetIsReadOnly({ type: "file", path })) return;
    setIsDeleting(true);
    try {
      await adapterRef.current.deleteFile(path);
      setFiles((current) => current.filter((item) => item.path !== path));
      deletePath(path);
      setContentByPath((current) => {
        const next = { ...current };
        delete next[path];
        return next;
      });
      setTabs((current) => current.filter((tab) => tab.path !== path));
      if (activePath === path) setActivePath("");
      await notifyChanged();
      showToast("success", "已删除");
    } catch (error) {
      showToast("error", errorMessage(error, "删除失败"));
    } finally {
      setIsDeleting(false);
    }
  }

  async function deleteFolder(dirPath: string) {
    if (isDeleting || targetIsReadOnly({ type: "dir", path: dirPath })) return;
    const prefix = dirPath ? `${dirPath.replace(/\/+$/, "")}/` : "";
    const targets = files.map((file) => file.path).filter((path) => path.startsWith(prefix));
    if (targets.length === 0) return;
    const ok = window.confirm(`删除文件夹 "${dirPath}/"（共 ${targets.length} 项）？`);
    if (!ok) return;

    setIsDeleting(true);
    try {
      await adapterRef.current.deleteDirectory(dirPath);
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
      await notifyChanged();
      showToast("success", "已删除");
    } catch (error) {
      showToast("error", errorMessage(error, "删除失败"));
    } finally {
      setIsDeleting(false);
    }
  }

  async function moveFile(fromPath: string, toPath: string) {
    const from = normalizeInputPath(fromPath);
    const to = normalizeInputPath(toPath);
    if (!from || !to || from === to || targetIsReadOnly({ type: "file", path: from })) return;
    if (files.some((file) => file.path === to)) {
      showToast("error", "目标路径已存在");
      return;
    }

    try {
      const moved = await adapterRef.current.moveFile(from, to);
      const nextPath = normalizeInputPath(moved.path || to);
      setFiles((current) => {
        const removed = current.filter((file) => file.path !== from);
        const original = current.find((file) => file.path === from);
        const keep = {
          ...(original ?? {}),
          ...moved,
          path: nextPath,
          updatedAt: moved.updatedAt ?? original?.updatedAt
        };
        return sortFiles([...removed, keep]);
      });
      movePath(from, nextPath);
      setContentByPath((current) => {
        if (!(from in current)) return current;
        const next = { ...current };
        next[nextPath] = next[from];
        delete next[from];
        return next;
      });
      setTabs((current) => current.map((tab) => (tab.path === from ? { ...tab, path: nextPath } : tab)));
      if (activePath === from) setActivePath(nextPath);
      await notifyChanged();
      showToast("success", "已移动");
    } catch (error) {
      showToast("error", errorMessage(error, "移动失败"));
    }
  }

  async function save() {
    if (!activePath || isSaving || targetIsReadOnly({ type: "file", path: activePath })) return;
    const content = activeTab?.draft ?? "";
    setIsSaving(true);
    try {
      const updated = await adapterRef.current.upsert(activePath, content);
      upsertFileState({
        path: updated.path,
        createdAt: updated.createdAt,
        updatedAt: updated.updatedAt,
        content: updated.content
      });
      setContentByPath((current) => ({ ...current, [updated.path]: updated.content ?? content }));
      await notifyChanged();
      showToast("success", "已保存");
    } catch (error) {
      showToast("error", errorMessage(error, "保存失败"));
    } finally {
      setIsSaving(false);
    }
  }

  actionsRef.current.openFile = (path: string) => void openFile(path);
  actionsRef.current.openContextMenu = openContextMenu;
  actionsRef.current.moveFile = (fromPath: string, toPath: string) => void moveFile(fromPath, toPath);

  const renderedTreeHeight = treeHeight === "auto" ? measuredTreeHeight : treeHeight;
  const renderedEditorHeight = editorHeight === "auto" ? measuredEditorHeight : editorHeight;

  const treePanel = (
    <section className="panel stack">
      {sidebarHeader}
      <div
        className="softBox stack filesTreeBox"
        onContextMenu={(event) => openContextMenu(event, { type: "root" })}
        onDragOver={(event) => {
          if (effectiveReadOnly) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          setDragOverDir((current) => (current === "" ? current : ""));
        }}
        onDragLeave={() => setDragOverDir((current) => (current === "" ? null : current))}
        onDrop={(event) => {
          if (effectiveReadOnly) return;
          event.preventDefault();
          const from =
            event.dataTransfer.getData("application/x-open-debate-path") ||
            event.dataTransfer.getData("text/plain");
          setDragOverDir(null);
          if (!from) return;
          const filename = fileName(from);
          if (!filename) return;
          void moveFile(from, filename);
        }}
      >
        <div className="treeHeader">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <strong>{treeTitle}</strong>
            <span className="muted">{countLabel(displayFiles.length)}</span>
          </div>
        </div>

        {files.length > 0 ? (
          <div ref={treeRootRef} className={`treeRoot ${dragOverDir === "" ? "treeDropActive" : ""}`}>
            <Tree<FsNode>
              data={treeData}
              width="100%"
              height={renderedTreeHeight}
              indent={treeIndent}
              rowHeight={rowHeight}
              openByDefault={false}
            >
              {(props) => {
                const target =
                  props.node.data.type === "dir"
                    ? ({ type: "dir", path: props.node.data.path } as const)
                    : ({ type: "file", path: props.node.data.path } as const);
                return (
                  <TreeRow
                    node={props.node}
                    style={props.style}
                    activePath={activePath}
                    dragOverDir={dragOverDir}
                    readOnly={effectiveReadOnly}
                    targetReadOnly={Boolean(isTargetReadOnly?.(target))}
                    badge={renderPathBadge?.(target) ?? null}
                    badgeVersion={badgeVersion}
                    actionsRef={actionsRef}
                    setDragOverDir={setDragOverDir}
                  />
                );
              }}
            </Tree>
          </div>
        ) : (
          <div className="muted">{treeEmptyText}</div>
        )}

        {showCreateFileButton ? (
          <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
            <Button disabled={effectiveReadOnly || Boolean(creatingPath)} onClick={() => void createFileAt("")}>
              {creatingPath ? "新建中..." : "新建文件"}
            </Button>
            <div className="muted">{isOpening ? "打开中..." : ""}</div>
          </div>
        ) : null}
      </div>
    </section>
  );

  const editorPanel = (
    <section className="panel stack">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div>
          <h2 style={{ margin: 0 }}>{editorTitle}</h2>
          <div className="muted">{activePath || editorEmptyPathText}</div>
        </div>
        <div className="row">
          <Button disabled={!activePath || isSaving || isOpening || activeTargetReadOnly || effectiveReadOnly} onClick={() => void save()}>
            {isSaving ? "保存中..." : "保存"}
          </Button>
          <Button
            variant="danger"
            disabled={!activePath || isDeleting || isOpening || activeTargetReadOnly || effectiveReadOnly}
            onClick={() => void deleteFile(activePath)}
          >
            {isDeleting ? "删除中..." : "删除"}
          </Button>
        </div>
      </div>

      <div className="tabsBar">
        {tabs.map((tab) => {
          const active = tab.path === activePath;
          const dirty = dirtyPaths.has(tab.path);
          return (
            <button
              key={tab.path}
              className={`tab ${active ? "tabActive" : ""}`}
              onClick={() => setActivePath(tab.path)}
              title={tab.path}
            >
              <span className="tabName">{fileName(tab.path)}</span>
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

      <div ref={editorBoxRef} className="editorBox">
        <MonacoEditor
          language="markdown"
          theme="vs"
          value={activeTab?.draft ?? ""}
          onChange={(value) => {
            const next = value ?? "";
            setTabs((current) =>
              current.map((tab) => (tab.path === activePath ? { ...tab, draft: next } : tab))
            );
          }}
          options={{
            readOnly: !activePath || activeTargetReadOnly || effectiveReadOnly,
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
          height={renderedEditorHeight}
        />
      </div>

      {activeFile?.updatedAt ? (
        <div className="hint">最后更新：{new Date(activeFile.updatedAt).toLocaleString()}</div>
      ) : null}
    </section>
  );

  const body =
    layout === "grid" ? (
      <div className={`grid grid-2${className ? ` ${className}` : ""}`} style={{ gap: 16, alignItems: "start" }}>
        {treePanel}
        {editorPanel}
      </div>
    ) : (
      <>
        {treePanel}
        {editorPanel}
      </>
    );

  return (
    <>
      <ToastOutlet toast={toast} />
      {body}
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
                disabled={Boolean(creatingPath) || targetIsReadOnly(contextMenu.target)}
                onClick={() => {
                  const base = pathBaseDir(contextMenu.target);
                  setContextMenu(null);
                  void createFolderAt(base);
                }}
              >
                {creatingPath ? "新建中..." : "新建文件夹"}
              </button>
              <button
                className="contextMenuItem"
                disabled={Boolean(creatingPath) || targetIsReadOnly(contextMenu.target)}
                onClick={() => {
                  const base = pathBaseDir(contextMenu.target);
                  setContextMenu(null);
                  void createFileAt(base);
                }}
              >
                {creatingPath ? "新建中..." : "新建文件"}
              </button>

              {renderContextItems?.({
                target: contextMenu.target,
                close: () => setContextMenu(null),
                readOnly: targetIsReadOnly(contextMenu.target),
                showToast
              })}

              {contextMenu.target.type === "file" ? (
                <button
                  className="contextMenuItem contextMenuDanger"
                  disabled={isDeleting || targetIsReadOnly(contextMenu.target)}
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
                  disabled={isDeleting || targetIsReadOnly(contextMenu.target)}
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
