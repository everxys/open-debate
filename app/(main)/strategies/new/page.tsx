"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import {
  DraftRoleFilesManagerColumns,
  type DraftStrategyRoleFile
} from "@/components/strategies/draft-role-files-manager";
import { useAutoDismissToast } from "@/components/ui/use-toast";

type RoleDraft = { name: string; systemPrompt: string; files: DraftStrategyRoleFile[] };
type StrategyDraft = { name: string; description: string; isShared: boolean; roles: RoleDraft[] };

const initialDraft: StrategyDraft = {
  name: "",
  description: "",
  isShared: false,
  roles: [
    { name: "正方", systemPrompt: "", files: [] },
    { name: "反方", systemPrompt: "", files: [] }
  ]
};

async function readPayload(response: Response) {
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
}

export default function NewStrategyPage() {
  const router = useRouter();
  const { toast, showToast } = useAutoDismissToast(1200);
  const [draft, setDraft] = useState<StrategyDraft>(initialDraft);
  const [activeRoleIndex, setActiveRoleIndex] = useState(0);
  const [isSaving, setIsSaving] = useState(false);

  const canSave = useMemo(() => {
    if (draft.name.trim().length === 0) return false;
    if (draft.roles.length < 2) return false;
    if (draft.roles.some((role) => role.name.trim().length === 0)) return false;
    return true;
  }, [draft]);

  function updateRole(index: number, next: Partial<RoleDraft>) {
    setDraft((current) => ({
      ...current,
      roles: current.roles.map((role, i) => (i === index ? { ...role, ...next } : role))
    }));
  }

  function addRole() {
    setDraft((current) => {
      setActiveRoleIndex(current.roles.length);
      return {
        ...current,
        roles: [...current.roles, { name: `角色 ${current.roles.length + 1}`, systemPrompt: "", files: [] }]
      };
    });
  }

  function removeRole(index: number) {
    setDraft((current) => {
      if (current.roles.length <= 2) return current;
      const ok = window.confirm("确认删除该角色？（本地草稿）");
      if (!ok) return current;
      const nextRoles = current.roles.filter((_, i) => i !== index);
      setActiveRoleIndex((active) => {
        if (active === index) return Math.min(index, nextRoles.length - 1);
        if (active > index) return active - 1;
        return active;
      });
      return { ...current, roles: nextRoles };
    });
  }

  function moveRole(index: number, direction: -1 | 1) {
    setDraft((current) => {
      const nextIndex = index + direction;
      if (nextIndex < 0 || nextIndex >= current.roles.length) return current;
      const roles = [...current.roles];
      const temp = roles[index];
      roles[index] = roles[nextIndex];
      roles[nextIndex] = temp;
      return { ...current, roles };
    });
    setActiveRoleIndex((current) => {
      if (current === index) return index + direction;
      if (current === index + direction) return index;
      return current;
    });
  }

  function duplicateRole(index: number) {
    setDraft((current) => {
      const source = current.roles[index];
      if (!source) return current;
      const copy = {
        name: source.name || `角色 ${index + 1}`,
        systemPrompt: source.systemPrompt ?? "",
        files: (source.files ?? []).map((file) => ({ ...file }))
      };
      const nextRoles = [
        ...current.roles.slice(0, index + 1),
        copy,
        ...current.roles.slice(index + 1)
      ];
      setActiveRoleIndex(index + 1);
      return { ...current, roles: nextRoles };
    });
  }

  async function save() {
    if (!canSave || isSaving) return;
    setIsSaving(true);
    try {
      const response = await fetch("/api/strategies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: draft.name,
          description: draft.description.trim() ? draft.description : null,
          isShared: draft.isShared,
          roles: draft.roles.map((role) => ({
            name: role.name,
            systemPrompt: role.systemPrompt.trim() ? role.systemPrompt : null,
            files: (role.files ?? []).map((file) => ({ path: file.path, content: file.content }))
          }))
        })
      });

      const payload = await readPayload(response);
      if (!response.ok) {
        showToast("error", payload.error?.message ?? "创建失败");
        return;
      }
      showToast("success", "创建成功");
      router.push(`/strategies/${payload.data?.id}`);
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="grid" style={{ gap: 20 }}>
      {toast ? (
        <div
          className={`toast ${toast.type === "success" ? "toast-success" : "toast-error"}`}
          role="status"
          aria-live="polite"
        >
          {toast.text}
        </div>
      ) : null}

      <section className="panel">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div>
            <h2 style={{ margin: 0 }}>新建策略</h2>
            <div className="muted">策略包含多个角色，每个角色有 prompt + 文件。</div>
          </div>
          <Link className="btn" href="/strategies">
            返回
          </Link>
        </div>
      </section>

      <section className="panel stack">
        <div className="row">
          <div className="field" style={{ flex: 1 }}>
            <label>策略名称</label>
            <input
              value={draft.name}
              onChange={(event) =>
                setDraft((current) => ({ ...current, name: event.target.value }))
              }
            />
          </div>
          <label className="row" style={{ alignItems: "center", gap: 8, marginTop: 22 }}>
            <input
              type="checkbox"
              checked={draft.isShared}
              onChange={(event) =>
                setDraft((current) => ({ ...current, isShared: event.target.checked }))
              }
            />
            <span>分享到社区</span>
          </label>
          <button
            className="btn btn-primary"
            disabled={!canSave || isSaving}
            onClick={() => void save()}
          >
            {isSaving ? "保存中..." : "保存策略"}
          </button>
        </div>

        <div className="field">
          <label>描述（可选）</label>
          <textarea
            value={draft.description}
            onChange={(event) =>
              setDraft((current) => ({ ...current, description: event.target.value }))
            }
          />
        </div>
      </section>

      <div className="grid" style={{ gap: 16, alignItems: "start" }}>
        <section className="panel stack">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <strong>角色（{draft.roles.length}）</strong>
            <button
              className="btn btn-primary"
              onClick={addRole}
            >
              新增角色
            </button>
          </div>

          <div className="roleList">
            {draft.roles.map((role, index) => (
              <button
                key={index}
                className={`btn roleButton ${index === activeRoleIndex ? "btn-primary" : ""}`}
                onClick={() => setActiveRoleIndex(index)}
                type="button"
              >
                #{index + 1} {role.name || "(未命名)"}
              </button>
            ))}
          </div>

          {draft.roles[activeRoleIndex] ? (
            <div className="softBox stack">
              <div className="row" style={{ justifyContent: "space-between" }}>
                <strong>编辑角色 #{activeRoleIndex + 1}</strong>
                <div className="row">
                  <button
                    className="btn"
                    disabled={activeRoleIndex === 0}
                    onClick={() => moveRole(activeRoleIndex, -1)}
                  >
                    上移
                  </button>
                  <button
                    className="btn"
                    disabled={activeRoleIndex === draft.roles.length - 1}
                    onClick={() => moveRole(activeRoleIndex, 1)}
                  >
                    下移
                  </button>
                  <button className="btn" onClick={() => duplicateRole(activeRoleIndex)}>
                    复制
                  </button>
                  <button
                    className="btn btn-danger"
                    disabled={draft.roles.length <= 2}
                    onClick={() => removeRole(activeRoleIndex)}
                  >
                    删除
                  </button>
                </div>
              </div>

              <div className="field">
                <label>角色名称</label>
                <input
                  value={draft.roles[activeRoleIndex]?.name ?? ""}
                  onChange={(event) =>
                    updateRole(activeRoleIndex, { name: event.target.value })
                  }
                />
              </div>

              <div className="field">
                <label>System Prompt</label>
                <textarea
                  className="strategyPrompt"
                  value={draft.roles[activeRoleIndex]?.systemPrompt ?? ""}
                  onChange={(event) =>
                    updateRole(activeRoleIndex, { systemPrompt: event.target.value })
                  }
                />
              </div>
            </div>
          ) : null}
        </section>

        <div className="grid grid-2" style={{ gap: 16, alignItems: "start" }}>
          <DraftRoleFilesManagerColumns
            key={activeRoleIndex}
            files={draft.roles[activeRoleIndex]?.files ?? []}
            onFilesChange={(next) => updateRole(activeRoleIndex, { files: next })}
          />
        </div>
      </div>
    </div>
  );
}
