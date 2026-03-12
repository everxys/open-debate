"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

function passwordHint(value: string) {
  if (value.length < 10) return "至少 10 位";
  if (!/[A-Za-z]/.test(value)) return "需要包含字母";
  if (!/\d/.test(value)) return "需要包含数字";
  return "强度可用";
}

export default function SignupPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [codeVerified, setCodeVerified] = useState(false);
  const [debugCode, setDebugCode] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
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
    if (!codeVerified) return false;
    if (password !== confirmPassword) return false;
    const hint = passwordHint(password);
    return hint === "强度可用";
  }, [codeVerified, password, confirmPassword]);

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

  async function verifyCode() {
    setMessage(null);
    setVerifying(true);
    try {
      const response = await fetch("/api/auth/verification/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: normalizeEmail(email), code, purpose: "signup" })
      });
      const payload = await response.json();
      if (!response.ok) {
        setCodeVerified(false);
        setMessage({ type: "error", text: payload.error?.message ?? "验证码不正确" });
        return;
      }
      setCodeVerified(true);
      setMessage({ type: "success", text: "验证码验证通过" });
    } finally {
      setVerifying(false);
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
    <>
      <section className="authHero">
        <h1 className="authTitle">创建你的账号</h1>
        <p className="authSubtitle">
          我们会向你的邮箱发送 6 位验证码；验证码仅用于验证邮箱归属。
        </p>
        <div className="alert">
          <div style={{ fontWeight: 700, marginBottom: 6 }}>密码要求</div>
          <div className="hint">至少 10 位，且包含字母与数字。</div>
        </div>
      </section>

      <section className="authCard">
        <h2 className="authTitle">注册</h2>
        <p className="authSubtitle">填写邮箱、验证验证码，然后设置密码。</p>

        <div className="stack" style={{ marginTop: 14 }}>
          <div className="field">
            <label>邮箱</label>
            <input
              autoComplete="email"
              inputMode="email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                setCodeVerified(false);
              }}
              placeholder="you@company.com"
            />
          </div>

          <div className="row" style={{ justifyContent: "space-between" }}>
            <button className="btn" disabled={!canSend || sending} onClick={() => void sendCode()}>
              {sending ? "发送中..." : cooldownSeconds > 0 ? `重新发送 (${cooldownSeconds}s)` : "发送验证码"}
            </button>
            <Link className="authLink" href="/login">
              已有账号？去登录
            </Link>
          </div>

          <div className="field">
            <label>
              验证码{" "}
              {codeVerified ? <span className="hint" style={{ color: "var(--green)" }}>已验证</span> : null}
            </label>
            <input
              inputMode="numeric"
              value={code}
              onChange={(e) => {
                setCode(e.target.value);
                setCodeVerified(false);
              }}
              placeholder="6 位数字"
            />
            {debugCode ? <div className="hint">本地调试验证码：{debugCode}</div> : null}
          </div>

          <div className="authActions">
            <button className="btn" disabled={verifying || code.trim().length < 4} onClick={() => void verifyCode()}>
              {verifying ? "验证中..." : "验证验证码"}
            </button>
            <span className="hint">验证码有效期 10 分钟</span>
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
            <div className="hint">强度：{passwordHint(password)}</div>
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

          <div className="authActions">
            <button
              className="btn btn-primary"
              disabled={!canSubmit || submitting}
              onClick={() => void submit()}
            >
              {submitting ? "创建中..." : "创建账号"}
            </button>
            <span className="hint">提交时会再次校验验证码与密码策略</span>
          </div>

          {message ? (
            <div className={`alert ${message.type === "error" ? "alert-error" : "alert-success"}`}>
              {message.text}
            </div>
          ) : null}
        </div>
      </section>
    </>
  );
}

