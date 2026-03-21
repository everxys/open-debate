export type DebateWorkflowConfig = {
  workflowVersion?: number;
  enabled?: boolean;
  phaseMachine?: {
    phases?: Array<{
      id?: string;
      title?: string;
      kind?: "analysis" | "election" | "deliberation" | "finalization";
      description?: string | null;
    }>;
    transitionRules?: {
      election?: {
        startRound?: number;
        autoOpen?: boolean;
      };
      finalization?: {
        enterOnConsensus?: boolean;
        enterOnCustomVote?: boolean;
        requirePhaseForCompletion?: boolean;
      };
    };
  };

  // v1 recommended shape
  election?: {
    startRound?: number;
    roles?: string[];
    speakingOrder?: {
      firstRole?: string | null;
      lastRole?: string | null;
    };
  };

  seatOrderRules?: Array<{
    afterRound?: number;
    policy?: { type?: string; offset?: number; order?: unknown[] };
  }>;

  // legacy (pre-v1 docs) shape (still accepted)
  startRound?: number;
  roles?: string[];
  speakingOrder?: {
    firstRole?: string | null;
    lastRole?: string | null;
  };

  voting?: {
    custom?: {
      // null/undefined means "no explicit limit" (defaults to participantCount)
      minOptions?: number | null;
      maxOptions?: number | null;
    };
    announcement?: {
      announcer?:
        | { type?: "seat"; seat?: number }
        | { type?: "role"; role?: string | null };
      fallback?:
        | { type?: "seat"; seat?: number }
        | { type?: "role"; role?: string | null };
    };
    governance?: {
      tieBreaker?: "revote" | "seat_order";
      maxTieRounds?: number;
      fallbackMode?: string | null;
    };
  };

  consensus?: {
    enabled?: boolean;
    minAvgScore?: number;
    requireAllSeats?: boolean;
  };

  promptPolicies?: {
    round1Fairness?: boolean;
    responseFormat?: {
      requireMarkdown?: boolean;
      forbidRawJson?: boolean;
    };
  };

  deliverables?: {
    allowedPaths?: string[];
    requiredFiles?: Array<{
      path?: string;
      ownerRole?: string | null;
      description?: string | null;
      minChars?: number | null;
      minMarkdownHeadings?: number | null;
      requiredSnippets?: string[];
    }>;
  };
};

export type NormalizedDebateWorkflow = {
  workflowVersion: 1;
  enabled: boolean;
  phaseMachine: {
    phases: Array<{
      id: string;
      title: string;
      kind: "analysis" | "election" | "deliberation" | "finalization";
      description: string | null;
    }>;
    transitionRules: {
      election: {
        startRound: number;
        autoOpen: boolean;
      };
      finalization: {
        enterOnConsensus: boolean;
        enterOnCustomVote: boolean;
        requirePhaseForCompletion: boolean;
      };
    };
  };
  election: {
    startRound: number;
    roles: string[];
    speakingOrder: {
      firstRole: string | null;
      lastRole: string | null;
    };
  };
  seatOrderRules: Array<
    | { afterRound: number; policy: { type: "rotate"; offset: number } }
    | { afterRound: number; policy: { type: "reverse" } }
  >;
  voting: {
    custom: {
      minOptions: number | null;
      maxOptions: number | null;
    };
    announcement: {
      announcer:
        | { type: "seat"; seat: number }
        | { type: "role"; role: string };
      fallback:
        | { type: "seat"; seat: number }
        | { type: "role"; role: string };
    };
    governance: {
      tieBreaker: "revote" | "seat_order";
      maxTieRounds: number;
      fallbackMode: string | null;
    };
  };
  consensus: {
    enabled: boolean;
    minAvgScore: number;
    requireAllSeats: boolean;
  };
  promptPolicies: {
    round1Fairness: boolean;
    responseFormat: {
      requireMarkdown: boolean;
      forbidRawJson: boolean;
    };
  };
  deliverables: {
    allowedPaths: string[];
    requiredFiles: Array<{
      path: string;
      ownerRole: string | null;
      description: string | null;
      minChars: number | null;
      minMarkdownHeadings: number | null;
      requiredSnippets: string[];
    }>;
  };
};

export type NormalizedWorkflowRequiredFile = NormalizedDebateWorkflow["deliverables"]["requiredFiles"][number];

