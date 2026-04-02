export type WorkflowPhaseKind = "analysis" | "deliberation" | "finalization_vote" | "finalization";
export type WorkflowContextAccessScope = "shared" | "seat";
export type WorkflowCompletionMode = "consensus_only" | "consensus_plus_outputs" | "workflow_gate";

export type DebateWorkflowContextAccessRule = {
  scope?: WorkflowContextAccessScope;
  pathPrefix?: string;
  label?: string | null;
  maxFiles?: number | null;
  maxCharsPerFile?: number | null;
  recursive?: boolean;
};

export type DebateWorkflowRoleMeta = {
  label?: string | null;
  category?: "coordinator" | "reviewer" | "contributor" | "custom" | null;
  summary?: string | null;
  writingPolicy?: "coordinate" | "review" | "contribute" | null;
};

export type DebateWorkflowQualityChecks = {
  requiredSections?: string[];
  requiredTerms?: string[];
  minBulletItems?: number | null;
  counters?: Array<{
    label?: string | null;
    patterns?: string[];
    minCount?: number | null;
  }>;
};

export type DebateWorkflowSummarizerConfig = {
  enabled?: boolean;
  aiAgentId?: string | null;
  perTurn?: boolean;
  perRound?: boolean;
  factsBoard?: boolean;
  prompts?: {
    turnSummary?: string | null;
    roundSummary?: string | null;
    factsBoard?: string | null;
  };
  outputPaths?: {
    turnSummaryDir?: string | null;
    roundSummaryDir?: string | null;
    factsBoardPath?: string | null;
  };
};

export type DebateWorkflowConfig = {
  workflowVersion?: number;
  enabled?: boolean;
  phaseMachine?: {
    phases?: Array<{
      id?: string;
      title?: string;
      kind?: WorkflowPhaseKind;
      description?: string | null;
      minRounds?: number | null;
      injectedPrompt?: string | null;
    }>;
    transitionRules?: {
      finalization?: {
        autoOpenVote?: boolean;
        requireUnanimousVote?: boolean;
        reopenUntilPassed?: boolean;
        discussionRoundsBetweenVotes?: number;
        requirePhaseForCompletion?: boolean;
      };
    };
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
    openingPrompt?: string | null;
    round1Fairness?: boolean;
    responseFormat?: {
      requireMarkdown?: boolean;
      forbidRawJson?: boolean;
    };
    outputBudget?: {
      discussionMaxTokens?: number | null;
      writingMaxTokens?: number | null;
    };
  };

  deliverables?: {
    allowedPaths?: string[];
    requiredFiles?: Array<{
      path?: string;
      ownerRole?: string | null;
      draftRole?: string | null;
      reviewRole?: string | null;
      finalRole?: string | null;
      description?: string | null;
      minChars?: number | null;
      minMarkdownHeadings?: number | null;
      requiredSnippets?: string[];
      qualityChecks?: DebateWorkflowQualityChecks;
    }>;
  };

  completion?: {
    mode?: WorkflowCompletionMode;
  };

  ideaBank?: {
    rawIdeaBankPath?: string | null;
    derivedFiles?: {
      selectedSTierPath?: string | null;
      selectedATierPath?: string | null;
      rejectedOrMergedPath?: string | null;
      eventMappingsPath?: string | null;
      newlyInventedIdeasPath?: string | null;
    };
  };
  summarizer?: DebateWorkflowSummarizerConfig;
  rolesMeta?: Record<string, DebateWorkflowRoleMeta>;
  contextAccess?: {
    alwaysRead?: DebateWorkflowContextAccessRule[];
    readWhenNeeded?: DebateWorkflowContextAccessRule[];
    unlockAfterPhase?: Array<
      DebateWorkflowContextAccessRule & {
        phaseKind?: WorkflowPhaseKind;
      }
    >;
  };
};

