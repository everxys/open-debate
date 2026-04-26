export type StrategyDetail = {
  id: string;
  name: string;
  description: string | null;
  isShared: boolean;
  updatedAt?: string | null;
  forkedFromStrategyId?: string | null;
  isFavorited?: boolean;
  favoriteCount?: number;
  forkCount?: number;
  canEdit: boolean;
  roles: Array<{
    id: string;
    name: string;
    systemPrompt: string | null;
    roleOrder: number;
  }>;
};

export type RoleDraft = { clientId: string; id: string; name: string; systemPrompt: string };

export type WorkflowPhasePrompt = {
  id: string;
  title: string;
  kind: "analysis" | "deliberation" | "finalization_vote" | "finalization";
  description: string | null;
  minRounds: number | null;
  injectedPrompt: string;
};

export type WorkflowPhaseKind = WorkflowPhasePrompt["kind"];

export type WorkflowContextAccessRule = {
  scope: "shared" | "seat";
  pathPrefix: string;
  maxFiles: number;
  maxCharsPerFile: number;
  recursive: boolean;
};

export type WorkflowPhaseGateRule = WorkflowContextAccessRule & {
  phaseKind: WorkflowPhaseKind;
};

export type WorkflowContextAccess = {
  alwaysRead: WorkflowContextAccessRule[];
  readWhenNeeded: WorkflowContextAccessRule[];
  unlockAfterPhase: WorkflowPhaseGateRule[];
};

export type WorkflowSummarizer = {
  enabled: boolean;
  perTurn: boolean;
  perRound: boolean;
  factsBoard: boolean;
  prompts: {
    turnSummary: string;
    roundSummary: string;
    factsBoard: string;
  };
  outputPaths: {
    turnSummaryDir: string;
    roundSummaryDir: string;
    factsBoardPath: string;
  };
};

export type WorkflowConfigPayload = {
  workflowVersion?: number;
  enabled?: boolean;
  contextAccess?: WorkflowContextAccess;
  summarizer?: Partial<WorkflowSummarizer> & {
    prompts?: Partial<WorkflowSummarizer["prompts"]>;
    outputPaths?: Partial<WorkflowSummarizer["outputPaths"]>;
  };
  [key: string]: unknown;
};

export type StrategyFileAccessRule = {
  id: string;
  strategyRoleId: string | null;
  scope: "shared" | "seat";
  targetType: "file" | "dir";
  targetPath: string;
  accessMode: "always_read" | "read_when_needed" | "unlock_after_phase";
  phaseKind: WorkflowPhaseKind | null;
};

export type WorkflowPromptDialogState =
  | null
  | {
      type: "phase";
      title: string;
      description: string;
      value: string;
      phaseIndex?: number;
    };

export type FileWithWebkitRelativePath = File & {
  webkitRelativePath?: string;
};

export type ImportedStrategyManifestPreview = {
  strategyName: string;
  roleCount: number;
  keepRoles: Array<{ id: string; name: string; roleOrder: number }>;
  deleteRoles: Array<{ id: string; name: string; roleOrder: number }>;
  newRoles: Array<{ sourceRoleId: string; name: string; roleOrder: number }>;
};

export type StrategyPanel = "shared" | "roleFiles" | "roleEditor" | "phaseUnlock";

export type MountedStrategyPanels = Record<StrategyPanel, boolean>;
