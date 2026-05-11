"use client";

import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/feedback";
import { Field } from "@/components/ui/surface";

type Message = { type: "success" | "error"; text: string } | null;

export function FeedbackForm() {
  const [category, setCategory] = useState("suggestion");
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<Message>(null);

  const canSubmit = useMemo(() => {
    return title.trim().length >= 2 && message.trim().length >= 5;
  }, [message, title]);

  async function submit() {
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    setResult(null);
    try {
      const response = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          category,
          title,
          message
        })
      });
      const payload = await response.json();
      if (!response.ok) {
        setResult({ type: "error", text: payload.error?.message ?? "提交失败" });
        return;
      }
      setTitle("");
      setMessage("");
      setCategory("suggestion");
      setResult({ type: "success", text: "反馈已提交" });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="feedbackControlScope stack" style={{ maxWidth: 760 }}>
      <Field label="类型">
        <select value={category} onChange={(event) => setCategory(event.target.value)}>
          <option value="suggestion">功能建议</option>
          <option value="bug">问题反馈</option>
          <option value="question">使用疑问</option>
          <option value="other">其他</option>
        </select>
      </Field>

      <Field label="标题">
        <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} />
      </Field>

      <Field label="内容">
        <textarea value={message} onChange={(event) => setMessage(event.target.value)} maxLength={5000} />
      </Field>

      <Button variant="primary" disabled={!canSubmit || submitting} onClick={() => void submit()}>
        {submitting ? "提交中..." : "提交反馈"}
      </Button>

      {result ? (
        <Alert tone={result.type}>{result.text}</Alert>
      ) : null}
    </div>
  );
}
