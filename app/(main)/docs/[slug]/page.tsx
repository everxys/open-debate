import Link from "next/link";
import { notFound } from "next/navigation";

import { MarkdownView } from "@/components/ui/markdown";
import { readRepoTextFile } from "@/lib/docs";
import { DOCS, getDocBySlug } from "@/lib/docs-registry";

export default async function DocPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const doc = getDocBySlug(slug);
  if (!doc) notFound();

  let content = "";
  try {
    content = await readRepoTextFile(doc.filePath);
  } catch {
    content = `# 文档缺失\n\n未找到文件：\`${doc.filePath}\`\n`;
  }

  return (
    <div className="grid grid-2">
      <aside className="panel stack">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <strong>目录</strong>
          <Link className="btn" href="/docs">
            返回
          </Link>
        </div>
        <div className="stack" style={{ gap: 8 }}>
          {DOCS.map((item) => (
            <Link
              key={item.slug}
              className={`btn ${item.slug === doc.slug ? "btn-active" : ""}`}
              href={`/docs/${item.slug}`}
            >
              {item.title}
            </Link>
          ))}
        </div>
      </aside>

      <main className="panel">
        <MarkdownView value={content} />
      </main>
    </div>
  );
}
