/** Debate lifecycle status */
export type DebateStatus = "pending" | "running" | "paused" | "completed" | "stopped" | "failed";

/** AI provider type */
export type Provider = "openai" | "anthropic";
export type AgentConnectivityCheckStatus = "reachable" | "failed";

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
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
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
  runtimeNoticeKind: "recovering" | "recovered" | "interrupted" | null;
  runtimeNoticeMessage: string | null;
  runtimeNoticeAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  ignoredRuntimeErrorSignature: string | null;
  ignoredRuntimeErrorAt: string | null;
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
