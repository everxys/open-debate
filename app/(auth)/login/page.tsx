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
    <section className="authCard">
      <h1 className="authTitle">登录</h1>
      <p className="authSubtitle">输入邮箱和密码。</p>

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
          <div className="hint">密码错误累计 5 次会临时锁定。</div>
        </div>

        <button
          className="btn btn-primary"
          disabled={!canSubmit || loading}
          onClick={() => void submit()}
        >
          {loading ? "登录中..." : "登录"}
        </button>

        <div className="hint">
          没有账号？<Link className="authLink" href="/signup">去注册</Link>
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
