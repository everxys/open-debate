"use client";

import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/feedback";
import { Field } from "@/components/ui/surface";

export default function SecurityPage() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: "error" | "success"; text: string } | null>(
    null
  );

  const canSubmit = useMemo(() => {
    if (!currentPassword || !newPassword || !confirmPassword) return false;
    if (newPassword !== confirmPassword) return false;
    return true;
  }, [currentPassword, newPassword, confirmPassword]);

  async function submit() {
    setLoading(true);
    setMessage(null);
    try {
      const response = await fetch("/api/auth/password", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword })
      });
      const payload = await response.json();
      if (!response.ok) {
        setMessage({ type: "error", text: payload.error?.message ?? "修改失败" });
        return;
      }

      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setMessage({ type: "success", text: "密码已更新" });
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="panel">
      <h2 style={{ marginTop: 0 }}>安全管理</h2>
      <p className="muted" style={{ marginTop: -6 }}>
        修改密码（至少 10 位，包含字母与数字）。
      </p>

      <div className="stack" style={{ marginTop: 14, maxWidth: 520 }}>
        <Field label="当前密码">
          <input
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            placeholder="当前密码"
          />
        </Field>
        <Field label="新密码">
          <input
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            placeholder="新密码"
          />
        </Field>
        <Field label="确认新密码">
          <input
            type="password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            placeholder="再次输入新密码"
          />
          {confirmPassword && newPassword !== confirmPassword ? (
            <div className="hint" style={{ color: "var(--red)" }}>
              两次输入不一致
            </div>
          ) : null}
        </Field>

        <Button variant="primary" disabled={!canSubmit || loading} onClick={() => void submit()}>
          {loading ? "提交中..." : "更新密码"}
        </Button>

        {message ? (
          <Alert tone={message.type}>{message.text}</Alert>
        ) : null}
      </div>
    </section>
  );
}