export type NormalizedDebateWorkflow = {
  workflowVersion: 1;
  enabled: boolean;
  phaseMachine: {
    phases: Array<{
      id: string;
      title: string;
      kind: WorkflowPhaseKind;
      description: string | null;
      minRounds: number | null;
      injectedPrompt: string | null;
    }>;
    transitionRules: {
      finalization: {
        autoOpenVote: boolean;
        requireUnanimousVote: boolean;
        reopenUntilPassed: boolean;
        discussionRoundsBetweenVotes: number;
        requirePhaseForCompletion: boolean;
      };
    };
  };
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
    openingPrompt: string | null;
    round1Fairness: boolean;
    responseFormat: {
      requireMarkdown: boolean;
      forbidRawJson: boolean;
    };
    outputBudget: {
      discussionMaxTokens: number | null;
      writingMaxTokens: number | null;
    };
  };
  deliverables: {
    allowedPaths: string[];
    requiredFiles: Array<{
      path: string;
      ownerRole: string | null;
      draftRole: WorkflowDeliverableRole | null;
      reviewRole: WorkflowDeliverableRole | null;
      finalRole: WorkflowDeliverableRole | null;
      description: string | null;
      minChars: number | null;
      minMarkdownHeadings: number | null;
      requiredSnippets: string[];
      qualityChecks: {
        requiredSections: string[];
        requiredTerms: string[];
        minBulletItems: number | null;
        counters: Array<{
          label: string | null;
          patterns: string[];
          minCount: number;
        }>;
      };
    }>;
  };
  completion: {
    mode: WorkflowCompletionMode;
  };
  ideaBank: {
    rawIdeaBankPath: string | null;
    derivedFiles: {
      selectedSTierPath: string | null;
      selectedATierPath: string | null;
      rejectedOrMergedPath: string | null;
      eventMappingsPath: string | null;
      newlyInventedIdeasPath: string | null;
    };
  };
  summarizer: {
    enabled: boolean;
    aiAgentId: string | null;
    perTurn: boolean;
    perRound: boolean;
    factsBoard: boolean;
    prompts: {
      turnSummary: string | null;
      roundSummary: string | null;
      factsBoard: string | null;
    };
    outputPaths: {
      turnSummaryDir: string;
      roundSummaryDir: string;
      factsBoardPath: string;
    };
  };
  rolesMeta: Record<
    string,
    {
      label: string | null;
      category: "coordinator" | "reviewer" | "contributor" | "custom";
      summary: string | null;
      writingPolicy: "coordinate" | "review" | "contribute" | null;
    }
  >;
  contextAccess: {
    alwaysRead: Array<{
      scope: WorkflowContextAccessScope;
      pathPrefix: string;
      label: string | null;
      maxFiles: number;
      maxCharsPerFile: number;
      recursive: boolean;
    }>;
    readWhenNeeded: Array<{
      scope: WorkflowContextAccessScope;
      pathPrefix: string;
      label: string | null;
      maxFiles: number;
      maxCharsPerFile: number;
      recursive: boolean;
    }>;
    unlockAfterPhase: Array<{
      phaseKind: WorkflowPhaseKind;
      scope: WorkflowContextAccessScope;
      pathPrefix: string;
      label: string | null;
      maxFiles: number;
      maxCharsPerFile: number;
      recursive: boolean;
    }>;
  };
};

export type WorkflowDeliverableRole = string;
export type NormalizedWorkflowRequiredFile = NormalizedDebateWorkflow["deliverables"]["requiredFiles"][number];
export type NormalizedWorkflowContextAccessRule = NormalizedDebateWorkflow["contextAccess"]["alwaysRead"][number];
export type NormalizedWorkflowPhaseGateRule = NormalizedDebateWorkflow["contextAccess"]["unlockAfterPhase"][number];

export function createDefaultDebateWorkflowConfig(): DebateWorkflowConfig {
  return {
    workflowVersion: 1,
    enabled: true,
    phaseMachine: {
      phases: [
        {
          id: "deliberation",
          title: "Deliberation",
          kind: "deliberation",
          description: "Debate tradeoffs, improve proposals, and test alternatives against evidence and constraints.",
          minRounds: null,
          injectedPrompt:
            "You are in the deliberation phase. Focus on the strongest few ideas, tradeoffs, and counterarguments. Prefer depth over breadth and keep the writing readable for humans."
        }
      ],
      transitionRules: {
        finalization: {
          autoOpenVote: false,
          requireUnanimousVote: false,
          reopenUntilPassed: false,
          discussionRoundsBetweenVotes: 1,
          requirePhaseForCompletion: false
        }
      }
    },
    voting: {
      custom: { minOptions: 2, maxOptions: null },
      announcement: {
        announcer: { type: "seat", seat: 1 },
        fallback: { type: "seat", seat: 1 }
      },
      governance: {
        tieBreaker: "revote",
        maxTieRounds: 2,
        fallbackMode: "manual_review"
      }
    },
    consensus: { enabled: true, minAvgScore: 8, requireAllSeats: true },
    promptPolicies: {
      openingPrompt:
        "Keep the discussion readable and concrete. State tradeoffs, assumptions, and reasons clearly. Prefer a few strong points over many shallow ones.",
      round1Fairness: true,
      responseFormat: {
        requireMarkdown: true,
        forbidRawJson: true
      },
      outputBudget: {
        discussionMaxTokens: 1200,
        writingMaxTokens: 2400
      }
    },
    deliverables: {
      allowedPaths: ["final/", "outputs/"],
      requiredFiles: []
    },
    completion: {
      mode: "consensus_only"
    },
    ideaBank: {
      rawIdeaBankPath: null,
      derivedFiles: {
        selectedSTierPath: null,
        selectedATierPath: null,
        rejectedOrMergedPath: null,
        eventMappingsPath: null,
        newlyInventedIdeasPath: null
      }
    },
    summarizer: {
      enabled: false,
      aiAgentId: null,
      perTurn: true,
      perRound: true,
      factsBoard: true,
      prompts: {
        turnSummary: null,
        roundSummary: null,
        factsBoard: null
      },
      outputPaths: {
        turnSummaryDir: "debate/turn_summaries/",
        roundSummaryDir: "debate/round_summaries/",
        factsBoardPath: "facts/board.md"
      }
    },
    rolesMeta: {},
    contextAccess: {
      alwaysRead: [],
      readWhenNeeded: [],
      unlockAfterPhase: []
    }
  };
}

