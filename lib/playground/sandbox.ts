import { AppError } from "@/lib/http";
import type {
  PlaygroundSandboxFileInput,
  PlaygroundSandboxFileScope,
  PlaygroundSandboxFileSnapshot
} from "@/lib/playground/types";

type SandboxEntry = PlaygroundSandboxFileSnapshot;

type DebateWriteMode = "replace" | "append" | "section_merge";
type SandboxVoteKind = "finalization" | "custom";
type SandboxVoteBallot = {
  voter: string;
  choice: string;
  reason: string | null;
  at: string;
};
type SandboxOpenVote = {
  status: "open";
  kind: SandboxVoteKind;
  title: string;
  prompt: string;
  options: string[];
  ballots: SandboxVoteBallot[];
  createdAt: string;
};
type SandboxClosedVote = {
  status: "closed";
  kind: SandboxVoteKind;
  title: string;
  prompt: string;
  options: string[];
  ballots: SandboxVoteBallot[];
  result: {
    winner: string | null;
    counts: Record<string, number>;
    totalBallots: number;
  };
  closedAt: string;
  createdAt: string;
};
type SandboxVoteRecord = SandboxOpenVote | SandboxClosedVote;

const DEBATE_ALLOWED_PREFIXES = ["sandbox/", "outputs/"];
const SANDBOX_OPEN_VOTE_PATH = "sandbox/votes/open-vote.json";
const SANDBOX_VOTE_RESULT_JSON_PATH = "outputs/vote-result.json";
const SANDBOX_VOTE_RESULT_MARKDOWN_PATH = "outputs/vote-result.md";

function normalizePath(path: string) {
  return String(path ?? "").trim().replace(/^\/+/, "");
}

