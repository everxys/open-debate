/** Debate lifecycle status */
export type DebateStatus = "pending" | "running" | "paused" | "completed" | "stopped" | "failed";

/** AI provider type */
export type Provider = "openai" | "anthropic";
export type AgentConnectivityCheckStatus = "reachable" | "failed";
export type AgentUsageControlMode = "none" | "coding_plan";
export type QuotaProfileType = "coding_plan";
export type QuotaPacingMode = "percent" | "absolute";
export type QuotaWindowType = "rolling_5h" | "week" | "month";

/** Retrieval/embedding provider type */
export type RetrievalProvider = "openai";

/** Structured argument from agent output */
export type StructuredArgument = {
  type: "support" | "rebuttal";
  content: string;
  target?: string;
};

/** Structured output parsed from agent response */
export type StructuredOutput = {
  proposed_solution?: string;
  arguments?: StructuredArgument[];
  agreement_score?: number;
};

/** AI agent configuration record */
export type AgentRecord = {
  id: string;
  userId: string;
  name: string;
  provider: Provider;
  model: string;
  contextLength: number | null;
  maxInputTokens: number | null;
  maxOutputTokens: number | null;
  baseUrl: string;
  apiKeyEncrypted: string;
  apiKeyMasked: string;
  lastConnectivityCheckStatus: AgentConnectivityCheckStatus | null;
  lastConnectivityCheckAt: string | null;
  lastConnectivityCheckMessage: string | null;
  usageControlMode: AgentUsageControlMode;
  quotaProfileId: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

export type QuotaProfileRecord = {
  id: string;
  userId: string;
  name: string;
  profileType: QuotaProfileType;
  requestLimit5h: number;
  requestLimitWeek: number;
  requestLimitMonth: number;
  pacingMode: QuotaPacingMode;
  pacingValue: number;
  resetTimezone: string;
  nextRequestNotBeforeAt: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

export type QuotaProfileSummary = {
  profileId: string;
  profileName: string;
  limit5h: number;
  used5h: number;
  remaining5h: number;
  window5hStartAt: string | null;
  window5hEndAt: string | null;
  limitWeek: number;
  usedWeek: number;
  remainingWeek: number;
  weekWindowStartAt: string;
  weekWindowEndAt: string;
  limitMonth: number;
  usedMonth: number;
  remainingMonth: number;
  monthWindowStartAt: string;
  monthWindowEndAt: string;
  pacingMode: QuotaPacingMode;
  pacingValue: number;
  pacingTarget5h: number;
  nextAvailableAt: string | null;
  blockingReason: "pacing" | "rolling_5h_limit" | "week_limit" | "month_limit" | null;
  effectiveIntervalMs: number;
};

/** Debate session record */
export type DebateRecord = {
  id: string;
  userId: string;
  question: string;
  status: DebateStatus;
  maxTurns: number;
  currentTurn: number;
  tokenUsed: number;
  enableSharedFacts: boolean;
  isShared: boolean;
  consensusReached: boolean;
  consensusSummary: { leadingSolution: string; score: number } | null;
  workflowPhaseKind: "analysis" | "deliberation" | "finalization_vote" | "finalization" | null;
  workflowPhaseTitle: string | null;
  workflowPhaseRound: number | null;
  runtimeNoticeKind: "recovering" | "recovered" | "interrupted" | "quota_wait" | null;
  runtimeNoticeMessage: string | null;
  runtimeNoticeAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  ignoredRuntimeErrorSignature: string | null;
  ignoredRuntimeErrorAt: string | null;
  autoRecoverOnceOnFailed: boolean;
  autoRecoverOnceUsedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  stoppedReason: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Debate participant (seat) record */
export type DebateAgentRecord = {
  id: string;
  debateId: string;
  aiAgentId: string;
  displayName: string;
  turnOrder: number;
  turnCount: number;
  createdAt: string;
};

/** Debate turn (message) record */
export type DebateTurnRecord = {
  id: string;
  debateId: string;
  aiAgentId: string;
  debateAgentId: string | null;
  seatNumber: number | null;
  turnNumber: number;
  content: string;
  structuredOutput: StructuredOutput | null;
  parseStatus: "ok" | "fallback";
  tokenUsed: number;
  responseTimeMs: number | null;
  retryCount: number;
  errorCode: string | null;
  createdAt: string;
};

/** In-memory database shape (for legacy compatibility) */
export type AppDb = {
  agents: AgentRecord[];
  debates: DebateRecord[];
  debateAgents: DebateAgentRecord[];
  turns: DebateTurnRecord[];
};

/** Retrieval/embedding configuration record */
export type RetrievalConfigRecord = {
  id: string;
  userId: string;
  provider: RetrievalProvider;
  name: string;
  model: string;
  dimensions: number | null;
  baseUrl: string;
  apiKeyEncrypted: string;
  apiKeyMasked: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

export type WorkspaceRecord = {
  id: string;
  ownerUserId: string;
  strategyId: string;
  name: string;
  description: string | null;
  question: string;
  summaryAiAgentId: string | null;
  defaultMaxTurns: number;
  defaultEnableSharedFacts: boolean;
  createdAt: string;
  updatedAt: string;
};

export type WorkspaceRoleBindingRecord = {
  id: string;
  workspaceId: string;
  sourceStrategyRoleId: string | null;
  roleName: string;
  roleOrder: number;
  aiAgentId: string | null;
  displayName: string | null;
  createdAt: string;
  updatedAt: string;
};

export type WorkspaceFileRecord = {
  id: string;
  workspaceId: string;
  path: string;
  content: string;
  createdAt: string;
  updatedAt: string;
};
