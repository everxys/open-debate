import Link from "next/link";

import { DOCS } from "@/lib/docs-registry";

function Section({ title, items }: { title: string; items: typeof DOCS }) {
  return (
    <div className="stack">
      <h3 style={{ margin: 0 }}>{title}</h3>
      <div className="stack" style={{ gap: 10 }}>
        {items.map((item) => (
          <Link key={item.slug} className="panel" href={`/docs/${item.slug}`}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <strong>{item.title}</strong>
              <span className="muted">/docs/{item.slug}</span>
            </div>
            <div className="muted">{item.description}</div>
          </Link>
        ))}
      </div>
    </div>
  );
}

export default function DocsIndexPage() {
  const guides = DOCS.filter((x) => x.section === "Guide");
  const designs = DOCS.filter((x) => x.section === "Design");

  return (
    <div className="grid grid-2">
      <section className="panel stack">
        <h2 style={{ marginTop: 0 }}>Docs</h2>
        <div className="muted">
          这里是项目内置文档。推荐从「Workflow 教程」开始，它决定了官方投票/角色/发言顺序如何通过{" "}
          <code>workflow.json</code> 配置。
        </div>
        <hr style={{ width: "100%", border: 0, borderTop: "1px solid var(--line)" }} />
        <div className="stack">
          {DOCS.map((item) => (
            <Link key={item.slug} className="btn" href={`/docs/${item.slug}`}>
              {item.title}
            </Link>
          ))}
        </div>
      </section>

      <section className="panel stack">
        <Section title="上手指南" items={guides} />
        <hr style={{ width: "100%", border: 0, borderTop: "1px solid var(--line)" }} />
        <Section title="设计与实现" items={designs} />
      </section>
    </div>
  );
}

