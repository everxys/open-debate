export type DebateWorkflowConfig = {
  workflowVersion?: number;
  enabled?: boolean;
  phaseMachine?: {
    phases?: Array<{
      id?: string;
      title?: string;
      kind?: "analysis" | "election" | "deliberation" | "finalization";
      description?: string | null;
      minRounds?: number | null;
      injectedPrompt?: string | null;
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
      description?: string | null;
      minChars?: number | null;
      minMarkdownHeadings?: number | null;
      requiredSnippets?: string[];
    }>;
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
      minRounds: number | null;
      injectedPrompt: string | null;
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
      description: string | null;
      minChars: number | null;
      minMarkdownHeadings: number | null;
      requiredSnippets: string[];
    }>;
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
};

export type NormalizedWorkflowRequiredFile = NormalizedDebateWorkflow["deliverables"]["requiredFiles"][number];

export function createDefaultDebateWorkflowConfig(): DebateWorkflowConfig {
  return {
    workflowVersion: 1,
    enabled: true,
    phaseMachine: {
      phases: [
        {
          id: "phase-1",
          title: "Phase 1 · 议员实战演练",
          kind: "analysis",
          description: "前两轮先独立分析、归类、指出风险，并给出主持人/监管者候选建议。",
          minRounds: 2,
          injectedPrompt: null
        },
        {
          id: "phase-2",
          title: "Phase 2 · 民主选举",
          kind: "election",
          description: "用一整轮完成主持人与监管者选举，不夹带额外发言，形成明确任命结果。",
          minRounds: 1,
          injectedPrompt: null
        },
        {
          id: "phase-3",
          title: "Phase 3 · 动态轮换讨论",
          kind: "deliberation",
          description: "主持人宣布统一模式，全员围绕创意发散、逻辑审核与方案收敛循环推进。",
          minRounds: 8,
          injectedPrompt: null
        },
        {
          id: "phase-4",
          title: "Phase 4 · 共识收敛与最终交付",
          kind: "finalization",
          description: "进入最终表决与最终产物输出，完成收敛与交付。",
          minRounds: 4,
          injectedPrompt: null
        }
      ],
      transitionRules: {
        election: {
          startRound: 3,
          autoOpen: true
        },
        finalization: {
          enterOnConsensus: true,
          enterOnCustomVote: true,
          requirePhaseForCompletion: true
        }
      }
    },
    election: {
      startRound: 3,
      roles: ["Host", "Supervisor"],
      speakingOrder: { firstRole: "Host", lastRole: "Supervisor" }
    },
    seatOrderRules: [
      { afterRound: 1, policy: { type: "reverse" } },
      { afterRound: 2, policy: { type: "reverse" } }
    ],
    voting: {
      custom: { minOptions: 2, maxOptions: null },
      announcement: {
        announcer: { type: "role", role: "Host" },
        fallback: { type: "seat", seat: 1 }
      },
      governance: {
        tieBreaker: "revote",
        maxTieRounds: 2,
        fallbackMode: "逻辑审核员"
      }
    },
    consensus: { enabled: true, minAvgScore: 8, requireAllSeats: true },
    promptPolicies: {
      openingPrompt: null,
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
      requiredFiles: [
        {
          path: "final/01-story-core.md",
          ownerRole: "Host",
          description: "核心卖点、主题、核心冲突、故事承诺",
          minChars: 1200,
          minMarkdownHeadings: 4,
          requiredSnippets: ["核心卖点", "主题", "核心冲突", "故事承诺"]
        },
        {
          path: "final/02-characters.md",
          ownerRole: "Host",
          description: "主角、关键配角、反派的人物卡与成长弧",
          minChars: 2200,
          minMarkdownHeadings: 8,
          requiredSnippets: ["主角", "关键配角", "反派", "成长弧"]
        },
        {
          path: "final/03-world-and-rules.md",
          ownerRole: "Host",
          description: "世界观、关键设定、限制条件、代价与规则",
          minChars: 1800,
          minMarkdownHeadings: 5,
          requiredSnippets: ["世界观", "规则", "限制条件", "代价"]
        },
        {
          path: "final/04-plot-architecture.md",
          ownerRole: "Host",
          description: "三幕结构、关键事件、高潮设计、结局方向",
          minChars: 2600,
          minMarkdownHeadings: 7,
          requiredSnippets: ["三幕结构", "关键事件", "高潮", "结局"]
        },
        {
          path: "final/05-chapter-outline.md",
          ownerRole: "Host",
          description: "章节级细纲，每章包含目标、冲突、转折、结果与钩子",
          minChars: 5000,
          minMarkdownHeadings: 16,
          requiredSnippets: ["章节目标", "冲突", "转折", "结果", "钩子"]
        },
        {
          path: "final/06-foreshadowing-ledger.md",
          ownerRole: "Host",
          description: "伏笔、埋点、回收位置和作用",
          minChars: 1800,
          minMarkdownHeadings: 6,
          requiredSnippets: ["伏笔", "埋点", "回收", "作用"]
        },
        {
          path: "final/novel_outline_v2.md",
          ownerRole: "Host",
          description: "总汇总稿，整合人物、设定、结构与章节细纲",
          minChars: 7000,
          minMarkdownHeadings: 10,
          requiredSnippets: ["人物", "设定", "结构", "章节细纲", "逻辑自检"]
        }
      ]
    },
    ideaBank: {
      rawIdeaBankPath: null,
      derivedFiles: {
        selectedSTierPath: "ideas/selected-s-tier.md",
        selectedATierPath: "ideas/selected-a-tier.md",
        rejectedOrMergedPath: "ideas/rejected-or-merged.md",
        eventMappingsPath: "ideas/event-mappings.md",
        newlyInventedIdeasPath: "ideas/newly-invented-ideas.md"
      }
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
        description: phaseObj?.description === null ? null : toTrimmedString(phaseObj?.description),
        minRounds: toPositiveIntOrNull(phaseObj?.minRounds),
        injectedPrompt: phaseObj?.injectedPrompt === null ? null : toTrimmedString(phaseObj?.injectedPrompt)
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
        minRounds: number | null;
        injectedPrompt: string | null;
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
              description: "所有席位先独立分析、归类、指出风险，并给出主持人/监管者候选建议。",
              minRounds: 2,
              injectedPrompt: null
            },
            {
              id: "phase-2",
              title: "Phase 2 · 民主选举",
              kind: "election" as const,
              description: "基于前期表现投票选出主持人和监管者，形成明确任命结果。",
              minRounds: 1,
              injectedPrompt: null
            },
            {
              id: "phase-3",
              title: "Phase 3 · 动态轮换讨论",
              kind: "deliberation" as const,
              description: "主持人宣布统一模式，全员围绕创意发散/逻辑审核等模式循环推进。",
              minRounds: 24,
              injectedPrompt: null
            },
            {
              id: "phase-4",
              title: "Phase 4 · 共识收敛与最终交付",
              kind: "finalization" as const,
              description: "进入最终表决与最终产物输出，完成收敛与交付。",
              minRounds: 12,
              injectedPrompt: null
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
  const ideaBank = normalizeIdeaBank((anyInput as { ideaBank?: unknown }).ideaBank);

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
    deliverables,
    ideaBank
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
