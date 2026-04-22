import { randomUUID } from "node:crypto";

export type DebateRunSnapshot = {
  startedAt: number;
  userId: string;
  heartbeatAt: number;
  runToken: string;
};

const ACTIVE_DEBATE_RUN_STALE_MS = 30 * 60 * 1000;
const activeDebateRuns = new Map<string, DebateRunSnapshot>();

function reapStaleDebateRuns(now = Date.now()) {
  for (const [id, snapshot] of activeDebateRuns.entries()) {
    if (now - snapshot.heartbeatAt > ACTIVE_DEBATE_RUN_STALE_MS) {
      activeDebateRuns.delete(id);
    }
  }
}

export function getDebateRunSnapshot(id: string) {
  reapStaleDebateRuns();
  return activeDebateRuns.get(id) ?? null;
}

export function tryAcquireDebateRun(id: string, userId: string) {
  reapStaleDebateRuns();
  const existing = getDebateRunSnapshot(id);
  if (existing) {
    return { acquired: false as const, existing };
  }

  const now = Date.now();
  const snapshot: DebateRunSnapshot = {
    startedAt: now,
    userId,
    heartbeatAt: now,
    runToken: randomUUID()
  };
  activeDebateRuns.set(id, snapshot);
  return { acquired: true as const, snapshot };
}

export function touchDebateRun(id: string, runToken: string) {
  reapStaleDebateRuns();
  const current = activeDebateRuns.get(id);
  if (!current || current.runToken !== runToken) return null;
  const next = { ...current, heartbeatAt: Date.now() };
  activeDebateRuns.set(id, next);
  return next;
}

export function releaseDebateRun(id: string, runToken: string) {
  reapStaleDebateRuns();
  const current = activeDebateRuns.get(id);
  if (!current || current.runToken !== runToken) return false;
  activeDebateRuns.delete(id);
  return true;
}
