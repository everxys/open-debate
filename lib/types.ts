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
  baseUrl: string;
  apiKeyEncrypted: string;
  apiKeyMasked: string;
  systemPrompt: string | null;
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
  tokenBudget: number | null;
  tokenUsed: number;
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
  turnOrder: number;
  turnCount: number;
  createdAt: string;
};

export type DebateTurnRecord = {
  id: string;
  debateId: string;
  aiAgentId: string;
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
