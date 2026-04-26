export type WorkflowPhaseKind = "analysis" | "deliberation" | "finalization_vote" | "finalization";
export type WorkflowContextAccessScope = "shared" | "seat";
export type WorkflowContextAccessTargetType = "file" | "dir";
export type WorkflowCompletionMode = "consensus_only" | "consensus_plus_outputs" | "workflow_gate";

export type DebateWorkflowContextAccessRule = {
  scope?: WorkflowContextAccessScope;
  targetType?: WorkflowContextAccessTargetType;
  pathPrefix?: string;
  maxFiles?: number | null;
  maxCharsPerFile?: number | null;
  recursive?: boolean;
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
    governance?: {
      tieBreaker?: "revote" | "seat_order";
      maxTieRounds?: number;
    };
  };

  consensus?: {
    enabled?: boolean;
    minAvgScore?: number;
    requireAllSeats?: boolean;
  };

  promptPolicies?: {
    outputBudget?: {
      discussionMaxTokens?: number | null;
      writingMaxTokens?: number | null;
    };
  };

  deliverables?: {
    allowedPaths?: string[];
    requiredFiles?: Array<{
      path?: string;
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
      currentBattlefieldPath?: string | null;
      selectedSTierPath?: string | null;
      selectedATierPath?: string | null;
      rejectedOrMergedPath?: string | null;
      eventMappingsPath?: string | null;
      newlyInventedIdeasPath?: string | null;
    };
  };
  summarizer?: DebateWorkflowSummarizerConfig;
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
    governance: {
      tieBreaker: "revote" | "seat_order";
      maxTieRounds: number;
    };
  };
  consensus: {
    enabled: boolean;
    minAvgScore: number;
    requireAllSeats: boolean;
  };
  promptPolicies: {
    outputBudget: {
      discussionMaxTokens: number | null;
      writingMaxTokens: number | null;
    };
  };
  deliverables: {
    allowedPaths: string[];
    requiredFiles: Array<{
      path: string;
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
      currentBattlefieldPath: string | null;
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
  contextAccess: {
    alwaysRead: Array<{
      scope: WorkflowContextAccessScope;
      targetType: WorkflowContextAccessTargetType;
      pathPrefix: string;
      maxFiles: number;
      maxCharsPerFile: number;
      recursive: boolean;
    }>;
    readWhenNeeded: Array<{
      scope: WorkflowContextAccessScope;
      targetType: WorkflowContextAccessTargetType;
      pathPrefix: string;
      maxFiles: number;
      maxCharsPerFile: number;
      recursive: boolean;
    }>;
    unlockAfterPhase: Array<{
      phaseKind: WorkflowPhaseKind;
      scope: WorkflowContextAccessScope;
      targetType: WorkflowContextAccessTargetType;
      pathPrefix: string;
      maxFiles: number;
      maxCharsPerFile: number;
      recursive: boolean;
    }>;
  };
};

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
      governance: {
        tieBreaker: "revote",
        maxTieRounds: 2
      }
    },
    consensus: { enabled: true, minAvgScore: 8, requireAllSeats: true },
    promptPolicies: {
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
        currentBattlefieldPath: null,
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
  if (style === "display") {
    return [
      file.path,
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
  return `${file.path}${suffix}`;
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

function normalizeContextAccessPath(value: unknown, targetType: WorkflowContextAccessTargetType | null) {
  if (targetType === "file") return normalizeWorkflowFilePath(value);
  return normalizeWorkflowPathPrefix(value);
}

function normalizeVoting(value: unknown): NormalizedDebateWorkflow["voting"] {
  if (typeof value !== "object" || value === null) {
    return {
      governance: {
        tieBreaker: "revote" as const,
        maxTieRounds: 2
      }
    };
  }
  const obj = value as Record<string, unknown>;
  const governanceRaw = obj.governance;
  const governanceObj =
    typeof governanceRaw === "object" && governanceRaw !== null ? (governanceRaw as Record<string, unknown>) : null;
  const tieBreakerRaw = toTrimmedString(governanceObj?.tieBreaker);
  const tieBreaker = tieBreakerRaw === "seat_order" ? "seat_order" : "revote";
  const maxTieRounds = toPositiveInt(governanceObj?.maxTieRounds) ?? 2;
  return {
    governance: { tieBreaker, maxTieRounds }
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
  const outputBudgetRaw = obj?.outputBudget;
  const outputBudgetObj =
    typeof outputBudgetRaw === "object" && outputBudgetRaw !== null
      ? (outputBudgetRaw as Record<string, unknown>)
      : null;
  const discussionMaxTokensRaw = outputBudgetObj?.discussionMaxTokens;
  const writingMaxTokensRaw = outputBudgetObj?.writingMaxTokens;
  return {
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
      currentBattlefieldPath:
        derivedRaw?.currentBattlefieldPath === null ? null : normalizeWorkflowFilePath(derivedRaw?.currentBattlefieldPath),
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

function normalizeContextAccessTargetType(value: unknown): WorkflowContextAccessTargetType {
  return value === "file" ? "file" : "dir";
}

function normalizeContextAccessRule(
  value: unknown
): {
  scope: WorkflowContextAccessScope;
  targetType: WorkflowContextAccessTargetType;
  pathPrefix: string;
  maxFiles: number;
  maxCharsPerFile: number;
  recursive: boolean;
} | null {
  const obj = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  const scope = normalizeContextAccessScope(obj?.scope);
  const targetType = normalizeContextAccessTargetType(obj?.targetType);
  const pathPrefix = normalizeContextAccessPath(obj?.pathPrefix, targetType);
  if (!scope || !pathPrefix) return null;
  const defaultMaxFiles = targetType === "file" ? 1 : 6;
  const defaultMaxCharsPerFile = targetType === "file" ? 8_000 : 4_000;
  return {
    scope,
    targetType,
    pathPrefix,
    maxFiles: toPositiveInt(obj?.maxFiles) ?? defaultMaxFiles,
    maxCharsPerFile: toPositiveInt(obj?.maxCharsPerFile) ?? defaultMaxCharsPerFile,
    recursive: targetType === "file" ? false : obj?.recursive === undefined ? true : Boolean(obj?.recursive)
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
  const register = (scope: WorkflowContextAccessScope, targetType: WorkflowContextAccessTargetType, pathPrefix: string) => {
    const key = `${scope}:${targetType}:${pathPrefix.toLowerCase()}`;
    if (seen.has(key)) {
      throw new Error(`Duplicate contextAccess rule for ${key}`);
    }
    seen.add(key);
  };
  for (const rule of alwaysRead) register(rule.scope, rule.targetType, rule.pathPrefix);
  for (const rule of readWhenNeeded) register(rule.scope, rule.targetType, rule.pathPrefix);
  for (const rule of unlockAfterPhase) register(rule.scope, rule.targetType, rule.pathPrefix);

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
      governance: {
        tieBreaker: normalized.voting.governance.tieBreaker as "revote" | "seat_order",
        maxTieRounds: normalized.voting.governance.maxTieRounds
      }
    },
    consensus: {
      enabled: normalized.consensus.enabled,
      minAvgScore: normalized.consensus.minAvgScore,
      requireAllSeats: normalized.consensus.requireAllSeats
    },
    promptPolicies: {
      outputBudget: {
        discussionMaxTokens: normalized.promptPolicies.outputBudget.discussionMaxTokens,
        writingMaxTokens: normalized.promptPolicies.outputBudget.writingMaxTokens
      }
    },
    deliverables: {
      allowedPaths: normalized.deliverables.allowedPaths,
      requiredFiles: normalized.deliverables.requiredFiles.map((file) => ({
        path: file.path,
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
    contextAccess: {
      alwaysRead: normalized.contextAccess.alwaysRead.map((rule) => ({
        scope: rule.scope,
        targetType: rule.targetType,
        pathPrefix: rule.pathPrefix,
        maxFiles: rule.maxFiles,
        maxCharsPerFile: rule.maxCharsPerFile,
        recursive: rule.recursive
      })),
      readWhenNeeded: normalized.contextAccess.readWhenNeeded.map((rule) => ({
        scope: rule.scope,
        targetType: rule.targetType,
        pathPrefix: rule.pathPrefix,
        maxFiles: rule.maxFiles,
        maxCharsPerFile: rule.maxCharsPerFile,
        recursive: rule.recursive
      })),
      unlockAfterPhase: normalized.contextAccess.unlockAfterPhase.map((rule) => ({
        phaseKind: rule.phaseKind,
        scope: rule.scope,
        targetType: rule.targetType,
        pathPrefix: rule.pathPrefix,
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
