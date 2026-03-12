"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

function isStrongEnoughPassword(value: string) {
  if (value.length < 10 || value.length > 200) return false;
  const hasLetter = /[A-Za-z]/.test(value);
  const hasNumber = /\d/.test(value);
  return hasLetter && hasNumber;
}

export default function SignupPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [debugCode, setDebugCode] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  const [sending, setSending] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [cooldownSeconds, setCooldownSeconds] = useState(0);
  const [message, setMessage] = useState<{ type: "error" | "success"; text: string } | null>(
    null
  );

  useEffect(() => {
    if (cooldownSeconds <= 0) return;
    const timer = setInterval(() => setCooldownSeconds((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(timer);
  }, [cooldownSeconds]);

  const canSend = useMemo(() => normalizeEmail(email).length > 3 && cooldownSeconds === 0, [
    email,
    cooldownSeconds
  ]);

  const canSubmit = useMemo(() => {
    if (normalizeEmail(email).length <= 3) return false;
    if (code.trim().length !== 6) return false;
    if (password !== confirmPassword) return false;
    return isStrongEnoughPassword(password);
  }, [email, code, password, confirmPassword]);

  async function sendCode() {
    setMessage(null);
    setDebugCode(null);
    setSending(true);
    try {
      const response = await fetch("/api/auth/verification/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: normalizeEmail(email), purpose: "signup" })
      });
      const payload = await response.json();
      if (!response.ok) {
        setMessage({ type: "error", text: payload.error?.message ?? "发送失败" });
        return;
      }
      setMessage({ type: "success", text: "验证码已发送（有效期 10 分钟）" });
      if (payload.data?.debugCode) {
        setDebugCode(String(payload.data.debugCode));
      }
      setCooldownSeconds(Number(payload.data?.retryAfterSeconds ?? 60));
    } finally {
      setSending(false);
    }
  }

  async function submit() {
    setMessage(null);
    setSubmitting(true);
    try {
      const response = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: normalizeEmail(email), password, code })
      });
      const payload = await response.json();
      if (!response.ok) {
        setMessage({ type: "error", text: payload.error?.message ?? "注册失败" });
        return;
      }
      router.push("/");
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="authCard">
      <h1 className="authTitle">注册</h1>
      <p className="authSubtitle">邮箱 + 验证码 + 密码。</p>

      <div className="stack" style={{ marginTop: 14 }}>
        <div className="field">
          <label>邮箱</label>
          <input
            autoComplete="email"
            inputMode="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com"
          />
        </div>

        <button className="btn" disabled={!canSend || sending} onClick={() => void sendCode()}>
          {sending ? "发送中..." : cooldownSeconds > 0 ? `重新发送 (${cooldownSeconds}s)` : "发送验证码"}
        </button>

        <div className="field">
          <label>验证码</label>
          <input
            inputMode="numeric"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            maxLength={6}
            pattern="\\d{6}"
            placeholder="6 位数字"
          />
          <div className="hint">有效期 10 分钟，提交时会校验。</div>
          {debugCode ? <div className="hint">本地调试验证码：{debugCode}</div> : null}
        </div>

        <div className="field">
          <label>密码</label>
          <input
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="至少 10 位，包含字母和数字"
          />
          <div className="hint">要求：至少 10 位，且包含字母与数字。</div>
        </div>

        <div className="field">
          <label>确认密码</label>
          <input
            type="password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            placeholder="再输入一次"
          />
          {confirmPassword.length > 0 && password !== confirmPassword ? (
            <div className="hint" style={{ color: "var(--red)" }}>
              两次输入不一致
            </div>
          ) : null}
        </div>

        <button
          className="btn btn-primary"
          disabled={!canSubmit || submitting}
          onClick={() => void submit()}
        >
          {submitting ? "创建中..." : "创建账号"}
        </button>

        <div className="hint">
          已有账号？<Link className="authLink" href="/login">去登录</Link>
        </div>

        {message ? (
          <div className={`alert ${message.type === "error" ? "alert-error" : "alert-success"}`}>
            {message.text}
          </div>
        ) : null}
      </div>
    </section>
  );
}