export function formatRequiredDeliverableSummary(
  file: NormalizedWorkflowRequiredFile,
  style: "plain" | "display" = "plain"
) {
  const roleSummary = [
    file.draftRole ? `draft:${file.draftRole}` : "",
    file.reviewRole ? `review:${file.reviewRole}` : "",
    file.finalRole ? `final:${file.finalRole}` : ""
  ]
    .filter(Boolean)
    .join(" / ");
  if (style === "display") {
    return [
      file.path,
      roleSummary ? ` (${roleSummary})` : "",
      file.minChars ? ` (min ${file.minChars} chars)` : "",
      file.minMarkdownHeadings ? ` (min ${file.minMarkdownHeadings} headings)` : "",
      file.requiredSnippets.length ? ` (required ${file.requiredSnippets.join("/")})` : "",
      file.qualityChecks.requiredSections.length ? ` (sections ${file.qualityChecks.requiredSections.join("/")})` : "",
      file.qualityChecks.minBulletItems ? ` (min ${file.qualityChecks.minBulletItems} bullets)` : "",
      file.qualityChecks.counters.length
        ? ` (checks ${file.qualityChecks.counters.map((item) => `${item.label ?? "counter"}>=${item.minCount}`).join(", ")})`
        : ""
    ].join("");
  }

  const details: string[] = [];
  if (file.draftRole) details.push(`draft=${file.draftRole}`);
  if (file.reviewRole) details.push(`review=${file.reviewRole}`);
  if (file.finalRole) details.push(`final=${file.finalRole}`);
  if (file.minChars) details.push(`minChars=${file.minChars}`);
  if (file.minMarkdownHeadings) details.push(`minHeadings=${file.minMarkdownHeadings}`);
  if (file.requiredSnippets.length) details.push(`required=${file.requiredSnippets.join("/")}`);
  if (file.qualityChecks.requiredSections.length) details.push(`sections=${file.qualityChecks.requiredSections.join("/")}`);
  if (file.qualityChecks.requiredTerms.length) details.push(`terms=${file.qualityChecks.requiredTerms.join("/")}`);
  if (file.qualityChecks.minBulletItems) details.push(`minBullets=${file.qualityChecks.minBulletItems}`);
  if (file.qualityChecks.counters.length) {
    details.push(
      `checks=${file.qualityChecks.counters.map((item) => `${item.label ?? "counter"}>=${item.minCount}`).join(",")}`
    );
  }
  const suffix = details.length ? ` ${details.join(" ")}` : "";
  const description = file.description ? ` :: ${file.description}` : "";
  return `${file.path}${suffix}${description}`;
}

