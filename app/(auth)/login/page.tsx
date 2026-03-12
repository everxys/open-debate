"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: "error" | "success"; text: string } | null>(
    null
  );

  const canSubmit = useMemo(() => {
    return normalizeEmail(email).length > 3 && password.length > 0;
  }, [email, password]);

  async function submit() {
    setLoading(true);
    setMessage(null);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: normalizeEmail(email), password })
      });
      const payload = await response.json();
      if (!response.ok) {
        setMessage({ type: "error", text: payload.error?.message ?? "登录失败" });
        return;
      }

      router.push("/");
      router.refresh();
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <section className="authHero">
        <h1 className="authTitle">Open Debate</h1>
        <p className="authSubtitle">
          你自己的账号体系（邮箱 + 密码 + 验证码注册），数据落在 PostgreSQL 里。
        </p>
        <div className="alert">
          <div style={{ fontWeight: 700, marginBottom: 6 }}>安全提示</div>
          <div className="hint">
            密码错误累计 5 次会临时锁定（默认 15 分钟）。建议使用密码管理器生成强密码。
          </div>
        </div>
      </section>

      <section className="authCard">
        <h2 className="authTitle">登录</h2>
        <p className="authSubtitle">欢迎回来。请输入邮箱与密码。</p>

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
          <div className="field">
            <label>密码</label>
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="你的密码"
            />
          </div>

          <div className="authActions">
            <button
              className="btn btn-primary"
              disabled={!canSubmit || loading}
              onClick={() => void submit()}
            >
              {loading ? "登录中..." : "登录"}
            </button>
            <Link className="authLink" href="/signup">
              没有账号？去注册
            </Link>
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

