"use client";

import MonacoEditor from "@monaco-editor/react";
import Link from "next/link";
import { useParams } from "next/navigation";
import type { CSSProperties, MouseEvent as ReactMouseEvent, MutableRefObject } from "react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Tree, type NodeApi } from "react-arborist";

import { useAutoDismissToast } from "@/components/ui/use-toast";
import { type FsNode, isKeepMarkerPath, joinFsPath, normalizeFsPath } from "@/lib/fs-tree";
import { useFsTree } from "@/lib/use-fs-tree";

type Agent = {
  id: string;
  name: string;
  provider: string;
  model: string;
  baseUrl: string;
};

type AgentFile = {
  path: string;
  createdAt: string;
  updatedAt: string;
};

type AgentFileWithContent = AgentFile & { content: string };

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
    actionsRef: MutableRefObject<{
      openFile: (path: string) => void;
      openContextMenu: (event: ReactMouseEvent<HTMLElement>, target: ContextTarget) => void;
      moveFile: (fromPath: string, toPath: string) => void;
    }>;
    setDragOverDir: (next: string | null | ((current: string | null) => string | null)) => void;
  }) {
    const { node, style, activePath, dragOverDir, actionsRef, setDragOverDir } = props;
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
        draggable={data.type === "file"}
        onDragStart={(event) => {
          if (data.type !== "file") return;
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("application/x-open-debate-path", data.path);
          event.dataTransfer.setData("text/plain", data.path);
        }}
        onDragOver={(event) => {
          if (!isDir) return;
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
          if (!isDir) return;
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
    if (a.activePath !== b.activePath) return false;
    if (a.dragOverDir !== b.dragOverDir) return false;
    if (a.node.id !== b.node.id) return false;
    if (a.node.isOpen !== b.node.isOpen) return false;
    const at = a.style.transform ?? a.style.top;
    const bt = b.style.transform ?? b.style.top;
    return at === bt;
  }
);

export default function AgentFilesPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;

  const [agent, setAgent] = useState<Agent | null>(null);
  const [files, setFiles] = useState<AgentFile[]>([]);
  const [contentByPath, setContentByPath] = useState<Record<string, string>>({});
  const [tabs, setTabs] = useState<Array<{ path: string; draft: string }>>([]);
  const [activePath, setActivePath] = useState<string>("");
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isOpening, setIsOpening] = useState(false);
  const [creatingPath, setCreatingPath] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    target: ContextTarget;
  } | null>(null);
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
    if (!id) return;
    const [agentRes, filesRes] = await Promise.all([
      fetch(`/api/agents/${id}`),
      fetch(`/api/agents/${id}/files`)
    ]);
    const agentPayload = await agentRes.json();
    const filesPayload = await filesRes.json();

    if (!agentRes.ok) {
      showToast("error", agentPayload.error?.message ?? "加载失败");
      return;
    }
    if (!filesRes.ok) {
      showToast("error", filesPayload.error?.message ?? "加载文件失败");
      return;
    }

    setAgent(agentPayload.data);
    const nextFiles: AgentFile[] = filesPayload.data ?? [];
    setFiles(nextFiles);
    setContentByPath({});
    setTabs([]);
    setActivePath("");
    resetTree(nextFiles.map((file) => file.path));
  }

  useEffect(() => {
    void load();
  }, [id]);

  const displayFiles = useMemo(() => files.filter((file) => !isInternalDirMarker(file.path)), [files]);

  const filesByPath = useMemo(() => new Set(files.map((f) => f.path)), [files]);

  const activeTab = useMemo(
    () => tabs.find((tab) => tab.path === activePath) ?? null,
    [tabs, activePath]
  );

  const activeFile = useMemo(() => {
    return files.find((file) => file.path === activePath) ?? null;
  }, [files, activePath]);

  useEffect(() => {
    if (!contextMenu) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setContextMenu(null);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [contextMenu]);

  const dirtyPaths = useMemo(() => {
    const dirty = new Set<string>();
    for (const tab of tabs) {
      const saved = contentByPath[tab.path] ?? "";
      if (tab.draft !== saved) dirty.add(tab.path);
    }
    return dirty;
  }, [tabs, contentByPath]);

  async function openFile(path: string) {
    if (!id) return;
    if (!filesByPath.has(path)) return;
    if (tabs.some((t) => t.path === path)) {
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

      const response = await fetch(`/api/agents/${id}/files?path=${encodeURIComponent(path)}`, { cache: "no-store" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        showToast("error", payload.error?.message ?? "读取文件失败");
        return;
      }
      const file = payload.data as AgentFileWithContent;
      setContentByPath((current) => ({ ...current, [path]: file.content ?? "" }));
      setTabs((current) => [...current, { path, draft: file.content ?? "" }]);
      setActivePath(path);
    } finally {
      setIsOpening(false);
    }
  }

  function closeTab(path: string) {
    setTabs((current) => {
      const remaining = current.filter((t) => t.path !== path);
      if (activePath === path) {
        const next = remaining[remaining.length - 1]?.path ?? "";
        setActivePath(next);
      }
      return remaining;
    });
  }

  useEffect(() => {
    if (!activePath) return;
    if (tabs.some((t) => t.path === activePath)) return;
    const next = tabs[tabs.length - 1]?.path ?? "";
    setActivePath(next);
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
    if (!id) return;
    const raw = window.prompt("新建文件：输入相对路径（例如 prompts/AGENTS.md）");
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
      const response = await fetch(`/api/agents/${id}/files`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, content: "" })
      });
      const payload = await response.json();
      if (!response.ok) {
        showToast("error", payload.error?.message ?? "创建失败");
        return;
      }

      const created: AgentFile = payload.data;
      setFiles((current) => {
        const others = current.filter((item) => item.path !== created.path);
        const meta: AgentFile = { path: created.path, createdAt: created.createdAt, updatedAt: created.updatedAt };
        return [...others, meta].sort((a, b) => a.path.localeCompare(b.path));
      });
      setContentByPath((current) => ({ ...current, [created.path]: "" }));
      upsertPath(created.path);

      void openFile(created.path);
      showToast("success", "已创建");
    } finally {
      setCreatingPath(null);
    }
  }

  async function createFolderAt(baseDir: string) {
    if (!id) return;
    const raw = window.prompt("新建文件夹：输入相对路径（例如 prompts 或 prompts/system）");
    if (!raw) return;

    const folder = normalizeInputPath(raw).replace(/\/+$/, "");
    const base = normalizeInputPath(baseDir);
    const dirPath = normalizeInputPath(joinPath(base, folder)).replace(/\/+$/, "");
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
      const response = await fetch(`/api/agents/${id}/files`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: markerPath, content: "" })
      });
      const payload = await response.json();
      if (!response.ok) {
        showToast("error", payload.error?.message ?? "创建失败");
        return;
      }

      const created: AgentFile = payload.data;
      setFiles((current) => {
        const others = current.filter((item) => item.path !== created.path);
        const meta: AgentFile = { path: created.path, createdAt: created.createdAt, updatedAt: created.updatedAt };
        return [...others, meta].sort((a, b) => a.path.localeCompare(b.path));
      });
      setContentByPath((current) => ({ ...current, [created.path]: "" }));
      upsertPath(created.path);

      showToast("success", "已创建文件夹");
    } finally {
      setCreatingPath(null);
    }
  }

  async function deleteFile(path: string) {
    if (!id || !path || isDeleting) return;
    setIsDeleting(true);
    try {
      const response = await fetch(`/api/agents/${id}/files`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path })
      });
      const payload = await response.json();
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
      setTabs((current) => current.filter((t) => t.path !== path));
      if (activePath === path) setActivePath("");
      showToast("success", "已删除");
    } finally {
      setIsDeleting(false);
    }
  }

  async function moveFile(fromPath: string, toPath: string) {
    if (!id) return;
    const from = normalizeInputPath(fromPath);
    const to = normalizeInputPath(toPath);
    if (!from || !to || from === to) return;

    let response: Response;
    try {
      response = await fetch(`/api/agents/${id}/files`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fromPath: from, toPath: to })
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showToast("error", `Failed to fetch: ${message}`);
      return;
    }

    const payload = await response.json();
    if (!response.ok) {
      showToast("error", payload.error?.message ?? "移动失败");
      return;
    }

    const moved: AgentFile = payload.data;
    setFiles((current) => {
      const removed = current.filter((f) => f.path !== from);
      const original = current.find((f) => f.path === from);
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
    setTabs((current) => current.map((t) => (t.path === from ? { ...t, path: to } : t)));
    if (activePath === from) setActivePath(to);
    showToast("success", "已移动");
  }

  async function deleteFolder(dirPath: string) {
    if (!id || isDeleting) return;
    const prefix = dirPath ? `${dirPath.replace(/\/+$/, "")}/` : "";
    const targets = files.map((f) => f.path).filter((path) => path.startsWith(prefix));
    if (targets.length === 0) return;

    const ok = window.confirm(`删除文件夹 "${dirPath}/"（共 ${targets.length} 项）？`);
    if (!ok) return;

    setIsDeleting(true);
    try {
      const response = await fetch(`/api/agents/${id}/files`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prefix: dirPath })
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        showToast("error", payload?.error?.message ?? "删除失败");
        return;
      }
      setFiles((current) => current.filter((f) => !f.path.startsWith(prefix)));
      deletePaths(targets);
      setContentByPath((current) => {
        const next: Record<string, string> = {};
        for (const [key, value] of Object.entries(current)) {
          if (!key.startsWith(prefix)) next[key] = value;
        }
        return next;
      });
      setTabs((current) => current.filter((t) => !t.path.startsWith(prefix)));
      if (activePath.startsWith(prefix)) setActivePath("");
      showToast("success", "已删除");
    } finally {
      setIsDeleting(false);
    }
  }

  async function save() {
    if (!id || !activePath || isSaving) return;
    const content = activeTab?.draft ?? "";
    setIsSaving(true);
    try {
      const response = await fetch(`/api/agents/${id}/files`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: activePath, content })
      });
      const payload = await response.json();
      if (!response.ok) {
        showToast("error", payload.error?.message ?? "保存失败");
        return;
      }
      const updated: AgentFileWithContent = payload.data;
      setFiles((current) => {
        const others = current.filter((item) => item.path !== updated.path);
        const meta: AgentFile = { path: updated.path, createdAt: updated.createdAt, updatedAt: updated.updatedAt };
        return [...others, meta].sort((a, b) => a.path.localeCompare(b.path));
      });
      setContentByPath((current) => ({ ...current, [updated.path]: updated.content ?? "" }));
      showToast("success", "已保存");
    } finally {
      setIsSaving(false);
    }
  }

  actionsRef.current.openFile = (path: string) => void openFile(path);
  actionsRef.current.openContextMenu = openContextMenu;
  actionsRef.current.moveFile = (fromPath: string, toPath: string) => void moveFile(fromPath, toPath);

  return (
    <div className="grid grid-2">
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
            <h2 style={{ margin: 0 }}>文件管理</h2>
            <div className="muted">
              {agent ? (
                <>
                  {agent.name} · {agent.provider} · {agent.model}
                </>
              ) : (
                "加载中..."
              )}
            </div>
          </div>
          <Link className="btn" href="/agents">
            返回
          </Link>
        </div>

        <div
          className="softBox stack filesTreeBox"
          onContextMenu={(event) => openContextMenu(event, { type: "root" })}
          onDragOver={(event) => {
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            setDragOverDir("");
          }}
          onDragLeave={() => setDragOverDir((current) => (current === "" ? null : current))}
          onDrop={(event) => {
            event.preventDefault();
            const from =
              event.dataTransfer.getData("application/x-open-debate-path") ||
              event.dataTransfer.getData("text/plain");
            setDragOverDir(null);
            if (!from) return;
            const filename = from.split("/").filter(Boolean).slice(-1)[0] ?? "";
            if (!filename) return;
            void moveFile(from, filename);
          }}
        >
          <div className="treeHeader">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <strong>目录</strong>
              <span className="muted">{displayFiles.length} 个文件</span>
            </div>
          </div>

          {files.length > 0 ? (
            <div className={`treeRoot ${dragOverDir === "" ? "treeDropActive" : ""}`}>
              <Tree<FsNode>
                data={treeData}
                width="100%"
                height={620}
                indent={18}
                rowHeight={34}
                openByDefault={false}
              >
                {(props) => (
                  <TreeRow
                    node={props.node}
                    style={props.style}
                    activePath={activePath}
                    dragOverDir={dragOverDir}
                    actionsRef={actionsRef}
                    setDragOverDir={setDragOverDir}
                  />
                )}
              </Tree>
            </div>
          ) : (
            <div className="muted">暂无文件</div>
          )}
        </div>
      </section>

      <section className="panel stack">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div>
            <h2 style={{ margin: 0 }}>编辑</h2>
            <div className="muted">{activePath ? activePath : ""}</div>
          </div>
          <div className="row">
            <button className="btn" disabled={!activePath || isSaving || isOpening} onClick={() => void save()}>
              {isSaving ? "保存中..." : "保存"}
            </button>
            <button
              className="btn btn-danger"
              disabled={!activePath || isDeleting || isOpening}
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
              <button
                key={tab.path}
                className={`tab ${active ? "tabActive" : ""}`}
                onClick={() => setActivePath(tab.path)}
                title={tab.path}
              >
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
              setTabs((current) => current.map((t) => (t.path === activePath ? { ...t, draft: next } : t)));
            }}
            options={{
              readOnly: !activePath,
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

      {contextMenu ? (
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
              disabled={Boolean(creatingPath)}
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
              disabled={Boolean(creatingPath)}
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
                disabled={isDeleting}
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
                disabled={isDeleting}
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
      ) : null}
    </div>
  );
}
