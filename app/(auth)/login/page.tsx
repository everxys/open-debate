"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/feedback";
import { Field } from "@/components/ui/surface";

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
        <Field label="邮箱">
          <input
            autoComplete="email"
            inputMode="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com"
          />
        </Field>
        <Field label="密码">
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="你的密码"
          />
          <div className="hint">密码错误累计 5 次会临时锁定。</div>
        </Field>

        <Button
          variant="primary"
          disabled={!canSubmit || loading}
          onClick={() => void submit()}
        >
          {loading ? "登录中..." : "登录"}
        </Button>

        <div className="hint">
          没有账号？<Link className="authLink" href="/signup">去注册</Link>
        </div>

        {message ? (
          <Alert tone={message.type}>{message.text}</Alert>
        ) : null}
      </div>
    </section>
  );
}
