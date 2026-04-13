import MonacoEditor from "@monaco-editor/react";
import type { CSSProperties, MouseEvent as ReactMouseEvent, MutableRefObject } from "react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Tree, type NodeApi } from "react-arborist";

import { Portal } from "@/components/ui/portal";
import { useAutoDismissToast } from "@/components/ui/use-toast";
import { type FsNode, isKeepMarkerPath, joinFsPath, normalizeFsPath } from "@/lib/fs-tree";
import { useFsTree } from "@/lib/use-fs-tree";

type StrategySharedFile = {
  path: string;
  createdAt: string;
  updatedAt: string;
};

type StrategySharedFileWithContent = StrategySharedFile & { content: string };
type StrategyFileAccessRule = {
  id: string;
  scope: "shared" | "seat";
  targetType: "file" | "dir";
  targetPath: string;
  accessMode: "always_read" | "read_when_needed" | "unlock_after_phase";
  phaseKind: "analysis" | "deliberation" | "finalization_vote" | "finalization" | null;
};

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

function formatRuleBadge(rule: StrategyFileAccessRule | null | undefined) {
  if (!rule) return null;
  if (rule.accessMode === "always_read") return "必读";
  if (rule.accessMode === "read_when_needed") return "按需";
  return rule.phaseKind ? `阶段:${rule.phaseKind}` : "阶段解锁";
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
    ruleByPath: Record<string, StrategyFileAccessRule | undefined>;
    setDragOverDir: (next: string | null | ((current: string | null) => string | null)) => void;
  }) {
    const { node, style, activePath, dragOverDir, readOnly, actionsRef, ruleByPath, setDragOverDir } = props;
    const data = node.data;
    const isDir = data.type === "dir";
    const isActive = data.type === "file" && data.path === activePath;
    const dropActive = isDir && dragOverDir === data.path;
    const ruleBadge = formatRuleBadge(ruleByPath[data.path]);

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
          if (readOnly) return;
          if (data.type !== "file") return;
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("application/x-open-debate-path", data.path);
          event.dataTransfer.setData("text/plain", data.path);
        }}
        onDragOver={(event) => {
          if (readOnly) return;
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
          if (readOnly) return;
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
        {ruleBadge ? <span className="tag" style={{ marginLeft: "auto" }}>{ruleBadge}</span> : null}
      </div>
    );
  },
  (a, b) => {
    if (a.readOnly !== b.readOnly) return false;
    if (a.activePath !== b.activePath) return false;
    if (a.dragOverDir !== b.dragOverDir) return false;
    if (a.node.id !== b.node.id) return false;
    if (a.node.isOpen !== b.node.isOpen) return false;
    const aRule = a.ruleByPath[a.node.data.path]?.id ?? "";
    const bRule = b.ruleByPath[b.node.data.path]?.id ?? "";
    if (aRule !== bRule) return false;
    const at = a.style.transform ?? a.style.top;
    const bt = b.style.transform ?? b.style.top;
    return at === bt;
  }
);

