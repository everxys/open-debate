import type {
  RoleDraft,
  StrategyFileAccessRule,
  WorkflowContextAccess,
  WorkflowContextAccessRule,
  WorkflowPhaseGateRule,
  WorkflowPhaseKind,
  WorkflowSummarizer
} from "./strategy-detail-types";

export function createClientId() {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

export function stripImportedRootPrefix(paths: string[]) {
  if (paths.includes("manifest.json")) return paths;
  const firstSegments = Array.from(new Set(paths.map((item) => item.split("/")[0]).filter(Boolean)));
  if (firstSegments.length !== 1) return paths;
  const root = firstSegments[0];
  if (!paths.includes(`${root}/manifest.json`)) return paths;
  return paths
    .filter((item) => item.startsWith(`${root}/`))
    .map((item) => item.slice(root.length + 1));
}

export function summarizePrompt(value: string) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return "未配置";
  return normalized.length > 90 ? `${normalized.slice(0, 90)}...` : normalized;
}

export function formatLocalTime(value: string | null | undefined) {
  if (!value) return "未知";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "未知";
  return date.toLocaleString("zh-CN", { hour12: false });
}

export function summarizeRoles(roles: RoleDraft[]) {
  if (roles.length <= 0) return "暂无角色";
  const names = roles.map((role) => role.name || "(未命名)");
  const preview = names.slice(0, 6).join("、");
  if (names.length <= 6) return `${preview}（共 ${names.length} 个）`;
  return `${preview} 等 ${names.length} 个`;
}

export function createContextAccessRule(): WorkflowContextAccessRule {
  return {
    scope: "shared",
    pathPrefix: "",
    maxFiles: 6,
    maxCharsPerFile: 4000,
    recursive: true
  };
}

export function createPhaseGateRule(): WorkflowPhaseGateRule {
  return {
    ...createContextAccessRule(),
    phaseKind: "deliberation"
  };
}

export function normalizeContextAccessPayload(value: unknown): WorkflowContextAccess {
  const obj = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  const normalizeRule = (item: unknown): WorkflowContextAccessRule => {
    const rule = typeof item === "object" && item !== null ? (item as Record<string, unknown>) : null;
    return {
      scope: rule?.scope === "seat" ? "seat" : "shared",
      pathPrefix: typeof rule?.pathPrefix === "string" ? rule.pathPrefix : "",
      maxFiles:
        typeof rule?.maxFiles === "number" && Number.isFinite(rule.maxFiles) && rule.maxFiles > 0
          ? Math.floor(rule.maxFiles)
          : 6,
      maxCharsPerFile:
        typeof rule?.maxCharsPerFile === "number" && Number.isFinite(rule.maxCharsPerFile) && rule.maxCharsPerFile > 0
          ? Math.floor(rule.maxCharsPerFile)
          : 4000,
      recursive: rule?.recursive === undefined ? true : Boolean(rule.recursive)
    };
  };

  const alwaysRead = Array.isArray(obj?.alwaysRead) ? obj.alwaysRead.map((item) => normalizeRule(item)) : [];
  const readWhenNeeded = Array.isArray(obj?.readWhenNeeded) ? obj.readWhenNeeded.map((item) => normalizeRule(item)) : [];
  const unlockAfterPhase = Array.isArray(obj?.unlockAfterPhase)
    ? obj.unlockAfterPhase.map((item) => {
        const rule = normalizeRule(item);
        const raw = typeof item === "object" && item !== null ? (item as Record<string, unknown>) : null;
        const phaseKind: WorkflowPhaseKind =
          raw?.phaseKind === "analysis" ||
          raw?.phaseKind === "deliberation" ||
          raw?.phaseKind === "finalization_vote" ||
          raw?.phaseKind === "finalization"
            ? raw.phaseKind
            : "deliberation";
        return { ...rule, phaseKind };
      })
    : [];

  return { alwaysRead, readWhenNeeded, unlockAfterPhase };
}

export function normalizeSummarizerPayload(value: unknown): WorkflowSummarizer {
  const obj = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  const prompts = typeof obj?.prompts === "object" && obj.prompts !== null ? (obj.prompts as Record<string, unknown>) : null;
  const outputPaths =
    typeof obj?.outputPaths === "object" && obj.outputPaths !== null
      ? (obj.outputPaths as Record<string, unknown>)
      : null;
  return {
    enabled: Boolean(obj?.enabled),
    perTurn: obj?.perTurn === undefined ? true : Boolean(obj?.perTurn),
    perRound: obj?.perRound === undefined ? true : Boolean(obj?.perRound),
    factsBoard: obj?.factsBoard === undefined ? true : Boolean(obj?.factsBoard),
    prompts: {
      turnSummary: typeof prompts?.turnSummary === "string" ? prompts.turnSummary : "",
      roundSummary: typeof prompts?.roundSummary === "string" ? prompts.roundSummary : "",
      factsBoard: typeof prompts?.factsBoard === "string" ? prompts.factsBoard : ""
    },
    outputPaths: {
      turnSummaryDir: typeof outputPaths?.turnSummaryDir === "string" ? outputPaths.turnSummaryDir : "debate/turn_summaries/",
      roundSummaryDir:
        typeof outputPaths?.roundSummaryDir === "string" ? outputPaths.roundSummaryDir : "debate/round_summaries/",
      factsBoardPath: typeof outputPaths?.factsBoardPath === "string" ? outputPaths.factsBoardPath : "facts/board.md"
    }
  };
}

export function normalizeStrategyFileAccessRules(value: unknown): StrategyFileAccessRule[] {
  const items = Array.isArray(value) ? value : [];
  return items.map((item) => {
    const row = typeof item === "object" && item !== null ? (item as Record<string, unknown>) : {};
    return {
      id: String(row.id ?? ""),
      strategyRoleId: typeof row.strategyRoleId === "string" ? row.strategyRoleId : null,
      scope: row.scope === "seat" ? "seat" : "shared",
      targetType: row.targetType === "file" ? "file" : "dir",
      targetPath: String(row.targetPath ?? ""),
      accessMode:
        row.accessMode === "unlock_after_phase"
          ? "unlock_after_phase"
          : row.accessMode === "read_when_needed"
            ? "read_when_needed"
            : "always_read",
      phaseKind:
        row.phaseKind === "analysis" ||
        row.phaseKind === "deliberation" ||
        row.phaseKind === "finalization_vote" ||
        row.phaseKind === "finalization"
          ? row.phaseKind
          : null
    };
  });
}

export async function readPayload(response: Response) {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      return await response.json();
    } catch {
    }
  }

  let text = "";
  try {
    text = await response.text();
  } catch {
  }

  return {
    success: false,
    error: { message: text || `${response.status} ${response.statusText}`.trim() }
  };
}
