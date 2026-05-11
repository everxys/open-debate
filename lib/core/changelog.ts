import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const CHANGELOG_PAGE_SIZE = 5;
export const CHANGELOG_SCHEMA_VERSION = 1;
export const CHANGELOG_ENTRY_TYPES = ["Added", "Changed", "Fixed", "Removed", "Security", "Internal"] as const;

export type ChangelogEntryType = (typeof CHANGELOG_ENTRY_TYPES)[number];

export type ChangelogEntry = {
  date: string;
  type: ChangelogEntryType;
  title: string;
  scope?: string;
  order?: number;
  slug: string;
  body: string;
};

export type ReleaseNote = ChangelogEntry & {
  sequence: number;
  version: string;
};

export type ChangelogPageInfo = {
  page: number;
  path: string;
  releaseCount: number;
};

export type ChangelogIndex = {
  schemaVersion: typeof CHANGELOG_SCHEMA_VERSION;
  pageSize: number;
  totalReleases: number;
  totalPages: number;
  current: ReleaseNote | null;
  pages: ChangelogPageInfo[];
};

export type ChangelogPageData = {
  schemaVersion: typeof CHANGELOG_SCHEMA_VERSION;
  page: number;
  pageSize: number;
  totalReleases: number;
  totalPages: number;
  current: ReleaseNote | null;
  releases: ReleaseNote[];
};

export type BuiltChangelog = {
  index: ChangelogIndex;
  currentVersion: {
    schemaVersion: typeof CHANGELOG_SCHEMA_VERSION;
    current: ReleaseNote | null;
  };
  pages: ChangelogPageData[];
  updateMarkdown: string;
};

const GENERATED_CHANGELOG_DIR = path.join(process.cwd(), "public", "changelog");
const CHANGELOG_INDEX_PATH = path.join(GENERATED_CHANGELOG_DIR, "index.json");
const CHANGELOG_CURRENT_PATH = path.join(GENERATED_CHANGELOG_DIR, "current-version.json");
const DATE_HEADING = /^##\s+(\d{4}-\d{2}-\d{2})\s*$/;
const DATE_VALUE = /^\d{4}-\d{2}-\d{2}$/;
const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