export function StrategySharedFilesManagerColumns({
  strategyId,
  readOnly,
  onRulesChange
}: {
  strategyId: string;
  readOnly?: boolean;
  onRulesChange?: () => void;
}) {
  const [files, setFiles] = useState<StrategySharedFile[]>([]);
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
  const [rules, setRules] = useState<StrategyFileAccessRule[]>([]);
  const { toast, showToast } = useAutoDismissToast(1200);
  const { treeData, reset: resetTree, upsertPath } = useFsTree({
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

  const displayFiles = useMemo(() => files.filter((item) => !isInternalDirMarker(item.path)), [files]);
  const filesByPath = useMemo(() => new Map(files.map((file) => [file.path, file] as const)), [files]);
  const ruleByPath = useMemo(() => {
    const next: Record<string, StrategyFileAccessRule | undefined> = {};
    for (const rule of rules) next[rule.targetPath] = rule;
    return next;
  }, [rules]);
  const activeTab = tabs.find((tab) => tab.path === activePath) ?? null;
  const activeContent = activeTab?.draft ?? contentByPath[activePath] ?? "";

  useEffect(() => {
    if (!strategyId) return;
    void refreshFiles();
    void refreshRules();
  }, [strategyId]);

  useEffect(() => {
    resetTree(displayFiles.map((file) => file.path));
  }, [displayFiles, resetTree]);

  async function refreshFiles() {
    if (!strategyId) return;
    try {
      const response = await fetch(`/api/strategies/${strategyId}/shared-files`);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        showToast("error", payload.error?.message ?? "加载共享文件失败");
        return;
      }
      const items = Array.isArray(payload.data) ? payload.data : [];
      setFiles(
        items.map((item: any) => ({
          path: String(item.path ?? ""),
          createdAt: String(item.createdAt ?? ""),
          updatedAt: String(item.updatedAt ?? "")
        }))
      );
    } catch (error) {
      showToast("error", (error as Error).message ?? "加载共享文件失败");
    }
  }

  async function refreshRules() {
    if (!strategyId) return;
    try {
      const response = await fetch(`/api/strategies/${strategyId}/file-access-rules`, { cache: "no-store" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        showToast("error", payload.error?.message ?? "加载读取规则失败");
        return;
      }
      const items = Array.isArray(payload.data) ? payload.data : [];
      setRules(
        items
          .filter((item: any) => item.scope === "shared")
          .map((item: any) => ({
            id: String(item.id ?? ""),
            scope: "shared" as const,
            targetType: item.targetType === "file" ? "file" : "dir",
            targetPath: String(item.targetPath ?? ""),
            accessMode:
              item.accessMode === "unlock_after_phase"
                ? "unlock_after_phase"
                : item.accessMode === "read_when_needed"
                  ? "read_when_needed"
                  : "always_read",
            phaseKind:
              item.phaseKind === "analysis" ||
              item.phaseKind === "deliberation" ||
              item.phaseKind === "finalization_vote" ||
              item.phaseKind === "finalization"
                ? item.phaseKind
                : null
          }))
      );
    } catch (error) {
      showToast("error", (error as Error).message ?? "加载读取规则失败");
    }
  }

  async function openFile(path: string) {
    if (!strategyId || !path) return;
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
      const response = await fetch(
        `/api/strategies/${strategyId}/shared-files?path=${encodeURIComponent(path)}`,
        { cache: "no-store" }
      );
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        showToast("error", payload.error?.message ?? "打开文件失败");
        return;
      }
      const file = payload.data as StrategySharedFileWithContent;
      setContentByPath((current) => ({ ...current, [path]: file.content ?? "" }));
      setTabs((current) => [...current, { path, draft: file.content ?? "" }]);
      setActivePath(path);
    } finally {
      setIsOpening(false);
    }
  }

  async function saveFile(path: string, content: string) {
    if (readOnly || !strategyId) return;
    if (isSaving) return;
    setIsSaving(true);
    try {
      const response = await fetch(`/api/strategies/${strategyId}/shared-files`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path, content })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        showToast("error", payload.error?.message ?? "保存失败");
        return;
      }
      setContentByPath((current) => ({ ...current, [path]: content }));
      await refreshFiles();
      showToast("success", "已保存");
    } finally {
      setIsSaving(false);
    }
  }

  async function deleteFile(path: string) {
    if (readOnly || !strategyId || !path) return;
    if (isDeleting) return;
    setIsDeleting(true);
    try {
      const response = await fetch(`/api/strategies/${strategyId}/shared-files`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        showToast("error", payload.error?.message ?? "删除失败");
        return;
      }
      setContentByPath((current) => {
        const next = { ...current };
        delete next[path];
        return next;
      });
      setTabs((current) => {
        const next = current.filter((tab) => tab.path !== path);
        if (activePath === path) {
          setActivePath(next[next.length - 1]?.path ?? "");
        }
        return next;
      });
      await refreshFiles();
      showToast("success", "已删除");
    } finally {
      setIsDeleting(false);
    }
  }

  async function deleteDirectory(prefix: string) {
    if (readOnly || !strategyId) return;
    if (isDeleting) return;
    setIsDeleting(true);
    try {
      const response = await fetch(`/api/strategies/${strategyId}/shared-files`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prefix })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        showToast("error", payload.error?.message ?? "删除失败");
        return;
      }
      setContentByPath((current) => {
        const next = { ...current };
        for (const path of Object.keys(next)) {
          if (path === prefix || path.startsWith(`${prefix}/`)) delete next[path];
        }
        return next;
      });
      setTabs((current) => {
        const next = current.filter((tab) => tab.path !== prefix && !tab.path.startsWith(`${prefix}/`));
        if (activePath === prefix || activePath.startsWith(`${prefix}/`)) {
          setActivePath(next[next.length - 1]?.path ?? "");
        }
        return next;
      });
      await refreshFiles();
      showToast("success", "已删除");
    } finally {
      setIsDeleting(false);
    }
  }

  async function moveFile(fromPath: string, toPath: string) {
    if (readOnly || !strategyId) return;
    if (fromPath === toPath) return;
    try {
      const response = await fetch(`/api/strategies/${strategyId}/shared-files`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fromPath, toPath })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        showToast("error", payload.error?.message ?? "移动失败");
        return;
      }
      const content = contentByPath[fromPath];
      setContentByPath((current) => {
        const next = { ...current };
        delete next[fromPath];
        if (content !== undefined) next[toPath] = content;
        return next;
      });
      setTabs((current) =>
        current.map((tab) => (tab.path === fromPath ? { ...tab, path: toPath } : tab))
      );
      if (activePath === fromPath) setActivePath(toPath);
      await refreshFiles();
      showToast("success", "已移动");
    } catch (error) {
      showToast("error", (error as Error).message ?? "移动失败");
    }
  }

  function closeTab(path: string) {
    setTabs((current) => {
      const remaining = current.filter((tab) => tab.path !== path);
      if (activePath === path) {
        setActivePath(remaining[remaining.length - 1]?.path ?? "");
      }
      return remaining;
    });
  }

  function updateTabDraft(path: string, draft: string) {
    setTabs((current) => current.map((tab) => (tab.path === path ? { ...tab, draft } : tab)));
  }

  function openContextMenu(event: ReactMouseEvent<HTMLElement>, target: ContextTarget) {
    event.preventDefault();
    setContextMenu({ x: event.clientX, y: event.clientY, target });
  }

  function createFile(target: ContextTarget) {
    const basePath = target.type === "dir" ? target.path : target.type === "file" ? target.path.split("/").slice(0, -1).join("/") : "";
    setCreatingPath(basePath);
  }

  async function handleCreate(path: string) {
    if (!path) return;
    if (readOnly) return;
    setCreatingPath(null);
    const normalized = normalizeInputPath(path);
    await saveFile(normalized, "");
    upsertPath(normalized);
    setTabs((current) => {
      if (current.some((tab) => tab.path === normalized)) return current;
      return [...current, { path: normalized, draft: "" }];
    });
    setActivePath(normalized);
  }

  function closeContextMenu() {
    setContextMenu(null);
  }

  async function applyRule(target: ContextTarget, accessMode: StrategyFileAccessRule["accessMode"]) {
    if (readOnly || !strategyId || target.type === "root") return;
    const targetType = target.type === "file" ? "file" : "dir";
    const targetPath = target.path;
    const existing = ruleByPath[targetPath];
    const phaseKind =
      accessMode === "unlock_after_phase"
        ? window.prompt("输入解锁阶段：analysis / deliberation / finalization_vote / finalization", existing?.phaseKind ?? "deliberation")
        : null;
    if (accessMode === "unlock_after_phase" && phaseKind !== "analysis" && phaseKind !== "deliberation" && phaseKind !== "finalization_vote" && phaseKind !== "finalization") {
      showToast("error", "阶段无效");
      return;
    }
    try {
      const response = await fetch(`/api/strategies/${strategyId}/file-access-rules`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scope: "shared",
          targetType,
          targetPath,
          accessMode,
          phaseKind
        })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        showToast("error", payload.error?.message ?? "设置读取规则失败");
        return;
      }
      await refreshRules();
      onRulesChange?.();
      showToast("success", "读取规则已更新");
    } catch (error) {
      showToast("error", (error as Error).message ?? "设置读取规则失败");
    }
  }

  async function clearRule(target: ContextTarget) {
    if (readOnly || !strategyId || target.type === "root") return;
    const existing = ruleByPath[target.path];
    if (!existing) {
      showToast("success", "当前未设置读取规则");
      return;
    }
    try {
      const response = await fetch(`/api/strategies/${strategyId}/file-access-rules/${existing.id}`, { method: "DELETE" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        showToast("error", payload.error?.message ?? "清除读取规则失败");
        return;
      }
      await refreshRules();
      onRulesChange?.();
      showToast("success", "读取规则已清除");
    } catch (error) {
      showToast("error", (error as Error).message ?? "清除读取规则失败");
    }
  }

  actionsRef.current.openFile = (path: string) => void openFile(path);
  actionsRef.current.openContextMenu = openContextMenu;
  actionsRef.current.moveFile = (fromPath: string, toPath: string) => void moveFile(fromPath, toPath);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setContextMenu(null);
        setCreatingPath(null);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <>
      {toast ? (
        <Portal>
          <div
            className={`toast ${toast.type === "success" ? "toast-success" : "toast-error"}`}
            role="status"
            aria-live="polite"
          >
            {toast.text}
          </div>
        </Portal>
      ) : null}

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
                height={360}
                indent={16}
                rowHeight={30}
              >
                {(props) => (
                  <TreeRow
                    node={props.node}
                    style={props.style}
                    activePath={activePath}
                    dragOverDir={dragOverDir}
                    readOnly={Boolean(readOnly)}
                    actionsRef={actionsRef}
                    ruleByPath={ruleByPath}
                    setDragOverDir={setDragOverDir}
                  />
                )}
              </Tree>
            </div>
          ) : (
            <div className="muted">暂无共享文件</div>
          )}
        </div>

        {creatingPath !== null ? (
          <div className="field">
            <label>新文件路径</label>
            <input
              autoFocus
              placeholder="例如 shared/summary.md"
              onBlur={(event) => handleCreate(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") handleCreate((event.target as HTMLInputElement).value);
                if (event.key === "Escape") setCreatingPath(null);
              }}
            />
          </div>
        ) : null}

        <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn" type="button" disabled={readOnly} onClick={() => setCreatingPath("")}>
              新建文件
            </button>
          </div>
          <div className="muted">{isOpening ? "打开中..." : ""}</div>
        </div>
      </section>

      <section className="panel stack">
        <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
          <strong>共享文件编辑</strong>
          <div className="row">
            <button
              className="btn btn-primary"
              disabled={!activePath || isSaving || readOnly}
              onClick={() => activePath && saveFile(activePath, activeContent)}
            >
              {isSaving ? "保存中..." : "保存"}
            </button>
          </div>
        </div>

        {tabs.length > 0 ? (
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            {tabs.map((tab) => (
              <button
                key={tab.path}
                className={`btn ${tab.path === activePath ? "btn-primary" : ""}`}
                type="button"
                onClick={() => {
                  setActivePath(tab.path);
                }}
              >
                {tab.path}
                <span
                  className="muted"
                  style={{ marginLeft: 6 }}
                  onClick={(event) => {
                    event.stopPropagation();
                    closeTab(tab.path);
                  }}
                >
                  ×
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className="muted">请选择一个文件进行编辑</div>
        )}

        {activePath ? (
          <MonacoEditor
            height="360px"
            language="markdown"
            value={activeContent}
            onChange={(value) => updateTabDraft(activePath, value ?? "")}
            options={{
              minimap: { enabled: false },
              wordWrap: "on",
              readOnly: Boolean(readOnly)
            }}
          />
        ) : null}
      </section>

      {contextMenu ? (
        <Portal>
          <div
            className="contextMenu"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onMouseLeave={closeContextMenu}
          >
            <button className="btn" type="button" onClick={() => createFile(contextMenu.target)}>
              新建文件
            </button>
            {contextMenu.target.type !== "root" ? (
              <>
                <button className="btn" type="button" disabled={Boolean(readOnly)} onClick={() => { const target = contextMenu.target; closeContextMenu(); void applyRule(target, "always_read"); }}>
                  标记为每会话必读
                </button>
                <button className="btn" type="button" disabled={Boolean(readOnly)} onClick={() => { const target = contextMenu.target; closeContextMenu(); void applyRule(target, "read_when_needed"); }}>
                  标记为按需可读
                </button>
                <button className="btn" type="button" disabled={Boolean(readOnly)} onClick={() => { const target = contextMenu.target; closeContextMenu(); void applyRule(target, "unlock_after_phase"); }}>
                  标记为阶段解锁
                </button>
                <button className="btn" type="button" disabled={Boolean(readOnly)} onClick={() => { const target = contextMenu.target; closeContextMenu(); void clearRule(target); }}>
                  清除规则
                </button>
              </>
            ) : null}
            {contextMenu.target.type === "file" ? (
              <button
                className="btn btn-danger"
                type="button"
                onClick={() => {
                  const target = contextMenu.target;
                  if (target.type !== "file") return;
                  deleteFile(target.path);
                }}
              >
                删除文件
              </button>
            ) : null}
            {contextMenu.target.type === "dir" ? (
              <button
                className="btn btn-danger"
                type="button"
                onClick={() => {
                  const target = contextMenu.target;
                  if (target.type !== "dir") return;
                  deleteDirectory(target.path);
                }}
              >
                删除目录
              </button>
            ) : null}
          </div>
        </Portal>
      ) : null}
    </>
  );
}
