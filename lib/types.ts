/** Debate lifecycle status */
export type DebateStatus = "pending" | "running" | "paused" | "completed" | "stopped" | "failed";

/** AI provider type */
export type Provider = "openai" | "anthropic";

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