function toTrimmedString(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeWorkflowDeliverableRole(value: unknown): WorkflowDeliverableRole | null {
  const trimmed = toTrimmedString(value);
  return trimmed ?? null;
}

function resolveRequiredFileRoles(input: {
  ownerRole: string | null;
  draftRole: WorkflowDeliverableRole | null;
  reviewRole: WorkflowDeliverableRole | null;
  finalRole: WorkflowDeliverableRole | null;
}) {
  if (input.draftRole || input.reviewRole || input.finalRole) {
    return {
      draftRole: input.draftRole,
      reviewRole: input.reviewRole,
      finalRole: input.finalRole
    };
  }
  const normalizedOwner = normalizeWorkflowDeliverableRole(input.ownerRole);
  if (!normalizedOwner) {
    return {
      draftRole: null,
      reviewRole: null,
      finalRole: null
    };
  }
  return {
    draftRole: normalizedOwner,
    reviewRole: null,
    finalRole: normalizedOwner
  };
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

function normalizeVoting(value: unknown): NormalizedDebateWorkflow["voting"] {
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
        fallbackMode: "manual_review"
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
  const fallbackMode = governanceObj?.fallbackMode === null ? null : toTrimmedString(governanceObj?.fallbackMode) ?? "manual_review";
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

function normalizeQualityChecks(
  value: unknown,
  fallback?: { requiredTerms?: string[] | null }
): {
  requiredSections: string[];
  requiredTerms: string[];
  minBulletItems: number | null;
  counters: Array<{
    label: string | null;
    patterns: string[];
    minCount: number;
  }>;
} {
  const obj = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  const requiredSections = Array.isArray(obj?.requiredSections)
    ? obj.requiredSections.map((item) => toTrimmedString(item)).filter((item): item is string => Boolean(item))
    : [];
  const explicitRequiredTerms = Array.isArray(obj?.requiredTerms)
    ? obj.requiredTerms.map((item) => toTrimmedString(item)).filter((item): item is string => Boolean(item))
    : [];
  const fallbackTerms = (fallback?.requiredTerms ?? []).filter((item): item is string => Boolean(item));
  const requiredTerms = explicitRequiredTerms.length > 0 ? explicitRequiredTerms : fallbackTerms;
  const rawCounters = Array.isArray(obj?.counters) ? obj.counters : [];
  const counters = rawCounters
    .map((item) => {
      const counterObj = typeof item === "object" && item !== null ? (item as Record<string, unknown>) : null;
      const patterns = Array.isArray(counterObj?.patterns)
        ? counterObj.patterns.map((pattern) => toTrimmedString(pattern)).filter((pattern): pattern is string => Boolean(pattern))
        : [];
      const minCount = toPositiveInt(counterObj?.minCount);
      if (patterns.length <= 0 || !minCount) return null;
      return {
        label: counterObj?.label === null ? null : toTrimmedString(counterObj?.label),
        patterns,
        minCount
      };
    })
    .filter(
      (
        item
      ): item is {
        label: string | null;
        patterns: string[];
        minCount: number;
      } => Boolean(item)
    );
  return {
    requiredSections,
    requiredTerms,
    minBulletItems: toPositiveIntOrNull(obj?.minBulletItems),
    counters
  };
}

function normalizeCompletion(
  value: unknown,
  context: Pick<NormalizedDebateWorkflow, "deliverables" | "phaseMachine">
): NormalizedDebateWorkflow["completion"] {
  const obj = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  const modeRaw = toTrimmedString(obj?.mode);
  const mode =
    modeRaw === "consensus_plus_outputs" || modeRaw === "workflow_gate" || modeRaw === "consensus_only"
      ? modeRaw
      : context.phaseMachine.transitionRules.finalization.requirePhaseForCompletion ||
          context.phaseMachine.phases.some((phase) => phase.kind === "finalization" || phase.kind === "finalization_vote")
        ? "workflow_gate"
        : context.deliverables.requiredFiles.length > 0
          ? "consensus_plus_outputs"
          : "consensus_only";
  return { mode };
}

function normalizeDirectoryPath(value: unknown, fallback: string) {
  const trimmed = toTrimmedString(value);
  if (!trimmed) return fallback;
  const normalized = trimmed.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized) return fallback;
  return normalized.endsWith("/") ? normalized : `${normalized}/`;
}

function normalizeFilePath(value: unknown, fallback: string) {
  const trimmed = toTrimmedString(value);
  if (!trimmed) return fallback;
  const normalized = trimmed.replace(/\\/g, "/").replace(/^\/+/, "");
  return normalized || fallback;
}

function normalizeSummarizer(value: unknown): NormalizedDebateWorkflow["summarizer"] {
  const defaults = createDefaultDebateWorkflowConfig().summarizer!;
  const obj = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  const prompts = typeof obj?.prompts === "object" && obj.prompts !== null ? (obj.prompts as Record<string, unknown>) : null;
  const outputPaths =
    typeof obj?.outputPaths === "object" && obj.outputPaths !== null
      ? (obj.outputPaths as Record<string, unknown>)
      : null;
  return {
    enabled: Boolean(obj?.enabled),
    aiAgentId: obj?.aiAgentId === null ? null : toTrimmedString(obj?.aiAgentId),
    perTurn: obj?.perTurn === undefined ? defaults.perTurn ?? true : Boolean(obj?.perTurn),
    perRound: obj?.perRound === undefined ? defaults.perRound ?? true : Boolean(obj?.perRound),
    factsBoard: obj?.factsBoard === undefined ? defaults.factsBoard ?? true : Boolean(obj?.factsBoard),
    prompts: {
      turnSummary: prompts?.turnSummary === null ? null : toTrimmedString(prompts?.turnSummary),
      roundSummary: prompts?.roundSummary === null ? null : toTrimmedString(prompts?.roundSummary),
      factsBoard: prompts?.factsBoard === null ? null : toTrimmedString(prompts?.factsBoard)
    },
    outputPaths: {
      turnSummaryDir: normalizeDirectoryPath(outputPaths?.turnSummaryDir, defaults.outputPaths?.turnSummaryDir ?? "debate/turn_summaries/"),
      roundSummaryDir: normalizeDirectoryPath(outputPaths?.roundSummaryDir, defaults.outputPaths?.roundSummaryDir ?? "debate/round_summaries/"),
      factsBoardPath: normalizeFilePath(outputPaths?.factsBoardPath, defaults.outputPaths?.factsBoardPath ?? "facts/board.md")
    }
  };
}

function normalizeRolesMeta(value: unknown): NormalizedDebateWorkflow["rolesMeta"] {
  if (typeof value !== "object" || value === null) return {};
  const obj = value as Record<string, unknown>;
  const entries = Object.entries(obj)
    .map(([role, raw]) => {
      const trimmedRole = toTrimmedString(role);
      if (!trimmedRole || typeof raw !== "object" || raw === null) return null;
      const meta = raw as Record<string, unknown>;
      const categoryRaw = toTrimmedString(meta.category);
      const category =
        categoryRaw === "coordinator" || categoryRaw === "reviewer" || categoryRaw === "contributor"
          ? categoryRaw
          : "custom";
      const writingPolicyRaw = toTrimmedString(meta.writingPolicy);
      const writingPolicy =
        writingPolicyRaw === "coordinate" || writingPolicyRaw === "review" || writingPolicyRaw === "contribute"
          ? writingPolicyRaw
          : null;
      return [
        trimmedRole,
        {
          label: meta.label === null ? null : toTrimmedString(meta.label),
          category,
          summary: meta.summary === null ? null : toTrimmedString(meta.summary),
          writingPolicy
        }
      ] as const;
    })
    .filter((item): item is readonly [
      string,
      {
        label: string | null;
        category: "coordinator" | "reviewer" | "contributor" | "custom";
        summary: string | null;
        writingPolicy: "coordinate" | "review" | "contribute" | null;
      }
    ] => Boolean(item));
  return Object.fromEntries(entries);
}

function normalizeRoles(value: unknown) {
  return Array.isArray(value)
    ? value
        .map((r) => toTrimmedString(r))
        .filter((r): r is string => Boolean(r))
    : [];
}

function normalizePhaseIdentifier(kind: string, id: string, title: string) {
  return id;
}

function normalizePhaseTitle(kind: string, title: string) {
  return title;
}

function normalizePhaseDescription(kind: string, description: string | null) {
  return description;
}

function normalizePhaseInjectedPrompt(kind: string, injectedPrompt: string | null) {
  return injectedPrompt;
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
        kindRaw === "analysis" ||
        kindRaw === "deliberation" ||
        kindRaw === "finalization_vote" ||
        kindRaw === "finalization"
          ? kindRaw
          : null;
      if (!id || !title || !kind) return null;
      const normalizedDescription = normalizePhaseDescription(
        kind,
        phaseObj?.description === null ? null : toTrimmedString(phaseObj?.description)
      );
      const normalizedInjectedPrompt = normalizePhaseInjectedPrompt(
        kind,
        phaseObj?.injectedPrompt === null ? null : toTrimmedString(phaseObj?.injectedPrompt)
      );
      return {
        id: normalizePhaseIdentifier(kind, id, title),
        title: normalizePhaseTitle(kind, title),
        kind,
        description: normalizedDescription,
        minRounds: toPositiveIntOrNull(phaseObj?.minRounds),
        injectedPrompt: normalizedInjectedPrompt
      };
    })
    .filter(
      (
        item
      ): item is {
        id: string;
        title: string;
        kind: "analysis" | "deliberation" | "finalization_vote" | "finalization";
        description: string | null;
        minRounds: number | null;
        injectedPrompt: string | null;
      } => Boolean(item)
    );

  const transitionRulesRaw =
    typeof obj?.transitionRules === "object" && obj.transitionRules !== null
      ? (obj.transitionRules as Record<string, unknown>)
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
              id: "deliberation",
              title: "Deliberation",
              kind: "deliberation" as const,
              description: "Debate alternatives, challenge assumptions, and converge on stronger options.",
              minRounds: null,
              injectedPrompt: null
            }
          ],
    transitionRules: {
      finalization: {
        autoOpenVote:
          finalizationTransitionRaw?.autoOpenVote === undefined
            ? false
            : Boolean(finalizationTransitionRaw.autoOpenVote),
        requireUnanimousVote:
          finalizationTransitionRaw?.requireUnanimousVote === undefined
            ? false
            : Boolean(finalizationTransitionRaw.requireUnanimousVote),
        reopenUntilPassed:
          finalizationTransitionRaw?.reopenUntilPassed === undefined
            ? false
            : Boolean(finalizationTransitionRaw.reopenUntilPassed),
        discussionRoundsBetweenVotes: toPositiveInt(finalizationTransitionRaw?.discussionRoundsBetweenVotes) ?? 1,
        requirePhaseForCompletion:
          finalizationTransitionRaw?.requirePhaseForCompletion === undefined
            ? false
            : Boolean(finalizationTransitionRaw.requirePhaseForCompletion)
      }
    }
  };
}