function isValidDateString(value: string) {
  if (!DATE_VALUE.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function stripQuotes(value: string) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function slugFromPath(sourcePath: string) {
  const filename = sourcePath.replace(/\\/g, "/").split("/").at(-1) ?? sourcePath;
  return filename.replace(/\.[^.]+$/, "");
}

function assertEntryType(value: string, sourcePath: string): ChangelogEntryType {
  if ((CHANGELOG_ENTRY_TYPES as readonly string[]).includes(value)) return value as ChangelogEntryType;
  throw new Error(`${sourcePath}: invalid changelog type "${value}"`);
}

function readJsonFile<T>(filePath: string): T | null {
  if (!existsSync(filePath)) return null;
  return JSON.parse(readFileSync(filePath, "utf8")) as T;
}

export function formatDateVersion(date: string, sequence = 1) {
  return `v${date.replaceAll("-", ".")}.${sequence}`;
}

export function fallbackRelease(date = new Date().toISOString().slice(0, 10)): ReleaseNote {
  return {
    date,
    type: "Changed",
    title: "暂无更新日志",
    slug: `fallback-${date}`,
    sequence: 1,
    version: formatDateVersion(date, 1),
    body: ""
  };
}

export function parseChangelogEntry(markdown: string, sourcePath = "inline.md"): ChangelogEntry {
  const normalized = markdown.replace(/\r\n/g, "\n");
  const match = normalized.match(FRONTMATTER);
  if (!match) throw new Error(`${sourcePath}: changelog entry must start with YAML-style frontmatter`);

  const fields = new Map<string, string>();
  for (const line of match[1].split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const fieldMatch = trimmed.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!fieldMatch) throw new Error(`${sourcePath}: invalid frontmatter line "${line}"`);
    fields.set(fieldMatch[1], stripQuotes(fieldMatch[2]));
  }

  const date = fields.get("date") ?? "";
  const type = fields.get("type") ?? "";
  const title = fields.get("title") ?? "";
  const scope = fields.get("scope") || undefined;
  const rawOrder = fields.get("order");
  const order = rawOrder ? Number(rawOrder) : undefined;
  const body = match[2].trim();

  if (!isValidDateString(date)) throw new Error(`${sourcePath}: invalid changelog date "${date}"`);
  if (!title.trim()) throw new Error(`${sourcePath}: changelog title is required`);
  if (order !== undefined && (!Number.isInteger(order) || order < 0)) {
    throw new Error(`${sourcePath}: changelog order must be a non-negative integer`);
  }
  if (!body) throw new Error(`${sourcePath}: changelog body is required`);

  return {
    date,
    type: assertEntryType(type, sourcePath),
    title: title.trim(),
    scope: scope?.trim(),
    order,
    slug: slugFromPath(sourcePath),
    body
  };
}

export function parseReleaseNotes(markdown: string): ReleaseNote[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const releases: ReleaseNote[] = [];
  const dateCounts = new Map<string, number>();
  let currentDate: string | null = null;
  let currentBody: string[] = [];

  function flush() {
    if (!currentDate) return;
    const sequence = (dateCounts.get(currentDate) ?? 0) + 1;
    dateCounts.set(currentDate, sequence);
    releases.push({
      date: currentDate,
      type: "Changed",
      title: `${currentDate} 更新`,
      slug: `legacy-${currentDate}-${sequence}`,
      sequence,
      version: formatDateVersion(currentDate, sequence),
      body: currentBody.join("\n").trim()
    });
  }

  for (const line of lines) {
    const match = line.match(DATE_HEADING);
    if (match) {
      flush();
      currentDate = match[1];
      currentBody = [];
      continue;
    }
    if (currentDate) currentBody.push(line);
  }

  flush();
  return releases;
}

export function buildReleaseNotes(entries: ChangelogEntry[]) {
  const seenSlugs = new Set<string>();
  for (const entry of entries) {
    if (seenSlugs.has(entry.slug)) throw new Error(`duplicate changelog slug "${entry.slug}"`);
    seenSlugs.add(entry.slug);
  }

  const sequenceBySlug = new Map<string, number>();
  const entriesByDate = new Map<string, ChangelogEntry[]>();
  for (const entry of entries) {
    entriesByDate.set(entry.date, [...(entriesByDate.get(entry.date) ?? []), entry]);
  }
  for (const sameDayEntries of entriesByDate.values()) {
    sameDayEntries
      .sort((a, b) => {
        const orderCompare = (a.order ?? 0) - (b.order ?? 0);
        if (orderCompare !== 0) return orderCompare;
        return a.slug.localeCompare(b.slug);
      })
      .forEach((entry, index) => {
        sequenceBySlug.set(entry.slug, index + 1);
      });
  }

  const sorted = [...entries].sort((a, b) => {
    const dateCompare = b.date.localeCompare(a.date);
    if (dateCompare !== 0) return dateCompare;
    const orderCompare = (b.order ?? 0) - (a.order ?? 0);
    if (orderCompare !== 0) return orderCompare;
    return b.slug.localeCompare(a.slug);
  });

  return sorted.map((entry) => {
    const sequence = sequenceBySlug.get(entry.slug) ?? 1;
    return {
      ...entry,
      sequence,
      version: formatDateVersion(entry.date, sequence)
    };
  });
}

export function renderUpdateMarkdown(releases: ReleaseNote[]) {
  const content = releases
    .map((release) => {
      const meta = [`类型：${release.type}`, release.scope ? `范围：${release.scope}` : null, `版本：${release.version}`]
        .filter(Boolean)
        .join(" · ");
      return [`## ${release.date}`, "", `### ${release.title}`, "", meta, "", release.body.trim()].join("\n");
    })
    .join("\n\n");
  return `${content.trim()}\n`;
}

export function buildChangelog(entries: ChangelogEntry[], pageSize = CHANGELOG_PAGE_SIZE): BuiltChangelog {
  if (!Number.isInteger(pageSize) || pageSize <= 0) throw new Error("changelog page size must be a positive integer");

  const releases = buildReleaseNotes(entries);
  const totalReleases = releases.length;
  const totalPages = Math.max(1, Math.ceil(totalReleases / pageSize));
  const current = releases[0] ?? null;
  const pageInfos: ChangelogPageInfo[] = [];
  const pages: ChangelogPageData[] = [];

  for (let page = 1; page <= totalPages; page += 1) {
    const startIndex = (page - 1) * pageSize;
    const pageReleases = releases.slice(startIndex, startIndex + pageSize);
    const pagePath = `pages/${page}.json`;
    pageInfos.push({ page, path: pagePath, releaseCount: pageReleases.length });
    pages.push({
      schemaVersion: CHANGELOG_SCHEMA_VERSION,
      page,
      pageSize,
      totalReleases,
      totalPages,
      current,
      releases: pageReleases
    });
  }

  return {
    index: {
      schemaVersion: CHANGELOG_SCHEMA_VERSION,
      pageSize,
      totalReleases,
      totalPages,
      current,
      pages: pageInfos
    },
    currentVersion: {
      schemaVersion: CHANGELOG_SCHEMA_VERSION,
      current
    },
    pages,
    updateMarkdown: renderUpdateMarkdown(releases)
  };
}

export function getChangelogIndex(): ChangelogIndex {
  return (
    readJsonFile<ChangelogIndex>(CHANGELOG_INDEX_PATH) ?? {
      schemaVersion: CHANGELOG_SCHEMA_VERSION,
      pageSize: CHANGELOG_PAGE_SIZE,
      totalReleases: 0,
      totalPages: 1,
      current: null,
      pages: [{ page: 1, path: "pages/1.json", releaseCount: 0 }]
    }
  );
}

export function getCurrentRelease() {
  return readJsonFile<{ current: ReleaseNote | null }>(CHANGELOG_CURRENT_PATH)?.current ?? fallbackRelease();
}

export function getChangelogPage(requestedPage: number): ChangelogPageData {
  const index = getChangelogIndex();
  const page = Math.min(Math.max(1, Math.floor(requestedPage) || 1), index.totalPages);
  const pageInfo = index.pages.find((item) => item.page === page);
  const generatedPage = pageInfo
    ? readJsonFile<ChangelogPageData>(path.join(GENERATED_CHANGELOG_DIR, pageInfo.path))
    : null;
  return (
    generatedPage ?? {
      schemaVersion: CHANGELOG_SCHEMA_VERSION,
      page,
      pageSize: index.pageSize,
      totalReleases: index.totalReleases,
      totalPages: index.totalPages,
      current: index.current,
      releases: []
    }
  );
}

export function getReleaseNotes() {
  const index = getChangelogIndex();
  return index.pages.flatMap((pageInfo) => {
    const page = readJsonFile<ChangelogPageData>(path.join(GENERATED_CHANGELOG_DIR, pageInfo.path));
    return page?.releases ?? [];
  });
}
