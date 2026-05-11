import { requireAdmin } from "@/lib/auth";
import {
  getFeedbackCategoryLabel,
  getFeedbackStatusLabel,
  listFeedbackForAdmin
} from "@/lib/feedback";

export const dynamic = "force-dynamic";

function formatTime(value: string) {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

export default async function AdminFeedbackPage() {
  await requireAdmin();
  const feedback = await listFeedbackForAdmin();

  return (
    <section className="grid" style={{ gap: 16 }}>
      <div className="panel">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div>
            <h2 style={{ margin: 0 }}>反馈与建议</h2>
            <div className="hint">共 {feedback.length} 条反馈</div>
          </div>
        </div>
      </div>

      <div className="panel">
        {feedback.length === 0 ? (
          <div className="hint">暂无反馈</div>
        ) : (
          <div className="feedbackList">
            {feedback.map((item) => (
              <article key={item.id} className="feedbackItem">
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <div>
                    <div className="feedbackItemTitle">{item.title}</div>
                    <div className="hint">
                      {item.userEmail} · {formatTime(item.createdAt)}
                    </div>
                  </div>
                <div className="row">
                  <span className="feedbackPill">{getFeedbackCategoryLabel(item.category)}</span>
                  <span className="feedbackPill">{getFeedbackStatusLabel(item.status)}</span>
                </div>
              </div>
                <p className="feedbackMessage">{item.message}</p>
              </article>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