export function formatRequiredDeliverableSummary(
  file: NormalizedWorkflowRequiredFile,
  style: "plain" | "display" = "plain"
) {
  if (style === "display") {
    return [
      file.path,
      file.ownerRole ? `（${file.ownerRole}）` : "",
      file.minChars ? `［至少 ${file.minChars} 字符］` : "",
      file.minMarkdownHeadings ? `［至少 ${file.minMarkdownHeadings} 个标题］` : "",
      file.requiredSnippets.length ? `［包含 ${file.requiredSnippets.join("/")}］` : ""
    ].join("");
  }

  const details: string[] = [];
  if (file.ownerRole) details.push(`owner=${file.ownerRole}`);
  if (file.minChars) details.push(`minChars=${file.minChars}`);
  if (file.minMarkdownHeadings) details.push(`minHeadings=${file.minMarkdownHeadings}`);
  if (file.requiredSnippets.length) details.push(`required=${file.requiredSnippets.join("/")}`);
  const suffix = details.length ? ` ${details.join(" ")}` : "";
  const description = file.description ? ` · ${file.description}` : "";
  return `${file.path}${suffix}${description}`;
}

function toTrimmedString(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function toPositiveInt(value: unknown) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  const i = Math.floor(n);
  return i >= 1 ? i : null;
}

function toPositiveIntOrNull(value: unknown) {
  if (value === null) return null;
  return toPositiveInt(value);
}

function toInt(value: unknown) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.floor(n);
}

function toNonNegativeNumberOrNull(value: unknown) {
  if (value === null) return null;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  return n >= 0 ? n : null;
}

function normalizeWorkflowPathPrefix(value: unknown) {
  const trimmed = toTrimmedString(value);
  if (!trimmed) return null;
  const normalized = trimmed.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.includes("..")) return null;
  return normalized.endsWith("/") ? normalized : `${normalized}/`;
}

function normalizeWorkflowFilePath(value: unknown) {
  const trimmed = toTrimmedString(value);
  if (!trimmed) return null;
  const normalized = trimmed.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.includes("..") || normalized.endsWith("/")) return null;
  return normalized;
}

function normalizeSeatOrRoleSelector(
  value: unknown,
  fallback: { type: "seat"; seat: number }
) {
  const obj = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  const selectorType = toTrimmedString(obj?.type);
  if (selectorType === "role") {
    const role = toTrimmedString(obj?.role);
    if (role) return { type: "role" as const, role };
  }
  return { type: "seat" as const, seat: toPositiveInt(obj?.seat) ?? fallback.seat };
}

function normalizeVoting(value: unknown) {
  if (typeof value !== "object" || value === null) {
    return {
      custom: { minOptions: null as number | null, maxOptions: null as number | null },
      announcement: {
        announcer: { type: "seat" as const, seat: 1 },
        fallback: { type: "seat" as const, seat: 1 }
      },
      governance: {
        tieBreaker: "revote" as const,
        maxTieRounds: 2,
        fallbackMode: "逻辑审核员"
      }
    };
  }
  const obj = value as Record<string, unknown>;
  const customRaw = obj.custom;
  const customObj = typeof customRaw === "object" && customRaw !== null ? (customRaw as Record<string, unknown>) : null;
  const minOptions = toPositiveIntOrNull(customObj?.minOptions);
  const maxOptions = toPositiveIntOrNull(customObj?.maxOptions);

  const announcementRaw = obj.announcement;
  const announcementObj =
    typeof announcementRaw === "object" && announcementRaw !== null ? (announcementRaw as Record<string, unknown>) : null;
  const announcer = normalizeSeatOrRoleSelector(announcementObj?.announcer, { type: "seat", seat: 1 });
  const fallback = normalizeSeatOrRoleSelector(announcementObj?.fallback, { type: "seat", seat: 1 });
  const governanceRaw = obj.governance;
  const governanceObj =
    typeof governanceRaw === "object" && governanceRaw !== null ? (governanceRaw as Record<string, unknown>) : null;
  const tieBreakerRaw = toTrimmedString(governanceObj?.tieBreaker);
  const tieBreaker = tieBreakerRaw === "seat_order" ? "seat_order" : "revote";
  const maxTieRounds = toPositiveInt(governanceObj?.maxTieRounds) ?? 2;
  const fallbackMode = governanceObj?.fallbackMode === null ? null : toTrimmedString(governanceObj?.fallbackMode) ?? "逻辑审核员";
  return {
    custom: { minOptions, maxOptions },
    announcement: { announcer, fallback },
    governance: { tieBreaker, maxTieRounds, fallbackMode }
  };
}

