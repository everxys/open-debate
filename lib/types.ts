export type DebateStatus =
  | "pending"
  | "running"
  | "paused"
  | "completed"
  | "stopped"
  | "failed";

export type Provider = "openai" | "anthropic";

export type StructuredArgument = {
  type: "support" | "rebuttal";
  content: string;
  target?: string;
};

export type StructuredOutput = {
  proposed_solution?: string;
  arguments?: StructuredArgument[];
  agreement_score?: number;
};

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
  consensusSummary: {
    leadingSolution: string;
    score: number;
  } | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  stoppedReason: string | null;
  createdAt: string;
  updatedAt: string;
};

export type DebateAgentRecord = {
  id: string;
  debateId: string;
  aiAgentId: string;
  displayName: string;
  turnOrder: number;
  turnCount: number;
  createdAt: string;
};

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

export type AppDb = {
  agents: AgentRecord[];
  debates: DebateRecord[];
  debateAgents: DebateAgentRecord[];
  turns: DebateTurnRecord[];
};