function normalizePromptPolicies(value: unknown) {
  const obj = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  const responseFormatRaw = obj?.responseFormat;
  const responseFormatObj =
    typeof responseFormatRaw === "object" && responseFormatRaw !== null
      ? (responseFormatRaw as Record<string, unknown>)
      : null;
  const outputBudgetRaw = obj?.outputBudget;
  const outputBudgetObj =
    typeof outputBudgetRaw === "object" && outputBudgetRaw !== null
      ? (outputBudgetRaw as Record<string, unknown>)
      : null;
  const round1FairnessRaw = obj?.round1Fairness;
  const openingPromptRaw = obj?.openingPrompt;
  const requireMarkdownRaw = responseFormatObj?.requireMarkdown;
  const forbidRawJsonRaw = responseFormatObj?.forbidRawJson;
  const discussionMaxTokensRaw = outputBudgetObj?.discussionMaxTokens;
  const writingMaxTokensRaw = outputBudgetObj?.writingMaxTokens;
  return {
    openingPrompt: openingPromptRaw === null ? null : toTrimmedString(openingPromptRaw),
    round1Fairness: round1FairnessRaw === undefined ? true : Boolean(round1FairnessRaw),
    responseFormat: {
      requireMarkdown: requireMarkdownRaw === undefined ? true : Boolean(requireMarkdownRaw),
      forbidRawJson: forbidRawJsonRaw === undefined ? true : Boolean(forbidRawJsonRaw)
    },
    outputBudget: {
      discussionMaxTokens:
        discussionMaxTokensRaw === null ? null : (toPositiveInt(discussionMaxTokensRaw) ?? 1800),
      writingMaxTokens:
        writingMaxTokensRaw === null ? null : (toPositiveInt(writingMaxTokensRaw) ?? 3600)
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
      const ownerRole = fileObj?.ownerRole === null ? null : toTrimmedString(fileObj?.ownerRole);
      const resolvedRoles = resolveRequiredFileRoles({
        ownerRole,
        draftRole: normalizeWorkflowDeliverableRole(fileObj?.draftRole),
        reviewRole: normalizeWorkflowDeliverableRole(fileObj?.reviewRole),
        finalRole: normalizeWorkflowDeliverableRole(fileObj?.finalRole)
      });
      const requiredSnippets = Array.isArray(fileObj?.requiredSnippets)
        ? fileObj.requiredSnippets
            .map((item) => toTrimmedString(item))
            .filter((item): item is string => Boolean(item))
        : [];
      const qualityChecks = normalizeQualityChecks(fileObj?.qualityChecks, {
        requiredTerms: requiredSnippets
      });
      return {
        path,
        ownerRole,
        draftRole: resolvedRoles.draftRole,
        reviewRole: resolvedRoles.reviewRole,
        finalRole: resolvedRoles.finalRole,
        description: fileObj?.description === null ? null : toTrimmedString(fileObj?.description),
        minChars: toPositiveIntOrNull(fileObj?.minChars),
        minMarkdownHeadings: toPositiveIntOrNull(fileObj?.minMarkdownHeadings),
        requiredSnippets,
        qualityChecks
      };
    })
    .filter(
      (
        item
      ): item is {
        path: string;
        ownerRole: string | null;
        draftRole: WorkflowDeliverableRole | null;
        reviewRole: WorkflowDeliverableRole | null;
        finalRole: WorkflowDeliverableRole | null;
        description: string | null;
        minChars: number | null;
        minMarkdownHeadings: number | null;
        requiredSnippets: string[];
        qualityChecks: {
          requiredSections: string[];
          requiredTerms: string[];
          minBulletItems: number | null;
          counters: Array<{
            label: string | null;
            patterns: string[];
            minCount: number;
          }>;
        };
      } => Boolean(item)
    );

  return {
    allowedPaths: allowedPaths.length > 0 ? allowedPaths : ["final/", "outputs/"],
    requiredFiles
  };
}