function normalizeConsensus(value: unknown) {
  if (typeof value !== "object" || value === null) {
    return { enabled: true, minAvgScore: 8, requireAllSeats: true };
  }
  const obj = value as Record<string, unknown>;
  const enabledRaw = obj.enabled;
  const enabled = enabledRaw === undefined ? true : Boolean(enabledRaw);
  const minAvgScore = toNonNegativeNumberOrNull(obj.minAvgScore) ?? 8;
  const requireAllSeatsRaw = obj.requireAllSeats;
  const requireAllSeats = requireAllSeatsRaw === undefined ? true : Boolean(requireAllSeatsRaw);
  return { enabled, minAvgScore, requireAllSeats };
}

function normalizeRoles(value: unknown) {
  return Array.isArray(value)
    ? value
        .map((r) => toTrimmedString(r))
        .filter((r): r is string => Boolean(r))
    : [];
}

function normalizePhaseMachine(value: unknown) {
  const obj = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  const rawPhases = Array.isArray(obj?.phases) ? obj?.phases : [];
  const phases = rawPhases
    .map((item) => {
      const phaseObj = typeof item === "object" && item !== null ? (item as Record<string, unknown>) : null;
      const id = toTrimmedString(phaseObj?.id);
      const title = toTrimmedString(phaseObj?.title);
      const kindRaw = toTrimmedString(phaseObj?.kind);
      const kind =
        kindRaw === "analysis" || kindRaw === "election" || kindRaw === "deliberation" || kindRaw === "finalization"
          ? kindRaw
          : null;
      if (!id || !title || !kind) return null;
      return {
        id,
        title,
        kind,
        description: phaseObj?.description === null ? null : toTrimmedString(phaseObj?.description)
      };
    })
    .filter(
      (
        item
      ): item is {
        id: string;
        title: string;
        kind: "analysis" | "election" | "deliberation" | "finalization";
        description: string | null;
      } => Boolean(item)
    );

  const transitionRulesRaw =
    typeof obj?.transitionRules === "object" && obj.transitionRules !== null
      ? (obj.transitionRules as Record<string, unknown>)
      : null;
  const electionTransitionRaw =
    typeof transitionRulesRaw?.election === "object" && transitionRulesRaw.election !== null
      ? (transitionRulesRaw.election as Record<string, unknown>)
      : null;
  const finalizationTransitionRaw =
    typeof transitionRulesRaw?.finalization === "object" && transitionRulesRaw.finalization !== null
      ? (transitionRulesRaw.finalization as Record<string, unknown>)
      : null;

  return {
    phases:
      phases.length > 0
        ? phases
        : [
            {
              id: "phase-1",
              title: "Phase 1 · 议员实战演练",
              kind: "analysis" as const,
              description: "所有席位先独立分析、归类、指出风险，并给出主持人/监管者候选建议。"
            },
            {
              id: "phase-2",
              title: "Phase 2 · 民主选举",
              kind: "election" as const,
              description: "基于前期表现投票选出主持人和监管者，形成明确任命结果。"
            },
            {
              id: "phase-3",
              title: "Phase 3 · 动态轮换讨论",
              kind: "deliberation" as const,
              description: "主持人宣布统一模式，全员围绕创意发散/逻辑审核等模式循环推进。"
            },
            {
              id: "phase-4",
              title: "Phase 4 · 共识收敛与最终交付",
              kind: "finalization" as const,
              description: "进入最终表决与最终产物输出，完成收敛与交付。"
            }
          ],
    transitionRules: {
      election: {
        startRound: toPositiveInt(electionTransitionRaw?.startRound) ?? 1,
        autoOpen: electionTransitionRaw?.autoOpen === undefined ? true : Boolean(electionTransitionRaw.autoOpen)
      },
      finalization: {
        enterOnConsensus:
          finalizationTransitionRaw?.enterOnConsensus === undefined
            ? true
            : Boolean(finalizationTransitionRaw.enterOnConsensus),
        enterOnCustomVote:
          finalizationTransitionRaw?.enterOnCustomVote === undefined
            ? true
            : Boolean(finalizationTransitionRaw.enterOnCustomVote),
        requirePhaseForCompletion:
          finalizationTransitionRaw?.requirePhaseForCompletion === undefined
            ? true
            : Boolean(finalizationTransitionRaw.requirePhaseForCompletion)
      }
    }
  };
}

