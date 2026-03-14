"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { RoleFilesManagerColumns } from "@/components/strategies/role-files-manager";
import { useAutoDismissToast } from "@/components/ui/use-toast";

type StrategyDetail = {
  id: string;
  name: string;
  description: string | null;
  isShared: boolean;
  canEdit: boolean;
  roles: Array<{
    id: string;
    name: string;
    systemPrompt: string | null;
    roleOrder: number;
  }>;
};

type RoleDraft = { id: string; name: string; systemPrompt: string };

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

export default function StrategyDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const router = useRouter();
  const { toast, showToast } = useAutoDismissToast(1200);

  const [detail, setDetail] = useState<StrategyDetail | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [isShared, setIsShared] = useState(false);
  const [roles, setRoles] = useState<RoleDraft[]>([]);
  const [activeRoleIndex, setActiveRoleIndex] = useState<number>(0);
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  async function load() {
    if (!id) return;
    const response = await fetch(`/api/strategies/${id}`);
    const payload = await readPayload(response);
    if (!response.ok) {
      showToast("error", payload.error?.message ?? "加载失败");
      return;
    }
    const data = payload.data as StrategyDetail;
    setDetail(data);
    setName(data.name);
    setDescription(data.description ?? "");
    setIsShared(data.isShared);
    const nextRoles = (data.roles ?? [])
      .slice()
      .sort((a, b) => a.roleOrder - b.roleOrder)
      .map((role) => ({ id: role.id, name: role.name, systemPrompt: role.systemPrompt ?? "" }));
    setRoles(nextRoles);
    setActiveRoleIndex((current) => {
      if (current >= 0 && current < nextRoles.length) return current;
      return 0;
    });
  }

  useEffect(() => {
    void load();
  }, [id]);

  const canSave = useMemo(() => {
    if (!detail?.canEdit) return false;
    if (name.trim().length === 0) return false;
    if (roles.length < 2) return false;
    if (roles.some((role) => role.name.trim().length === 0)) return false;
    return true;
  }, [name, roles, detail?.canEdit]);

  function updateRole(index: number, next: Partial<RoleDraft>) {
    setRoles((current) => current.map((role, i) => (i === index ? { ...role, ...next } : role)));
  }

  function addRole() {
    if (!detail?.canEdit) return;
    setRoles((current) => {
      const next = [...current, { id: "", name: `角色 ${current.length + 1}`, systemPrompt: "" }];
      setActiveRoleIndex(next.length - 1);
      return next;
    });
  }

  function removeRole(index: number) {
    if (!detail?.canEdit) return;
    setRoles((current) => {
      if (current.length <= 2) return current;
      const ok = window.confirm("确认删除该角色？（保存后生效，会同时删除该角色下的文件）");
      if (!ok) return current;
      const next = current.filter((_, i) => i !== index);
      setActiveRoleIndex((active) => Math.max(0, Math.min(active, next.length - 1)));
      return next;
    });
  }

  function moveRole(index: number, direction: -1 | 1) {
    if (!detail?.canEdit) return;
    setRoles((current) => {
      const nextIndex = index + direction;
      if (nextIndex < 0 || nextIndex >= current.length) return current;
      const next = [...current];
      const temp = next[index];
      next[index] = next[nextIndex];
      next[nextIndex] = temp;
      return next;
    });
  }

  async function save() {
    if (!id || !canSave || isSaving) return;
    setIsSaving(true);
    try {
      const response = await fetch(`/api/strategies/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          description: description.trim() ? description : null,
          isShared,
          roles: roles.map((role) => ({
            ...(role.id ? { id: role.id } : {}),
            name: role.name,
            systemPrompt: role.systemPrompt.trim() ? role.systemPrompt : null
          }))
        })
      });
      const payload = await readPayload(response);
      if (!response.ok) {
        showToast("error", payload.error?.message ?? "保存失败");
        return;
      }
      showToast("success", "已保存");
      await load();
    } finally {
      setIsSaving(false);
    }
  }

  async function deleteOne() {
    if (!id || !detail?.canEdit || isDeleting) return;
    const ok = window.confirm("确认删除该策略？此操作不可恢复。");
    if (!ok) return;
    setIsDeleting(true);
    try {
      const response = await fetch(`/api/strategies/${id}`, { method: "DELETE" });
      const payload = await readPayload(response);
      if (!response.ok) {
        showToast("error", payload.error?.message ?? "删除失败");
        return;
      }
      showToast("success", "已删除");
      router.push("/strategies");
    } finally {
      setIsDeleting(false);
    }
  }

  if (!detail) {
    return <div className="panel">加载中...</div>;
  }

  const activeRole = roles[activeRoleIndex] ?? null;

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
            <h2 style={{ margin: 0 }}>策略</h2>
            <div className="muted">{detail.canEdit ? "可编辑" : "只读（来自社区分享）"}</div>
          </div>
          <div className="row">
            <Link className="btn btn-primary" href={`/debates/new?strategyId=${detail.id}`}>
              使用策略
            </Link>
            <Link className="btn" href="/strategies">
              返回
            </Link>
          </div>
        </div>
      </section>

      <section className="panel stack">
        <div className="row">
          <div className="field" style={{ flex: 1 }}>
            <label>策略名称</label>
            <input value={name} disabled={!detail.canEdit} onChange={(event) => setName(event.target.value)} />
          </div>
          <label className="row" style={{ alignItems: "center", gap: 8, marginTop: 22 }}>
            <input
              type="checkbox"
              checked={isShared}
              disabled={!detail.canEdit}
              onChange={(event) => setIsShared(event.target.checked)}
            />
            <span>分享到社区</span>
          </label>
          {detail.canEdit ? (
            <>
              <button className="btn btn-primary" disabled={!canSave || isSaving} onClick={() => void save()}>
                {isSaving ? "保存中..." : "保存"}
              </button>
              <button className="btn btn-danger" disabled={isDeleting} onClick={() => void deleteOne()}>
                {isDeleting ? "删除中..." : "删除"}
              </button>
            </>
          ) : null}
        </div>

        <div className="field">
          <label>描述（可选）</label>
          <textarea value={description} disabled={!detail.canEdit} onChange={(event) => setDescription(event.target.value)} />
        </div>
      </section>

      <div className="grid grid-3" style={{ gap: 16, alignItems: "start" }}>
        <section className="panel stack">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <strong>角色（{roles.length}）</strong>
            <button className="btn btn-primary" disabled={!detail.canEdit} onClick={addRole}>
              新增角色
            </button>
          </div>

          <div className="roleList">
            {roles.map((role, index) => (
              <button
                key={role.id || `new-${index}`}
                className={`btn roleButton ${index === activeRoleIndex ? "btn-primary" : ""}`}
                onClick={() => setActiveRoleIndex(index)}
                type="button"
              >
                #{index + 1} {role.name || "(未命名)"}
              </button>
            ))}
          </div>

          {activeRole ? (
            <div className="softBox stack">
              <div className="row" style={{ justifyContent: "space-between" }}>
                <strong>编辑角色 #{activeRoleIndex + 1}</strong>
                {detail.canEdit ? (
                  <div className="row">
                    <button className="btn" disabled={activeRoleIndex === 0} onClick={() => moveRole(activeRoleIndex, -1)}>
                      上移
                    </button>
                    <button className="btn" disabled={activeRoleIndex === roles.length - 1} onClick={() => moveRole(activeRoleIndex, 1)}>
                      下移
                    </button>
                    <button className="btn btn-danger" disabled={roles.length <= 2} onClick={() => removeRole(activeRoleIndex)}>
                      删除
                    </button>
                  </div>
                ) : null}
              </div>

              <div className="field">
                <label>角色名称</label>
                <input value={activeRole.name} disabled={!detail.canEdit} onChange={(event) => updateRole(activeRoleIndex, { name: event.target.value })} />
              </div>

              <div className="field">
                <label>System Prompt</label>
                <textarea className="strategyPrompt" value={activeRole.systemPrompt} disabled={!detail.canEdit} onChange={(event) => updateRole(activeRoleIndex, { systemPrompt: event.target.value })} />
              </div>

              {!activeRole.id ? <div className="muted">新角色需要先点击保存后，才能编辑文件。</div> : null}
            </div>
          ) : (
            <div className="muted">请选择一个角色</div>
          )}
        </section>

        {activeRole?.id ? (
          <RoleFilesManagerColumns
            strategyId={detail.id}
            roleId={activeRole.id}
            readOnly={!detail.canEdit}
          />
        ) : (
          <>
            <section className="panel stack">
              <div className="muted">新角色需先保存后才能编辑文件。</div>
            </section>
            <section className="panel stack">
              <div className="muted">新角色需先保存后才能编辑文件。</div>
            </section>
          </>
          )}
      </div>
    </div>
  );
}