function normalizeIdeaBank(value: unknown) {
  const obj = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  const derivedRaw = typeof obj?.derivedFiles === "object" && obj.derivedFiles !== null ? (obj.derivedFiles as Record<string, unknown>) : null;
  return {
    rawIdeaBankPath: obj?.rawIdeaBankPath === null ? null : normalizeWorkflowFilePath(obj?.rawIdeaBankPath),
    derivedFiles: {
      selectedSTierPath: derivedRaw?.selectedSTierPath === null ? null : normalizeWorkflowFilePath(derivedRaw?.selectedSTierPath),
      selectedATierPath: derivedRaw?.selectedATierPath === null ? null : normalizeWorkflowFilePath(derivedRaw?.selectedATierPath),
      rejectedOrMergedPath: derivedRaw?.rejectedOrMergedPath === null ? null : normalizeWorkflowFilePath(derivedRaw?.rejectedOrMergedPath),
      eventMappingsPath: derivedRaw?.eventMappingsPath === null ? null : normalizeWorkflowFilePath(derivedRaw?.eventMappingsPath),
      newlyInventedIdeasPath:
        derivedRaw?.newlyInventedIdeasPath === null ? null : normalizeWorkflowFilePath(derivedRaw?.newlyInventedIdeasPath)
    }
  };
}

function normalizeContextAccessScope(value: unknown): WorkflowContextAccessScope | null {
  return value === "shared" || value === "seat" ? value : null;
}

