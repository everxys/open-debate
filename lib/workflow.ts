export type WorkflowPhaseKind = "analysis" | "election" | "deliberation" | "finalization_vote" | "finalization";
export type WorkflowContextAccessScope = "shared" | "seat";

export type DebateWorkflowContextAccessRule = {
  scope?: WorkflowContextAccessScope;
  pathPrefix?: string;
  label?: string | null;
  maxFiles?: number | null;
  maxCharsPerFile?: number | null;
  recursive?: boolean;
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
      election?: {
        startRound?: number;
        autoOpen?: boolean;
        reopenUntilPassed?: boolean;
        discussionRoundsBetweenVotes?: number;
      };
      finalization?: {
        autoOpenVote?: boolean;
        requireUnanimousVote?: boolean;
        reopenUntilPassed?: boolean;
        discussionRoundsBetweenVotes?: number;
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
      draftRole?: string | null;
      reviewRole?: string | null;
      finalRole?: string | null;
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
      election: {
        startRound: number;
        autoOpen: boolean;
        reopenUntilPassed: boolean;
        discussionRoundsBetweenVotes: number;
      };
      finalization: {
        autoOpenVote: boolean;
        requireUnanimousVote: boolean;
        reopenUntilPassed: boolean;
        discussionRoundsBetweenVotes: number;
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
      draftRole: WorkflowDeliverableRole | null;
      reviewRole: WorkflowDeliverableRole | null;
      finalRole: WorkflowDeliverableRole | null;
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

export type WorkflowDeliverableRole = "Host" | "Supervisor" | "Specialist";
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
          id: "phase-1",
          title: "Phase 1 · 议员实战演练",
          kind: "analysis",
          description: "前两轮先独立分析、归类、指出风险，并给出主持人/监管者候选建议。",
          minRounds: null,
          injectedPrompt:
            "【Phase 1】当前仍处于主持人与监管者选举之前的分析阶段。本阶段只能做独立分析、提出候选建议、说明谁适合主持人或监管者以及理由，但禁止正式投票，禁止写“我投谁”，禁止提前宣布谁当选。所有席位现在都还只是议员，真正投票只能等进入 Phase 1.5 后再进行。表达是硬要求：默认必须用普通人能直接看懂的话来讲，禁止故意写得高深、文绉绉、术语堆叠。只有在前沿科学等内容里，确实没有更合适的日常说法时，才允许保留必要术语；一旦用了术语，必须立刻顺手解释它在这里到底是什么意思、会怎样起作用。"
        },
        {
          id: "phase-1-5",
          title: "Phase 1.5 · 主持人与监管者选举",
          kind: "election",
          description: "用一整轮完成主持人与监管者选举；若未能选出结果，则先回到 Phase 1 补充一轮发言，再重新进入本阶段投票。",
          minRounds: null,
          injectedPrompt:
            "【Phase 1.5】当前是主持人与监管者的正式选举轮。你必须基于前面 Phase 1 已经出现的表现来判断谁适合做主持人、谁适合做监管者，并把判断依据讲清楚。禁止借投票继续推进新设定、新主线或新事件。若本轮无法形成明确结果，下一轮会先回到 Phase 1 继续补充发言，然后系统再发起下一次 Phase 1.5 选举。表达同样是硬要求：投票理由必须让旁观者直接看懂，禁止拿腔拿调、禁止只丢高端术语。只有涉及确实绕不开的前沿科学名词时，才允许保留术语，但必须顺手解释成人话。"
        },
        {
          id: "phase-2",
          title: "Phase 2 · 动态轮换讨论",
          kind: "deliberation",
          description: "主持人宣布统一模式，全员围绕创意发散、逻辑审核与方案收敛循环推进。",
          minRounds: null,
          injectedPrompt:
            "【Phase 2】本阶段每次发言最多只允许重点讨论 5 个点子，默认更推荐只打 1 到 3 个最关键的点子。禁止一口气平铺十几个点子名然后每个只讲一句。你必须主动做取舍，只挑当前最值得推进、最能说服对手的少数点子展开深打。对每个点子，都要尽量讲清：它具体是什么，你为什么优先选它，它如何运作，它比前案强在哪里，可能会被怎样反驳，你准备怎么回应。你的目标不是“多报几个灵感”，而是拿少数几个点子讲出足够完整的思考过程和说服力，让别的席位真的有可能被你说服。表达是硬要求：默认必须用自然、直接、给人看的语言来写，禁止炫技式术语腔、论文腔、文绉绉的绕法。只有在前沿科学内容里确实绕不开时，才允许少量必要术语，但每个关键术语都要立刻翻成人话。"
        },
        {
          id: "phase-2-5",
          title: "Phase 2.5 · Phase 3 入场表决",
          kind: "finalization_vote",
          description: "在正式进入 Phase 3 前，先统一进入投票确认轮；本轮应聚焦是否已经具备收束条件，并完成入场表决。",
          minRounds: null,
          injectedPrompt: "【Phase 2.5】你们现在处于进入 Phase 3 之前的正式入场表决阶段。本阶段不是继续无边界发散，也不是直接开始最终交付，而是先判断：当前方案是否已经具备进入最终收束和交付写作的条件。发言重点必须围绕“是否已经可以进入 Phase 3”展开：现有争议是否已经收束、关键缺口是否已经补齐、哪些文件/结构已成熟、哪些风险如果不先补会导致最终总稿失真。你必须说清楚自己的判断依据，然后按规则参与入场投票。只有全员同意，下一轮才会正式进入 Phase 3。"
        },
        {
          id: "phase-3",
          title: "Phase 3 · 共识收敛与最终交付",
          kind: "finalization",
          description: "进入最终表决与最终产物输出，完成收敛与交付。",
          minRounds: null,
          injectedPrompt: null
        }
      ],
      transitionRules: {
        election: {
          startRound: 3,
          autoOpen: true,
          reopenUntilPassed: true,
          discussionRoundsBetweenVotes: 1
        },
        finalization: {
          autoOpenVote: true,
          requireUnanimousVote: true,
          reopenUntilPassed: true,
          discussionRoundsBetweenVotes: 1,
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
      openingPrompt:
        "整场讨论都必须把“给人看得懂”当成硬要求。默认必须讲人话，禁止只丢简短结论、标签或速记句，禁止故意写得太高端、太文绉绉、太像术语表。只有在前沿科学等内容里，确实存在绕不开的专业术语时，才允许保留必要术语；一旦用了术语，必须立刻顺手解释它在当前方案里到底是什么意思、如何运作、为什么重要。更重要的是，后发言者的首要任务不是顺着前一个人做轻量补充，而是主动寻找更强、更狠、更完整的替代方案；只要你判断前案不够好，就应当直接提出新方案，必要时可以整体推翻前案并重建。每次发言最多只允许重点讨论 5 个点子，默认更推荐只打 1 到 3 个最关键的点子；禁止一口气铺开很多点子却每个只讲一句。只要提出一个方案、反驳或投票理由，都要尽量讲清楚它具体是什么、为什么更强、会带来什么影响、你是怎么想到这一步的，让其他人一眼看懂你的判断依据。另外，在 Phase 1 和 Phase 1 之前严禁提前投票、严禁写“我投谁”、严禁提前宣布主持人或监管者；那只能在正式进入 Phase 1.5 后发生。",
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
          draftRole: "Specialist",
          reviewRole: "Supervisor",
          finalRole: "Host",
          description: "核心卖点、主题、核心冲突、故事承诺",
          minChars: 1200,
          minMarkdownHeadings: 4,
          requiredSnippets: ["核心卖点", "主题", "核心冲突", "故事承诺"]
        },
        {
          path: "final/02-characters.md",
          draftRole: "Specialist",
          reviewRole: "Supervisor",
          finalRole: "Host",
          description: "主角、关键配角、反派的人物卡与成长弧",
          minChars: 2200,
          minMarkdownHeadings: 8,
          requiredSnippets: ["主角", "关键配角", "反派", "成长弧"]
        },
        {
          path: "final/03-world-and-rules.md",
          draftRole: "Specialist",
          reviewRole: "Supervisor",
          finalRole: "Host",
          description: "世界观、关键设定、限制条件、代价与规则",
          minChars: 1800,
          minMarkdownHeadings: 5,
          requiredSnippets: ["世界观", "规则", "限制条件", "代价"]
        },
        {
          path: "final/04-plot-architecture.md",
          draftRole: "Specialist",
          reviewRole: "Supervisor",
          finalRole: "Host",
          description: "三幕结构、关键事件、高潮设计、结局方向",
          minChars: 2600,
          minMarkdownHeadings: 7,
          requiredSnippets: ["三幕结构", "关键事件", "高潮", "结局"]
        },
        {
          path: "final/05-chapter-outline.md",
          draftRole: "Specialist",
          reviewRole: "Supervisor",
          finalRole: "Host",
          description: "章节级细纲，每章包含目标、冲突、转折、结果与钩子",
          minChars: 5000,
          minMarkdownHeadings: 16,
          requiredSnippets: ["章节目标", "冲突", "转折", "结果", "钩子"]
        },
        {
          path: "final/06-foreshadowing-ledger.md",
          draftRole: "Specialist",
          reviewRole: "Supervisor",
          finalRole: "Host",
          description: "伏笔、埋点、回收位置和作用",
          minChars: 1800,
          minMarkdownHeadings: 6,
          requiredSnippets: ["伏笔", "埋点", "回收", "作用"]
        },
        {
          path: "final/novel_outline_v2.md",
          draftRole: "Specialist",
          reviewRole: "Supervisor",
          finalRole: "Host",
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
  const roleSummary = [
    file.draftRole ? `起草：${file.draftRole}` : "",
    file.reviewRole ? `审查：${file.reviewRole}` : "",
    file.finalRole ? `定稿：${file.finalRole}` : ""
  ]
    .filter(Boolean)
    .join(" / ");
  if (style === "display") {
    return [
      file.path,
      roleSummary ? `（${roleSummary}）` : "",
      file.minChars ? `［至少 ${file.minChars} 字符］` : "",
      file.minMarkdownHeadings ? `［至少 ${file.minMarkdownHeadings} 个标题］` : "",
      file.requiredSnippets.length ? `［包含 ${file.requiredSnippets.join("/")}］` : ""
    ].join("");
  }

  const details: string[] = [];
  if (file.draftRole) details.push(`draft=${file.draftRole}`);
  if (file.reviewRole) details.push(`review=${file.reviewRole}`);
  if (file.finalRole) details.push(`final=${file.finalRole}`);
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

function normalizeWorkflowDeliverableRole(value: unknown): WorkflowDeliverableRole | null {
  const trimmed = toTrimmedString(value);
  if (trimmed === "Host" || trimmed === "Supervisor" || trimmed === "Specialist") {
    return trimmed;
  }
  return null;
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
  if (input.ownerRole === "Host") {
    return {
      draftRole: "Specialist" as const,
      reviewRole: "Supervisor" as const,
      finalRole: "Host" as const
    };
  }
  const normalizedOwner = normalizeWorkflowDeliverableRole(input.ownerRole);
  if (normalizedOwner) {
    return {
      draftRole: normalizedOwner,
      reviewRole: normalizedOwner === "Supervisor" ? "Host" : "Supervisor",
      finalRole: normalizedOwner === "Specialist" ? "Specialist" : "Host"
    };
  }
  return {
    draftRole: null,
    reviewRole: null,
    finalRole: null
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

function normalizePhaseIdentifier(kind: string, id: string, title: string) {
  if (kind === "election" && (id === "phase-2" || title === "Phase 2 · 民主选举")) return "phase-1-5";
  if (kind === "deliberation" && id === "phase-3") return "phase-2";
  if (kind === "finalization_vote" && id === "phase-3-5") return "phase-2-5";
  if (kind === "finalization" && id === "phase-4") return "phase-3";
  return id;
}

function normalizePhaseTitle(kind: string, title: string) {
  if (kind === "election" && title === "Phase 2 · 民主选举") return "Phase 1.5 · 主持人与监管者选举";
  if (kind === "deliberation" && title === "Phase 3 · 动态轮换讨论") return "Phase 2 · 动态轮换讨论";
  if (kind === "finalization_vote" && title === "Phase 3.5 · Phase 4 入场表决") return "Phase 2.5 · Phase 3 入场表决";
  if (kind === "finalization" && title === "Phase 4 · 共识收敛与最终交付") return "Phase 3 · 共识收敛与最终交付";
  return title;
}

function normalizePhaseDescription(kind: string, description: string | null) {
  if (kind !== "election") return description;
  if (description === "用一整轮完成主持人与监管者选举，不夹带额外发言，形成明确任命结果。") {
    return "用一整轮完成主持人与监管者选举；如果本轮未选出结果，则先回到 Phase 1 补充一轮全员发言，再重新进入本阶段。";
  }
  return description;
}

function normalizePhaseInjectedPrompt(kind: string, injectedPrompt: string | null) {
  if (!injectedPrompt) return injectedPrompt;
  if (kind === "election") {
    if (injectedPrompt.includes("【Phase 2 强化版】") && !injectedPrompt.includes("【Phase 1.5")) {
      return injectedPrompt
        .replace(/【Phase 2 强化版】/g, "【Phase 1.5 强化版】")
        .replace(/【Phase 2】/g, "【Phase 1.5】")
        .replace(/Phase 2/g, "Phase 1.5");
    }
    return injectedPrompt;
  }
  if (kind === "deliberation") {
    return injectedPrompt
      .replace(/【Phase 3 强化版】/g, "【Phase 2 强化版】")
      .replace(/【Phase 3】/g, "【Phase 2】")
      .replace(/Phase 3/g, "Phase 2");
  }
  if (kind === "finalization_vote") {
    return injectedPrompt
      .replace(/【Phase 3\.5 强化版】/g, "【Phase 2.5 强化版】")
      .replace(/【Phase 3\.5】/g, "【Phase 2.5】")
      .replace(/Phase 3\.5/g, "Phase 2.5")
      .replace(/Phase 4/g, "Phase 3");
  }
  if (kind === "finalization") {
    return injectedPrompt
      .replace(/【Phase 4 强化版】/g, "【Phase 3 强化版】")
      .replace(/【Phase 4】/g, "【Phase 3】")
      .replace(/Phase 4/g, "Phase 3");
  }
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
        kindRaw === "election" ||
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
        kind: "analysis" | "election" | "deliberation" | "finalization_vote" | "finalization";
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
              minRounds: null,
              injectedPrompt: null
            },
            {
              id: "phase-1-5",
              title: "Phase 1.5 · 主持人与监管者选举",
              kind: "election" as const,
              description: "基于前期表现投票选出主持人和监管者；若未能选出，则先回到 Phase 1 补充发言，再重新进入本阶段。",
              minRounds: null,
              injectedPrompt: null
            },
            {
              id: "phase-2",
              title: "Phase 2 · 动态轮换讨论",
              kind: "deliberation" as const,
              description: "主持人宣布统一模式，全员围绕创意发散/逻辑审核等模式循环推进。",
              minRounds: null,
              injectedPrompt: null
            },
            {
              id: "phase-2-5",
              title: "Phase 2.5 · Phase 3 入场表决",
              kind: "finalization_vote" as const,
              description: "正式进入 Phase 3 之前，先做一轮入场判断与官方投票确认。",
              minRounds: null,
              injectedPrompt: null
            },
            {
              id: "phase-3",
              title: "Phase 3 · 共识收敛与最终交付",
              kind: "finalization" as const,
              description: "进入最终表决与最终产物输出，完成收敛与交付。",
              minRounds: null,
              injectedPrompt: null
            }
          ],
    transitionRules: {
      election: {
        startRound: toPositiveInt(electionTransitionRaw?.startRound) ?? 1,
        autoOpen: electionTransitionRaw?.autoOpen === undefined ? true : Boolean(electionTransitionRaw.autoOpen),
        reopenUntilPassed:
          electionTransitionRaw?.reopenUntilPassed === undefined
            ? true
            : Boolean(electionTransitionRaw.reopenUntilPassed),
        discussionRoundsBetweenVotes: toPositiveInt(electionTransitionRaw?.discussionRoundsBetweenVotes) ?? 1
      },
      finalization: {
        autoOpenVote:
          finalizationTransitionRaw?.autoOpenVote === undefined
            ? true
            : Boolean(finalizationTransitionRaw.autoOpenVote),
        requireUnanimousVote:
          finalizationTransitionRaw?.requireUnanimousVote === undefined
            ? true
            : Boolean(finalizationTransitionRaw.requireUnanimousVote),
        reopenUntilPassed:
          finalizationTransitionRaw?.reopenUntilPassed === undefined
            ? true
            : Boolean(finalizationTransitionRaw.reopenUntilPassed),
        discussionRoundsBetweenVotes: toPositiveInt(finalizationTransitionRaw?.discussionRoundsBetweenVotes) ?? 1,
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
      const ownerRole = fileObj?.ownerRole === null ? null : toTrimmedString(fileObj?.ownerRole);
      const resolvedRoles = resolveRequiredFileRoles({
        ownerRole,
        draftRole: normalizeWorkflowDeliverableRole(fileObj?.draftRole),
        reviewRole: normalizeWorkflowDeliverableRole(fileObj?.reviewRole),
        finalRole: normalizeWorkflowDeliverableRole(fileObj?.finalRole)
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
        draftRole: WorkflowDeliverableRole | null;
        reviewRole: WorkflowDeliverableRole | null;
        finalRole: WorkflowDeliverableRole | null;
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
          if (!["analysis", "election", "deliberation", "finalization_vote", "finalization"].includes(phaseKind)) return null;
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
  let contextAccess: NormalizedDebateWorkflow["contextAccess"];
  try {
    contextAccess = normalizeContextAccess((anyInput as { contextAccess?: unknown }).contextAccess);
  } catch {
    return null;
  }

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
    ideaBank,
    contextAccess
  };
}

export function toCanonicalWorkflowConfig(input: unknown): DebateWorkflowConfig | null {
  const normalized = normalizeDebateWorkflow(input);
  if (!normalized) return null;
  return {
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
        election: {
          startRound: normalized.phaseMachine.transitionRules.election.startRound,
          autoOpen: normalized.phaseMachine.transitionRules.election.autoOpen,
          reopenUntilPassed: normalized.phaseMachine.transitionRules.election.reopenUntilPassed,
          discussionRoundsBetweenVotes: normalized.phaseMachine.transitionRules.election.discussionRoundsBetweenVotes
        },
        finalization: {
          autoOpenVote: normalized.phaseMachine.transitionRules.finalization.autoOpenVote,
          requireUnanimousVote: normalized.phaseMachine.transitionRules.finalization.requireUnanimousVote,
          reopenUntilPassed: normalized.phaseMachine.transitionRules.finalization.reopenUntilPassed,
          discussionRoundsBetweenVotes: normalized.phaseMachine.transitionRules.finalization.discussionRoundsBetweenVotes,
          requirePhaseForCompletion: normalized.phaseMachine.transitionRules.finalization.requirePhaseForCompletion
        }
      }
    },
    election: {
      startRound: normalized.election.startRound,
      roles: normalized.election.roles,
      speakingOrder: {
        firstRole: normalized.election.speakingOrder.firstRole,
        lastRole: normalized.election.speakingOrder.lastRole
      }
    },
    seatOrderRules: normalized.seatOrderRules.map((rule) => ({
      afterRound: rule.afterRound,
      policy: rule.policy.type === "rotate" ? { type: "rotate", offset: rule.policy.offset } : { type: "reverse" }
    })),
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
        tieBreaker: normalized.voting.governance.tieBreaker,
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
        requiredSnippets: file.requiredSnippets
      }))
    },
    ideaBank: {
      rawIdeaBankPath: normalized.ideaBank.rawIdeaBankPath,
      derivedFiles: normalized.ideaBank.derivedFiles
    },
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
}

export function safeParseWorkflowJson(raw: string | null): NormalizedDebateWorkflow | null {
  if (!raw) return null;
  try {
    return normalizeDebateWorkflow(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}
