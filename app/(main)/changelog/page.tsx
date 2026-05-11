import Link from "next/link";

import { MarkdownView } from "@/components/ui/markdown";
import { getChangelogPage, getCurrentRelease } from "@/lib/version";

export const dynamic = "force-dynamic";

type ChangelogPageProps = {
  searchParams?: Promise<{ page?: string | string[] }>;
};

function parsePage(value: string | string[] | undefined) {
  const raw = Array.isArray(value) ? value[0] : value;
  const page = Number(raw ?? "1");
  return Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
}

export default async function ChangelogPage({ searchParams }: ChangelogPageProps) {
  const requestedPage = parsePage((await searchParams)?.page);
  const pageData = getChangelogPage(requestedPage);
  const current = pageData.current ?? getCurrentRelease();

  return (
    <section className="grid" style={{ gap: 16 }}>
      <div className="panel">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div>
            <h2 style={{ margin: 0 }}>更新日志</h2>
            <div className="hint">
              当前版本：{current.version} · 共 {pageData.totalReleases} 个版本 · 第 {pageData.page} /{" "}
              {pageData.totalPages} 页
            </div>
          </div>
          <div className="versionBadge">{current.version}</div>
        </div>
      </div>

      <div className="changelogList">
        {pageData.releases.map((release) => (
          <article key={release.version} className="panel changelogEntry">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <div>
                <h3 style={{ margin: 0 }}>{release.title}</h3>
                <div className="hint">
                  {release.date} · {release.type}
                  {release.scope ? ` · ${release.scope}` : ""}
                </div>
              </div>
              <div className="versionBadge">{release.version}</div>
            </div>
            {release.body ? (
              <MarkdownView value={release.body} className="changelogMarkdown" />
            ) : (
              <div className="hint">暂无更新内容</div>
            )}
          </article>
        ))}
      </div>

      <div className="panel changelogPager">
        <div className="hint">
          第 {pageData.page} / {pageData.totalPages} 页，每页 {pageData.pageSize} 个版本
        </div>
        <div className="row">
          {pageData.page > 1 ? (
            <Link className="btn" href={`/changelog?page=${pageData.page - 1}`}>
              上一页
            </Link>
          ) : (
            <button className="btn" disabled>
              上一页
            </button>
          )}
          {pageData.page < pageData.totalPages ? (
            <Link className="btn" href={`/changelog?page=${pageData.page + 1}`}>
              下一页
            </Link>
          ) : (
            <button className="btn" disabled>
              下一页
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