function normalizeContextAccessRule(
  value: unknown
): {
  scope: WorkflowContextAccessScope;
  pathPrefix: string;
  label: string | null;
  maxFiles: number;
  maxCharsPerFile: number;
  recursive: boolean;
} | null {
  const obj = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  const scope = normalizeContextAccessScope(obj?.scope);
  const pathPrefix = normalizeWorkflowPathPrefix(obj?.pathPrefix);
  if (!scope || !pathPrefix) return null;
  return {
    scope,
    pathPrefix,
    label: obj?.label === null ? null : toTrimmedString(obj?.label),
    maxFiles: toPositiveInt(obj?.maxFiles) ?? 6,
    maxCharsPerFile: toPositiveInt(obj?.maxCharsPerFile) ?? 4_000,
    recursive: obj?.recursive === undefined ? true : Boolean(obj?.recursive)
  };
}

function normalizeContextAccess(value: unknown): NormalizedDebateWorkflow["contextAccess"] {
  const obj = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  const alwaysRead = Array.isArray(obj?.alwaysRead)
    ? obj.alwaysRead
        .map((item) => normalizeContextAccessRule(item))
        .filter((item): item is NormalizedWorkflowContextAccessRule => Boolean(item))
    : [];
  const readWhenNeeded = Array.isArray(obj?.readWhenNeeded)
    ? obj.readWhenNeeded
        .map((item) => normalizeContextAccessRule(item))
        .filter((item): item is NormalizedWorkflowContextAccessRule => Boolean(item))
    : [];
  const unlockAfterPhase = Array.isArray(obj?.unlockAfterPhase)
    ? obj.unlockAfterPhase
        .map((item) => {
          const rule = normalizeContextAccessRule(item);
          const phaseKind =
            typeof item === "object" && item !== null
              ? ((item as { phaseKind?: unknown }).phaseKind as WorkflowPhaseKind | undefined)
              : undefined;
          if (!rule || !phaseKind) return null;
          if (!["analysis", "deliberation", "finalization_vote", "finalization"].includes(phaseKind)) return null;
          return { ...rule, phaseKind };
        })
        .filter((item): item is NormalizedWorkflowPhaseGateRule => Boolean(item))
    : [];

  const seen = new Set<string>();
  const register = (scope: WorkflowContextAccessScope, pathPrefix: string) => {
    const key = `${scope}:${pathPrefix.toLowerCase()}`;
    if (seen.has(key)) {
      throw new Error(`Duplicate contextAccess rule for ${key}`);
    }
    seen.add(key);
  };
  for (const rule of alwaysRead) register(rule.scope, rule.pathPrefix);
  for (const rule of readWhenNeeded) register(rule.scope, rule.pathPrefix);
  for (const rule of unlockAfterPhase) register(rule.scope, rule.pathPrefix);

  return { alwaysRead, readWhenNeeded, unlockAfterPhase };
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
  const voting = normalizeVoting((anyInput as { voting?: unknown }).voting);
  const consensus = normalizeConsensus((anyInput as { consensus?: unknown }).consensus);
  const promptPolicies = normalizePromptPolicies((anyInput as { promptPolicies?: unknown }).promptPolicies);
  const deliverables = normalizeDeliverables((anyInput as { deliverables?: unknown }).deliverables);
  const completion = normalizeCompletion((anyInput as { completion?: unknown }).completion, {
    deliverables,
    phaseMachine
  });
  const ideaBank = normalizeIdeaBank((anyInput as { ideaBank?: unknown }).ideaBank);
  const summarizer = normalizeSummarizer((anyInput as { summarizer?: unknown }).summarizer);
  const rolesMeta = normalizeRolesMeta((anyInput as { rolesMeta?: unknown }).rolesMeta);
  let contextAccess: NormalizedDebateWorkflow["contextAccess"];
  try {
    contextAccess = normalizeContextAccess((anyInput as { contextAccess?: unknown }).contextAccess);
  } catch {
    return null;
  }

  return {
    workflowVersion: 1,
    enabled,
    phaseMachine,
    voting,
    consensus,
    promptPolicies,
    deliverables,
    completion,
    ideaBank,
    summarizer,
    rolesMeta,
    contextAccess
  };
}