function isAllowedDebatePath(path: string) {
  return DEBATE_ALLOWED_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function assertRelativePath(path: string) {
  const normalized = normalizePath(path);
  if (!normalized || normalized.includes("\\") || normalized.includes("..") || normalized.endsWith("/")) {
    throw new AppError("VALIDATION_ERROR", 400, `Invalid sandbox path: ${path}`);
  }
  return normalized;
}

function normalizeListPrefix(prefix?: string) {
  const normalized = normalizePath(prefix ?? "");
  if (!normalized) return "";
  if (normalized.includes("\\") || normalized.includes("..")) {
    throw new AppError("VALIDATION_ERROR", 400, `Invalid sandbox prefix: ${prefix}`);
  }
  return normalized;
}

function cloneEntry(entry: SandboxEntry): SandboxEntry {
  return { ...entry };
}

function buildSectionMergeContent(current: string, targetHeading: string, replacement: string) {
  const heading = targetHeading.trim();
  if (!heading) {
    throw new AppError("VALIDATION_ERROR", 400, "section_merge requires targetHeading");
  }

  const normalizedReplacement = replacement.trim();
  if (!normalizedReplacement) {
    throw new AppError("VALIDATION_ERROR", 400, "section_merge requires replacement content");
  }

  const normalizedHeading = heading.replace(/^#+\s*/, "").trim().toLowerCase();
  const lines = current.split(/\r?\n/);
  const headingIndexes = lines
    .map((line, index) => ({ line, index }))
    .filter((item) => /^\s{0,3}#{1,6}\s+\S/.test(item.line))
    .map((item) => ({
      index: item.index,
      level: (item.line.match(/^(\s{0,3})(#{1,6})\s+/)?.[2].length ?? 1),
      text: item.line.replace(/^\s{0,3}#{1,6}\s+/, "").trim().toLowerCase()
    }));

  const match = headingIndexes.find((item) => item.text === normalizedHeading);
  if (!match) {
    const separator = current.trim().length > 0 ? "\n\n" : "";
    return `${current}${separator}${normalizedReplacement}\n`;
  }

  const nextHeading = headingIndexes.find((item) => item.index > match.index && item.level <= match.level);
  const start = match.index;
  const end = nextHeading ? nextHeading.index : lines.length;
  const before = lines.slice(0, start).join("\n");
  const after = lines.slice(end).join("\n");
  const parts = [before.trimEnd(), normalizedReplacement.trim(), after.trimStart()].filter(Boolean);
  return `${parts.join("\n\n")}\n`;
}

export class PlaygroundSandbox {
  private readonly files = new Map<string, SandboxEntry>();
  private voteRecord: SandboxVoteRecord | null = null;

  constructor(initialFiles: PlaygroundSandboxFileInput[]) {
    for (const file of initialFiles) {
      const scope = file.scope ?? "debate";
      const path = assertRelativePath(file.path);
      if (scope === "debate" && !isAllowedDebatePath(path)) {
        throw new AppError("VALIDATION_ERROR", 400, `Debate sandbox path must stay under sandbox/ or outputs/: ${path}`);
      }
      const now = new Date().toISOString();
      this.files.set(this.key(scope, path), {
        scope,
        path,
        content: file.content,
        size: file.content.length,
        version: 1,
        createdAt: now,
        updatedAt: now
      });
    }
  }

  private key(scope: PlaygroundSandboxFileScope, path: string) {
    return `${scope}:${path}`;
  }

  private upsertSandboxEntry(scope: PlaygroundSandboxFileScope, path: string, content: string) {
    const normalized = assertRelativePath(path);
    const key = this.key(scope, normalized);
    const existing = this.files.get(key) ?? null;
    const now = new Date().toISOString();
    const next: SandboxEntry = {
      scope,
      path: normalized,
      content,
      size: content.length,
      version: existing ? existing.version + 1 : 1,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    this.files.set(key, next);
    return next;
  }

  snapshot() {
    return [...this.files.values()]
      .map((entry) => cloneEntry(entry))
      .sort((a, b) => a.scope.localeCompare(b.scope) || a.path.localeCompare(b.path));
  }

  listFiles(scope: PlaygroundSandboxFileScope, prefix?: string) {
    const normalizedPrefix = normalizeListPrefix(prefix).replace(/\/$/, "");
    return this.snapshot()
      .filter((entry) => entry.scope === scope)
      .filter((entry) => !normalizedPrefix || entry.path.startsWith(normalizedPrefix))
      .map((entry) => entry.path);
  }

  readFile(scope: PlaygroundSandboxFileScope, path: string) {
    const normalized = assertRelativePath(path);
    const entry = this.files.get(this.key(scope, normalized));
    return entry ? entry.content : `NOT_FOUND: ${normalized}`;
  }

  searchFiles(scope: PlaygroundSandboxFileScope, queryText: string) {
    const query = String(queryText ?? "").trim().toLowerCase();
    if (!query) return [];
    return this.snapshot()
      .filter((entry) => entry.scope === scope)
      .filter((entry) => entry.content.toLowerCase().includes(query))
      .slice(0, 5)
      .map((entry) => {
        const lower = entry.content.toLowerCase();
        const index = lower.indexOf(query);
        const start = Math.max(0, index - 120);
        const end = Math.min(entry.content.length, index + query.length + 120);
        return {
          path: entry.path,
          snippet: entry.content.slice(start, end)
        };
      });
  }

  statDebateFile(path: string) {
    const normalized = assertRelativePath(path);
    if (!isAllowedDebatePath(normalized)) {
      return {
        error: `Invalid path. Only ${DEBATE_ALLOWED_PREFIXES.join(", ")} allowed (no '..').`
      };
    }
    const entry = this.files.get(this.key("debate", normalized));
    if (!entry) {
      return { ok: true, path: normalized, exists: false, size: 0, updatedAt: null, version: 0 };
    }
    return {
      ok: true,
      path: normalized,
      exists: true,
      size: entry.size,
      updatedAt: entry.updatedAt,
      version: entry.version
    };
  }

  writeDebateFile(input: {
    path: string;
    content: string;
    mode: string | null;
    baseVersion: number | null;
    baseUpdatedAt: string | null;
    reason: string | null;
    targetHeading: string | null;
    allowShrink: boolean;
  }) {
    const normalized = assertRelativePath(input.path);
    if (!isAllowedDebatePath(normalized)) {
      return {
        error: `Invalid path. Only ${DEBATE_ALLOWED_PREFIXES.join(", ")} allowed (no '..').`
      };
    }

    const key = this.key("debate", normalized);
    const existing = this.files.get(key) ?? null;
    const nextMode: DebateWriteMode =
      input.mode === "append" || input.mode === "section_merge" || input.mode === "replace"
        ? input.mode
        : "replace";

    if (existing && input.baseVersion !== null && input.baseVersion !== existing.version) {
      return {
        error: `VERSION_CONFLICT: expected baseVersion=${existing.version}, got ${input.baseVersion}`
      };
    }

    if (existing && input.baseUpdatedAt && input.baseUpdatedAt !== existing.updatedAt) {
      return {
        error: `VERSION_CONFLICT: expected baseUpdatedAt=${existing.updatedAt}, got ${input.baseUpdatedAt}`
      };
    }

    let nextContent = String(input.content ?? "");
    if (existing && nextMode === "append") {
      nextContent = `${existing.content}${nextContent}`;
    } else if (existing && nextMode === "section_merge") {
      nextContent = buildSectionMergeContent(existing.content, input.targetHeading ?? "", nextContent);
    }

    if (existing && !input.allowShrink && nextMode === "replace" && nextContent.length < existing.content.length * 0.5) {
      return {
        error: "WRITE_REJECTED: replacement shrinks file too much; pass allowShrink=true if intentional."
      };
    }

    const now = new Date().toISOString();
    const updated: SandboxEntry = {
      scope: "debate",
      path: normalized,
      content: nextContent,
      size: nextContent.length,
      version: existing ? existing.version + 1 : 1,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    this.files.set(key, updated);

    return {
      ok: true,
      path: normalized,
      size: updated.size,
      version: updated.version,
      updatedAt: updated.updatedAt,
      mode: nextMode,
      reason: input.reason ?? null,
      verification: {
        path: normalized,
        version: updated.version,
        size: updated.size,
        updatedAt: updated.updatedAt
      },
      message: `WRITE_CONFIRMED: ${normalized} v${updated.version} size=${updated.size}`
    };
  }

  openVote(input: {
    kind: SandboxVoteKind;
    title: string;
    prompt?: string;
    options?: string[];
  }) {
    if (this.voteRecord?.status === "open") {
      return { ok: false, error: "A vote is already open." };
    }
    const title = String(input.title ?? "").trim();
    if (!title) {
      return { ok: false, error: "Vote title is required." };
    }
    const prompt =
      typeof input.prompt === "string" && input.prompt.trim()
        ? input.prompt.trim()
        : input.kind === "finalization"
          ? "请判断是否可以进入收束阶段。"
          : "请在给定选项中做出选择。";
    const options =
      input.kind === "finalization"
        ? ["进入收束阶段", "继续讨论"]
        : Array.isArray(input.options)
          ? input.options.map((item) => String(item).trim()).filter(Boolean)
          : [];
    if (input.kind === "custom" && options.length < 2) {
      return { ok: false, error: "Custom vote requires at least 2 options." };
    }
    const vote: SandboxOpenVote = {
      status: "open",
      kind: input.kind,
      title,
      prompt,
      options,
      ballots: [],
      createdAt: new Date().toISOString()
    };
    this.voteRecord = vote;
    this.upsertSandboxEntry("debate", SANDBOX_OPEN_VOTE_PATH, JSON.stringify(vote, null, 2));
    return { ok: true, vote };
  }

  castVote(input: { choice?: string; reason?: string }) {
    if (!this.voteRecord || this.voteRecord.status !== "open") {
      return { ok: false, error: "No open vote." };
    }
    const choice = String(input.choice ?? "").trim();
    if (!choice) {
      return { ok: false, error: "Vote choice is required." };
    }
    const ballot: SandboxVoteBallot = {
      voter: "Playground Seat",
      choice,
      reason: typeof input.reason === "string" && input.reason.trim() ? input.reason.trim() : null,
      at: new Date().toISOString()
    };
    const nextVote: SandboxOpenVote = {
      ...this.voteRecord,
      ballots: [...this.voteRecord.ballots.filter((item) => item.voter !== ballot.voter), ballot]
    };
    this.voteRecord = nextVote;
    this.upsertSandboxEntry("debate", SANDBOX_OPEN_VOTE_PATH, JSON.stringify(nextVote, null, 2));
    return { ok: true, vote: nextVote, ballot };
  }

  closeVote() {
    if (!this.voteRecord || this.voteRecord.status !== "open") {
      return { ok: false, error: "No open vote." };
    }
    const counts = new Map<string, number>();
    for (const ballot of this.voteRecord.ballots) {
      counts.set(ballot.choice, (counts.get(ballot.choice) ?? 0) + 1);
    }
    const ranked = Array.from(counts.entries()).sort((left, right) => right[1] - left[1]);
    const winner = ranked[0]?.[0] ?? null;
    const closedVote: SandboxClosedVote = {
      status: "closed",
      kind: this.voteRecord.kind,
      title: this.voteRecord.title,
      prompt: this.voteRecord.prompt,
      options: this.voteRecord.options,
      ballots: this.voteRecord.ballots,
      result: {
        winner,
        counts: Object.fromEntries(counts),
        totalBallots: this.voteRecord.ballots.length
      },
      closedAt: new Date().toISOString(),
      createdAt: this.voteRecord.createdAt
    };
    this.voteRecord = closedVote;
    this.upsertSandboxEntry("debate", SANDBOX_OPEN_VOTE_PATH, JSON.stringify(closedVote, null, 2));
    this.upsertSandboxEntry("debate", SANDBOX_VOTE_RESULT_JSON_PATH, JSON.stringify(closedVote, null, 2));
    const summary = [
      "# Sandbox Vote Result",
      "",
      `- 标题：${closedVote.title}`,
      `- 类型：${closedVote.kind}`,
      `- 赢家：${closedVote.result.winner ?? "无"}`,
      `- 总投票数：${closedVote.result.totalBallots}`,
      "",
      "## 票数",
      ...closedVote.options.map((option) => `- ${option}: ${closedVote.result.counts[option] ?? 0}`),
      "",
      "## 逐票明细",
      ...(closedVote.ballots.length > 0
        ? closedVote.ballots.map((ballot) => `- ${ballot.voter}: ${ballot.choice}${ballot.reason ? ` · ${ballot.reason}` : ""}`)
        : ["- 无投票记录"])
    ].join("\n");
    this.upsertSandboxEntry("debate", SANDBOX_VOTE_RESULT_MARKDOWN_PATH, `${summary}\n`);
    return { ok: true, closed: closedVote, decision: summary };
  }
}
