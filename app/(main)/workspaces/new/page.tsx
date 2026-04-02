"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import { useAutoDismissToast } from "@/components/ui/use-toast";

type StrategyItem = {
  id: string;
  name: string;
};

export default function NewWorkspacePage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { toast, showToast } = useAutoDismissToast(1200);
  const [strategies, setStrategies] = useState<StrategyItem[]>([]);
  const [strategyId, setStrategyId] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    const nextId = searchParams.get("strategyId") ?? "";
    if (nextId) setStrategyId(nextId);
  }, [searchParams]);

  useEffect(() => {
    void (async () => {
      const [mineResponse, sharedResponse] = await Promise.all([
        fetch("/api/strategies?scope=mine"),
        fetch("/api/strategies?scope=shared")
      ]);
      const minePayload = await mineResponse.json().catch(() => ({}));
      const sharedPayload = await sharedResponse.json().catch(() => ({}));
      if (!mineResponse.ok) {
        showToast("error", minePayload.error?.message ?? "加载策略失败");
        return;
      }
      if (!sharedResponse.ok) {
        showToast("error", sharedPayload.error?.message ?? "加载共享策略失败");
        return;
      }
      const merged = [...(Array.isArray(minePayload.data) ? minePayload.data : []), ...(Array.isArray(sharedPayload.data) ? sharedPayload.data : [])];
      const seen = new Set<string>();
      setStrategies(
        merged.filter((item: StrategyItem) => {
          if (!item?.id || seen.has(item.id)) return false;
          seen.add(item.id);
          return true;
        })
      );
    })();
  }, [showToast]);

  const canSubmit = strategyId.trim() && name.trim().length > 0 && !isSubmitting;

  async function submit() {
    if (!canSubmit) return;
    setIsSubmitting(true);
    try {
      const response = await fetch("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          strategyId,
          name: name.trim(),
          description: description.trim() || null
        })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        showToast("error", payload.error?.message ?? "创建工作台失败");
        return;
      }
      router.push(`/workspaces/${payload.data?.id}`);
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="grid" style={{ gap: 20 }}>
      {toast ? (
        <div className={`toast ${toast.type === "success" ? "toast-success" : "toast-error"}`} role="status" aria-live="polite">
          {toast.text}
        </div>
      ) : null}
      <section className="panel">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div>
            <h2 style={{ margin: 0 }}>新建工作台</h2>
            <div className="muted">先选策略，再把题目、点子库和私有素材放进工作台。</div>
          </div>
          <Link className="btn" href="/workspaces">
            返回
          </Link>
        </div>
      </section>

      <section className="panel stack">
        <div className="field">
          <label>策略</label>
          <select value={strategyId} onChange={(event) => setStrategyId(event.target.value)}>
            <option value="">选择一个策略</option>
            {strategies.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>工作台名称</label>
          <input value={name} onChange={(event) => setName(event.target.value.slice(0, 120))} placeholder="例如：异世界天才群像项目 A" />
        </div>
        <div className="field">
          <label>说明（可选）</label>
          <textarea value={description} onChange={(event) => setDescription(event.target.value.slice(0, 4000))} style={{ minHeight: 140 }} />
        </div>
        <div className="row">
          <button className="btn btn-primary" disabled={!canSubmit} onClick={() => void submit()}>
            {isSubmitting ? "创建中..." : "创建工作台"}
          </button>
        </div>
      </section>
    </div>
  );
}