function normalizeSpeakingOrder(value: unknown) {
  if (typeof value !== "object" || value === null) return { firstRole: null, lastRole: null };
  const obj = value as Record<string, unknown>;
  const firstRole = obj.firstRole === null ? null : toTrimmedString(obj.firstRole);
  const lastRole = obj.lastRole === null ? null : toTrimmedString(obj.lastRole);
  return { firstRole, lastRole };
}

function normalizePromptPolicies(value: unknown) {
  const obj = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  const responseFormatRaw = obj?.responseFormat;
  const responseFormatObj =
    typeof responseFormatRaw === "object" && responseFormatRaw !== null
      ? (responseFormatRaw as Record<string, unknown>)
      : null;
  const round1FairnessRaw = obj?.round1Fairness;
  const requireMarkdownRaw = responseFormatObj?.requireMarkdown;
  const forbidRawJsonRaw = responseFormatObj?.forbidRawJson;
  return {
    round1Fairness: round1FairnessRaw === undefined ? true : Boolean(round1FairnessRaw),
    responseFormat: {
      requireMarkdown: requireMarkdownRaw === undefined ? true : Boolean(requireMarkdownRaw),
      forbidRawJson: forbidRawJsonRaw === undefined ? true : Boolean(forbidRawJsonRaw)
    }
  };
}

function normalizeDeliverables(value: unknown) {
  const obj = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  const rawAllowed = Array.isArray(obj?.allowedPaths) ? obj?.allowedPaths : [];
  const allowedPaths = Array.from(
    new Set(
      rawAllowed
        .map((item) => normalizeWorkflowPathPrefix(item))
        .filter((item): item is string => Boolean(item))
    )
  );

  const rawRequired = Array.isArray(obj?.requiredFiles) ? obj?.requiredFiles : [];
  const requiredFiles = rawRequired
    .map((item) => {
      const fileObj = typeof item === "object" && item !== null ? (item as Record<string, unknown>) : null;
      const path = normalizeWorkflowFilePath(fileObj?.path);
      if (!path) return null;
      return {
        path,
        ownerRole: fileObj?.ownerRole === null ? null : toTrimmedString(fileObj?.ownerRole),
        description: fileObj?.description === null ? null : toTrimmedString(fileObj?.description),
        minChars: toPositiveIntOrNull(fileObj?.minChars),
        minMarkdownHeadings: toPositiveIntOrNull(fileObj?.minMarkdownHeadings),
        requiredSnippets: Array.isArray(fileObj?.requiredSnippets)
          ? fileObj.requiredSnippets
              .map((item) => toTrimmedString(item))
              .filter((item): item is string => Boolean(item))
          : []
      };
    })
    .filter(
      (
        item
      ): item is {
        path: string;
        ownerRole: string | null;
        description: string | null;
        minChars: number | null;
        minMarkdownHeadings: number | null;
        requiredSnippets: string[];
      } => Boolean(item)
    );

  return {
    allowedPaths: allowedPaths.length > 0 ? allowedPaths : ["final/", "outputs/"],
    requiredFiles
  };
}

