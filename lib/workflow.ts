export type DebateWorkflowConfig = {
  workflowVersion?: number;
  enabled?: boolean;

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
};

export type NormalizedDebateWorkflow = {
  workflowVersion: 1;
  enabled: boolean;
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
};

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

function toInt(value: unknown) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.floor(n);
}

function normalizeRoles(value: unknown) {
  return Array.isArray(value)
    ? value
        .map((r) => toTrimmedString(r))
        .filter((r): r is string => Boolean(r))
    : [];
}

function normalizeSpeakingOrder(value: unknown) {
  if (typeof value !== "object" || value === null) return { firstRole: null, lastRole: null };
  const obj = value as Record<string, unknown>;
  const firstRole = obj.firstRole === null ? null : toTrimmedString(obj.firstRole);
  const lastRole = obj.lastRole === null ? null : toTrimmedString(obj.lastRole);
  return { firstRole, lastRole };
}

export function normalizeDebateWorkflow(input: unknown): NormalizedDebateWorkflow | null {
  if (typeof input !== "object" || input === null) return null;
  const anyInput = input as Record<string, unknown>;

  const versionRaw = toPositiveInt((anyInput as { workflowVersion?: unknown }).workflowVersion) ?? 1;
  if (versionRaw !== 1) return null;

  const enabledRaw = (anyInput as { enabled?: unknown }).enabled;
  const enabled = enabledRaw === undefined ? false : Boolean(enabledRaw);

  const electionRaw = (anyInput as { election?: unknown }).election;
  const electionObj =
    typeof electionRaw === "object" && electionRaw !== null ? (electionRaw as Record<string, unknown>) : null;

  const legacyStartRound = toPositiveInt((anyInput as { startRound?: unknown }).startRound);
  const legacyRoles = normalizeRoles((anyInput as { roles?: unknown }).roles);
  const legacySpeakingOrder = normalizeSpeakingOrder((anyInput as { speakingOrder?: unknown }).speakingOrder);

  const startRound =
    toPositiveInt(electionObj?.startRound) ?? legacyStartRound ?? 1;
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

  return {
    workflowVersion: 1,
    enabled,
    election: {
      startRound,
      roles,
      speakingOrder
    },
    seatOrderRules
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
