import test from "node:test";
import assert from "node:assert/strict";

import {
  buildChangelog,
  parseChangelogEntry,
  parseReleaseNotes,
  renderUpdateMarkdown
} from "@/lib/version";

test("parseChangelogEntry reads frontmatter and body", () => {
  const entry = parseChangelogEntry(
    `---
date: 2026-05-10
type: Fixed
title: 修复反馈页字段冗余
scope: feedback
order: 1200
---

反馈与建议去掉“相关页面”字段。
`,
    "2026/05/2026-05-10-feedback-page.md"
  );

  assert.deepEqual(entry, {
    date: "2026-05-10",
    type: "Fixed",
    title: "修复反馈页字段冗余",
    scope: "feedback",
    order: 1200,
    slug: "2026-05-10-feedback-page",
    body: "反馈与建议去掉“相关页面”字段。"
  });
});

test("buildChangelog assigns same-day versions by explicit order first", () => {
  const changelog = buildChangelog(
    [
      {
        date: "2026-05-10",
        type: "Changed",
        title: "first release today",
        order: 100,
        slug: "2026-05-10-001-first",
        body: "first"
      },
      {
        date: "2026-05-10",
        type: "Changed",
        title: "second release today",
        order: 200,
        slug: "2026-05-10-002-second",
        body: "second"
      },
      {
        date: "2026-05-09",
        type: "Fixed",
        title: "older release",
        slug: "2026-05-09-001-older",
        body: "older"
      }
    ],
    2
  );

  assert.deepEqual(
    changelog.pages.flatMap((page) => page.releases.map((release) => release.version)),
    ["v2026.05.10.2", "v2026.05.10.1", "v2026.05.09.1"]
  );
  assert.equal(changelog.index.totalPages, 2);
  assert.equal(changelog.currentVersion.current?.title, "second release today");
});

test("buildChangelog falls back to slug order when order is omitted", () => {
  const changelog = buildChangelog([
    {
      date: "2026-05-10",
      type: "Changed",
      title: "older by slug",
      slug: "2026-05-10-001-older",
      body: "older"
    },
    {
      date: "2026-05-10",
      type: "Changed",
      title: "newer by slug",
      slug: "2026-05-10-999-newer",
      body: "newer"
    }
  ]);

  assert.equal(changelog.currentVersion.current?.title, "newer by slug");
  assert.equal(changelog.currentVersion.current?.version, "v2026.05.10.2");
});

test("renderUpdateMarkdown includes generated version metadata", () => {
  const changelog = buildChangelog([
    {
      date: "2026-05-10",
      type: "Security",
      title: "收紧登录校验",
      scope: "auth",
      slug: "2026-05-10-001-auth",
      body: "登录接口补充校验。"
    }
  ]);

  assert.equal(
    renderUpdateMarkdown(changelog.pages[0].releases),
    `## 2026-05-10

### 收紧登录校验

类型：Security · 范围：auth · 版本：v2026.05.10.1

登录接口补充校验。
`
  );
});

test("parseReleaseNotes keeps legacy UPDATE.md compatibility", () => {
  const releases = parseReleaseNotes(`
## 2026-05-10

- second release today

## 2026-05-10

- first release today

## 2026-05-09

- older release
`);

  assert.deepEqual(
    releases.map((release) => release.version),
    ["v2026.05.10.1", "v2026.05.10.2", "v2026.05.09.1"]
  );
});