export function toCanonicalWorkflowConfig(input: unknown): DebateWorkflowConfig | null {
  const normalized = normalizeDebateWorkflow(input);
  if (!normalized) return null;
  const canonical: DebateWorkflowConfig = {
    workflowVersion: normalized.workflowVersion,
    enabled: normalized.enabled,
    phaseMachine: {
      phases: normalized.phaseMachine.phases.map((phase) => ({
        id: phase.id,
        title: phase.title,
        kind: phase.kind,
        description: phase.description,
        minRounds: phase.minRounds,
        injectedPrompt: phase.injectedPrompt
      })),
      transitionRules: {
        finalization: {
          autoOpenVote: normalized.phaseMachine.transitionRules.finalization.autoOpenVote,
          requireUnanimousVote: normalized.phaseMachine.transitionRules.finalization.requireUnanimousVote,
          reopenUntilPassed: normalized.phaseMachine.transitionRules.finalization.reopenUntilPassed,
          discussionRoundsBetweenVotes: normalized.phaseMachine.transitionRules.finalization.discussionRoundsBetweenVotes,
          requirePhaseForCompletion: normalized.phaseMachine.transitionRules.finalization.requirePhaseForCompletion
        }
      }
    },
    voting: {
      custom: {
        minOptions: normalized.voting.custom.minOptions,
        maxOptions: normalized.voting.custom.maxOptions
      },
      announcement: {
        announcer: normalized.voting.announcement.announcer,
        fallback: normalized.voting.announcement.fallback
      },
      governance: {
        tieBreaker: normalized.voting.governance.tieBreaker as "revote" | "seat_order",
        maxTieRounds: normalized.voting.governance.maxTieRounds,
        fallbackMode: normalized.voting.governance.fallbackMode
      }
    },
    consensus: {
      enabled: normalized.consensus.enabled,
      minAvgScore: normalized.consensus.minAvgScore,
      requireAllSeats: normalized.consensus.requireAllSeats
    },
    promptPolicies: {
      openingPrompt: normalized.promptPolicies.openingPrompt,
      round1Fairness: normalized.promptPolicies.round1Fairness,
      responseFormat: {
        requireMarkdown: normalized.promptPolicies.responseFormat.requireMarkdown,
        forbidRawJson: normalized.promptPolicies.responseFormat.forbidRawJson
      },
      outputBudget: {
        discussionMaxTokens: normalized.promptPolicies.outputBudget.discussionMaxTokens,
        writingMaxTokens: normalized.promptPolicies.outputBudget.writingMaxTokens
      }
    },
    deliverables: {
      allowedPaths: normalized.deliverables.allowedPaths,
      requiredFiles: normalized.deliverables.requiredFiles.map((file) => ({
        path: file.path,
        ownerRole: file.ownerRole,
        draftRole: file.draftRole,
        reviewRole: file.reviewRole,
        finalRole: file.finalRole,
        description: file.description,
        minChars: file.minChars,
        minMarkdownHeadings: file.minMarkdownHeadings,
        requiredSnippets: file.requiredSnippets,
        qualityChecks: {
          requiredSections: file.qualityChecks.requiredSections,
          requiredTerms: file.qualityChecks.requiredTerms,
          minBulletItems: file.qualityChecks.minBulletItems,
          counters: file.qualityChecks.counters.map((item) => ({
            label: item.label,
            patterns: item.patterns,
            minCount: item.minCount
          }))
        }
      }))
    },
    completion: {
      mode: normalized.completion.mode
    },
    ideaBank: {
      rawIdeaBankPath: normalized.ideaBank.rawIdeaBankPath,
      derivedFiles: normalized.ideaBank.derivedFiles
    },
    summarizer: {
      enabled: normalized.summarizer.enabled,
      aiAgentId: normalized.summarizer.aiAgentId,
      perTurn: normalized.summarizer.perTurn,
      perRound: normalized.summarizer.perRound,
      factsBoard: normalized.summarizer.factsBoard,
      prompts: {
        turnSummary: normalized.summarizer.prompts.turnSummary,
        roundSummary: normalized.summarizer.prompts.roundSummary,
        factsBoard: normalized.summarizer.prompts.factsBoard
      },
      outputPaths: {
        turnSummaryDir: normalized.summarizer.outputPaths.turnSummaryDir,
        roundSummaryDir: normalized.summarizer.outputPaths.roundSummaryDir,
        factsBoardPath: normalized.summarizer.outputPaths.factsBoardPath
      }
    },
    rolesMeta: Object.fromEntries(
      Object.entries(normalized.rolesMeta).map(([role, meta]) => [
        role,
        {
          label: meta.label,
          category: meta.category === "custom" ? null : meta.category,
          summary: meta.summary,
          writingPolicy: meta.writingPolicy
        }
      ])
    ),
    contextAccess: {
      alwaysRead: normalized.contextAccess.alwaysRead.map((rule) => ({
        scope: rule.scope,
        pathPrefix: rule.pathPrefix,
        label: rule.label,
        maxFiles: rule.maxFiles,
        maxCharsPerFile: rule.maxCharsPerFile,
        recursive: rule.recursive
      })),
      readWhenNeeded: normalized.contextAccess.readWhenNeeded.map((rule) => ({
        scope: rule.scope,
        pathPrefix: rule.pathPrefix,
        label: rule.label,
        maxFiles: rule.maxFiles,
        maxCharsPerFile: rule.maxCharsPerFile,
        recursive: rule.recursive
      })),
      unlockAfterPhase: normalized.contextAccess.unlockAfterPhase.map((rule) => ({
        phaseKind: rule.phaseKind,
        scope: rule.scope,
        pathPrefix: rule.pathPrefix,
        label: rule.label,
        maxFiles: rule.maxFiles,
        maxCharsPerFile: rule.maxCharsPerFile,
        recursive: rule.recursive
      }))
    }
  };
  return canonical;
}

export function safeParseWorkflowJson(raw: string | null): NormalizedDebateWorkflow | null {
  if (!raw) return null;
  try {
    return normalizeDebateWorkflow(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}