export function normalizeDebateWorkflow(input: unknown): NormalizedDebateWorkflow | null {
  if (typeof input !== "object" || input === null) return null;
  const anyInput = input as Record<string, unknown>;

  const versionRaw = toPositiveInt((anyInput as { workflowVersion?: unknown }).workflowVersion) ?? 1;
  if (versionRaw !== 1) return null;

  const enabledRaw = (anyInput as { enabled?: unknown }).enabled;
  const enabled = enabledRaw === undefined ? false : Boolean(enabledRaw);
  const phaseMachineRaw = (anyInput as { phaseMachine?: unknown }).phaseMachine;
  const phaseMachine = normalizePhaseMachine(phaseMachineRaw);
  const phaseMachineObj =
    typeof phaseMachineRaw === "object" && phaseMachineRaw !== null ? (phaseMachineRaw as Record<string, unknown>) : null;
  const transitionRulesRaw =
    typeof phaseMachineObj?.transitionRules === "object" && phaseMachineObj.transitionRules !== null
      ? (phaseMachineObj.transitionRules as Record<string, unknown>)
      : null;
  const electionTransitionRaw =
    typeof transitionRulesRaw?.election === "object" && transitionRulesRaw.election !== null
      ? (transitionRulesRaw.election as Record<string, unknown>)
      : null;

  const electionRaw = (anyInput as { election?: unknown }).election;
  const electionObj =
    typeof electionRaw === "object" && electionRaw !== null ? (electionRaw as Record<string, unknown>) : null;

  const legacyStartRound = toPositiveInt((anyInput as { startRound?: unknown }).startRound);
  const legacyRoles = normalizeRoles((anyInput as { roles?: unknown }).roles);
  const legacySpeakingOrder = normalizeSpeakingOrder((anyInput as { speakingOrder?: unknown }).speakingOrder);

  const startRound =
    toPositiveInt(electionObj?.startRound) ?? toPositiveInt(electionTransitionRaw?.startRound) ?? legacyStartRound ?? 1;
  const roles = (() => {
    const fromElection = normalizeRoles(electionObj?.roles);
    return fromElection.length ? fromElection : legacyRoles;
  })();
  const speakingOrder = (() => {
    const fromElection = normalizeSpeakingOrder(electionObj?.speakingOrder);
    const legacyHas = legacySpeakingOrder.firstRole !== null || legacySpeakingOrder.lastRole !== null;
    const electionHas = fromElection.firstRole !== null || fromElection.lastRole !== null;
    return electionHas ? fromElection : legacyHas ? legacySpeakingOrder : { firstRole: null, lastRole: null };
  })();

  const seatOrderRulesRaw = (anyInput as { seatOrderRules?: unknown }).seatOrderRules;
  const seatOrderRulesInput = Array.isArray(seatOrderRulesRaw) ? seatOrderRulesRaw : [];
  const seatOrderRules: NormalizedDebateWorkflow["seatOrderRules"] = [];
  for (const item of seatOrderRulesInput) {
    if (typeof item !== "object" || item === null) continue;
    const obj = item as Record<string, unknown>;
    const afterRound = toPositiveInt(obj.afterRound);
    if (!afterRound) continue;
    const policyRaw = obj.policy;
    if (typeof policyRaw !== "object" || policyRaw === null) continue;
    const policyObj = policyRaw as Record<string, unknown>;
    const type = toTrimmedString(policyObj.type);
    if (type === "rotate") {
      const offset = toInt(policyObj.offset) ?? 1;
      seatOrderRules.push({ afterRound, policy: { type: "rotate", offset } });
      continue;
    }
    if (type === "reverse") {
      seatOrderRules.push({ afterRound, policy: { type: "reverse" } });
      continue;
    }
  }

  // Validation: speakingOrder roles must exist in election.roles when provided.
  const roleSet = new Set(roles);
  if (speakingOrder.firstRole && !roleSet.has(speakingOrder.firstRole)) return null;
  if (speakingOrder.lastRole && !roleSet.has(speakingOrder.lastRole)) return null;

  const voting = normalizeVoting((anyInput as { voting?: unknown }).voting);
  const consensus = normalizeConsensus((anyInput as { consensus?: unknown }).consensus);
  const promptPolicies = normalizePromptPolicies((anyInput as { promptPolicies?: unknown }).promptPolicies);
  const deliverables = normalizeDeliverables((anyInput as { deliverables?: unknown }).deliverables);

  return {
    workflowVersion: 1,
    enabled,
    phaseMachine: {
      ...phaseMachine,
      transitionRules: {
        ...phaseMachine.transitionRules,
        election: {
          ...phaseMachine.transitionRules.election,
          startRound
        }
      }
    },
    election: {
      startRound,
      roles,
      speakingOrder
    },
    seatOrderRules,
    voting,
    consensus,
    promptPolicies,
    deliverables
  };
}

export function safeParseWorkflowJson(raw: string | null): NormalizedDebateWorkflow | null {
  if (!raw) return null;
  try {
    return normalizeDebateWorkflow(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}
