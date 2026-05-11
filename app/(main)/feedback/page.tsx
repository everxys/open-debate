import { requireUser } from "@/lib/auth";

import { FeedbackForm } from "./feedback-form";

export default async function FeedbackPage() {
  await requireUser();

  return (
    <section className="panel">
      <h2 style={{ marginTop: 0 }}>反馈与建议</h2>
      <p className="muted" style={{ marginTop: -6 }}>
        提交后管理员可以在后台菜单集中查看。
      </p>
      <FeedbackForm />
    </section>
  );
}
