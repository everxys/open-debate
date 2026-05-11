import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  CHANGELOG_PAGE_SIZE,
  buildChangelog,
  parseChangelogEntry,
  type BuiltChangelog,
  type ChangelogEntry
} from "../lib/version";

const ROOT = process.cwd();
const ENTRIES_DIR = path.join(ROOT, "changelog", "entries");
const PUBLIC_CHANGELOG_DIR = path.join(ROOT, "public", "changelog");
const PAGES_DIR = path.join(PUBLIC_CHANGELOG_DIR, "pages");
const UPDATE_PATH = path.join(ROOT, "UPDATE.md");

function walkMarkdownFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return walkMarkdownFiles(fullPath);
    if (!entry.isFile()) return [];
    if (!entry.name.endsWith(".md")) return [];
    if (entry.name.toLowerCase() === "readme.md") return [];
    return [fullPath];
  });
}

function toRelativeEntryPath(filePath: string) {
  return path.relative(ENTRIES_DIR, filePath).replace(/\\/g, "/");
}

function loadEntries() {
  const files = walkMarkdownFiles(ENTRIES_DIR);
  return files.map((filePath): ChangelogEntry => {
    const relativePath = toRelativeEntryPath(filePath);
    return parseChangelogEntry(readFileSync(filePath, "utf8"), relativePath);
  });
}

function stableJson(value: unknown) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function expectedGeneratedFiles(changelog: BuiltChangelog) {
  const files = new Map<string, string>();
  files.set(path.join(PUBLIC_CHANGELOG_DIR, "index.json"), stableJson(changelog.index));
  files.set(path.join(PUBLIC_CHANGELOG_DIR, "current-version.json"), stableJson(changelog.currentVersion));
  for (const page of changelog.pages) {
    files.set(path.join(PAGES_DIR, `${page.page}.json`), stableJson(page));
  }
  files.set(UPDATE_PATH, changelog.updateMarkdown);
  return files;
}

function writeGenerated(changelog: BuiltChangelog) {
  rmSync(PUBLIC_CHANGELOG_DIR, { recursive: true, force: true });
  mkdirSync(PAGES_DIR, { recursive: true });

  for (const [filePath, content] of expectedGeneratedFiles(changelog)) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, content, "utf8");
  }
}

function listGeneratedPageFiles() {
  if (!existsSync(PAGES_DIR)) return [];
  return readdirSync(PAGES_DIR)
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.join(PAGES_DIR, name));
}

function checkGenerated(changelog: BuiltChangelog) {
  const expected = expectedGeneratedFiles(changelog);
  const errors: string[] = [];

  for (const [filePath, expectedContent] of expected) {
    if (!existsSync(filePath)) {
      errors.push(`missing generated file: ${path.relative(ROOT, filePath)}`);
      continue;
    }
    const actual = readFileSync(filePath, "utf8");
    if (actual !== expectedContent) errors.push(`stale generated file: ${path.relative(ROOT, filePath)}`);
  }

  for (const pageFile of listGeneratedPageFiles()) {
    if (!expected.has(pageFile)) errors.push(`stale generated page: ${path.relative(ROOT, pageFile)}`);
  }

  if (errors.length > 0) {
    throw new Error(`Changelog generated files are not up to date:\n${errors.map((item) => `- ${item}`).join("\n")}`);
  }
}

function main() {
  const command = process.argv[2] ?? "check";
  const entries = loadEntries();
  const changelog = buildChangelog(entries, CHANGELOG_PAGE_SIZE);

  if (command === "generate") {
    writeGenerated(changelog);
    console.log(`Generated ${changelog.index.totalReleases} changelog releases.`);
    return;
  }

  if (command === "check") {
    checkGenerated(changelog);
    console.log(`Checked ${changelog.index.totalReleases} changelog releases.`);
    return;
  }

  throw new Error(`Unknown changelog command "${command}". Use "generate" or "check".`);
}

main();
