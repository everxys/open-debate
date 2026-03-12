"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";

import { useAutoDismissToast } from "@/components/ui/use-toast";

type Agent = {
  id: string;
  name: string;
  provider: string;
  model: string;
  baseUrl: string;
};

type AgentFile = {
  path: string;
  content: string;
  createdAt: string;
  updatedAt: string;
};

type TreeNode =
  | { type: "dir"; name: string; children: Map<string, TreeNode> }
  | { type: "file"; name: string; path: string };

function buildTree(files: AgentFile[]): TreeNode {
  const root: TreeNode = { type: "dir", name: "", children: new Map() };
  for (const file of files) {
    const parts = file.path.split("/").filter(Boolean);
    let current = root;
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      const isLast = index === parts.length - 1;
      if (current.type !== "dir") break;
      if (isLast) {
        current.children.set(part, { type: "file", name: part, path: file.path });
      } else {
        const existing = current.children.get(part);
        if (existing?.type === "dir") {
          current = existing;
        } else {
          const next: TreeNode = { type: "dir", name: part, children: new Map() };
          current.children.set(part, next);
          current = next;
        }
      }
    }
  }
  return root;
}

export default function AgentFilesPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;

  const [agent, setAgent] = useState<Agent | null>(null);
  const [files, setFiles] = useState<AgentFile[]>([]);
  const [activePath, setActivePath] = useState<string>("");
  const [draftContent, setDraftContent] = useState("");
  const [newPath, setNewPath] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const { toast, showToast } = useAutoDismissToast(1200);

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
    setFiles(filesPayload.data ?? []);
  }

  useEffect(() => {
    void load();
  }, [id]);

  const activeFile = useMemo(() => {
    return files.find((file) => file.path === activePath) ?? null;
  }, [files, activePath]);

  useEffect(() => {
    if (!activeFile) return;
    setDraftContent(activeFile.content ?? "");
  }, [activeFile?.path]);

  const tree = useMemo(() => buildTree(files), [files]);

  function createFile(path: string) {
    const trimmed = path.trim();
    if (!trimmed) return;
    if (files.some((file) => file.path === trimmed)) {
      showToast("error", "文件已存在");
      return;
    }
    setNewPath("");
    setActivePath(trimmed);
    setDraftContent("");
    showToast("success", "已创建（未保存）");
  }

  async function save() {
    if (!id || !activePath || isSaving) return;
    setIsSaving(true);
    try {
      const response = await fetch(`/api/agents/${id}/files`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: activePath, content: draftContent })
      });
      const payload = await response.json();
      if (!response.ok) {
        showToast("error", payload.error?.message ?? "保存失败");
        return;
      }
      const updated: AgentFile = payload.data;
      setFiles((current) => {
        const others = current.filter((item) => item.path !== updated.path);
        return [...others, updated].sort((a, b) => a.path.localeCompare(b.path));
      });
      showToast("success", "已保存");
    } finally {
      setIsSaving(false);
    }
  }

  async function remove() {
    if (!id || !activePath || isDeleting) return;
    setIsDeleting(true);
    try {
      const response = await fetch(`/api/agents/${id}/files`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: activePath })
      });
      const payload = await response.json();
      if (!response.ok) {
        showToast("error", payload.error?.message ?? "删除失败");
        return;
      }
      setFiles((current) => current.filter((item) => item.path !== activePath));
      setActivePath("");
      setDraftContent("");
      showToast("success", "已删除");
    } finally {
      setIsDeleting(false);
    }
  }

  function renderNode(node: TreeNode, prefix = ""): ReactNode {
    if (node.type === "file") {
      const isActive = node.path === activePath;
      return (
        <button
          key={node.path}
          className="btn"
          style={{
            width: "100%",
            textAlign: "left",
            borderColor: isActive ? "var(--blue)" : "var(--line)"
          }}
          onClick={() => setActivePath(node.path)}
        >
          {prefix}
          {node.name}
        </button>
      );
    }

    const entries = Array.from(node.children.entries()).sort(([a], [b]) => a.localeCompare(b));
    if (prefix === "") {
      return (
        <div className="stack" style={{ gap: 8 }}>
          {entries.map(([, child]) => renderNode(child, ""))}
        </div>
      );
    }

    return (
      <details key={node.name} open>
        <summary style={{ cursor: "pointer", color: "var(--muted)", marginBottom: 8 }}>
          {prefix}
          {node.name}/
        </summary>
        <div className="stack" style={{ gap: 8, paddingLeft: 12 }}>
          {entries.map(([, child]) => renderNode(child, `${prefix}`))}
        </div>
      </details>
    );
  }

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
            <h2 style={{ margin: 0 }}>文件</h2>
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

        <div className="panel stack">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <strong>目录</strong>
            <span className="muted">{files.length} 个文件</span>
          </div>

          <div className="row">
            <input
              value={newPath}
              onChange={(e) => setNewPath(e.target.value)}
              placeholder="例如：SOUL.md 或 prompts/AGENTS.md"
              style={{ flex: 1 }}
              autoComplete="off"
            />
            <button className="btn btn-primary" onClick={() => void createFile(newPath)}>
              新建
            </button>
          </div>
          <div className="row">
            <button className="btn" onClick={() => void createFile("SOUL.md")}>
              + SOUL.md
            </button>
            <button className="btn" onClick={() => void createFile("AGENTS.md")}>
              + AGENTS.md
            </button>
          </div>

          {files.length > 0 ? renderNode(tree, "") : <div className="muted">暂无文件</div>}
        </div>
      </section>

      <section className="panel stack">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div>
            <h2 style={{ margin: 0 }}>编辑</h2>
            <div className="muted">{activePath ? activePath : "请选择或新建一个文件"}</div>
          </div>
          <div className="row">
            <button className="btn" disabled={!activePath || isSaving} onClick={() => void save()}>
              {isSaving ? "保存中..." : "保存"}
            </button>
            <button
              className="btn btn-danger"
              disabled={!activePath || isDeleting}
              onClick={() => void remove()}
            >
              {isDeleting ? "删除中..." : "删除"}
            </button>
          </div>
        </div>

        <textarea
          value={draftContent}
          onChange={(e) => setDraftContent(e.target.value)}
          placeholder="在这里编辑 Markdown 内容…"
          disabled={!activePath}
          style={{ minHeight: 520 }}
        />

        {activeFile ? (
          <div className="hint">
            最后更新：{new Date(activeFile.updatedAt).toLocaleString()}
          </div>
        ) : null}
      </section>
    </div>
  );
}
