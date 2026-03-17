import { EventEmitter } from "node:events";

export type DebateLiveStage =
  | "idle"
  | "calling_model"
  | "running_tools"
  | "parsing"
  | "saving"
  | "sleeping";

export type DebateLiveProgress = {
  debateId: string;
  roundNumber: number;
  messageNumber: number;
  debateAgentId: string;
  aiAgentId: string;
  agentName: string;
  stage: DebateLiveStage;
  updatedAt: string;
};

export type DebateLiveEvent =
  | { type: "turn_start"; progress: DebateLiveProgress }
  | { type: "status"; debateId: string; message: string; at: string }
  | { type: "chunk"; debateId: string; turnNumber: number; agentName: string; text: string; at: string }
  | { type: "turn_end"; debateId: string; turnNumber: number; agentName: string; at: string };

type Store = {
  emitter: EventEmitter;
  progressByDebateId: Map<string, DebateLiveProgress>;
};

function getStore(): Store {
  const anyGlobal = globalThis as unknown as { __openDebateLive?: Store };
  if (!anyGlobal.__openDebateLive) {
    anyGlobal.__openDebateLive = {
      emitter: new EventEmitter(),
      progressByDebateId: new Map()
    };
    anyGlobal.__openDebateLive.emitter.setMaxListeners(200);
  }
  return anyGlobal.__openDebateLive;
}

export function getDebateLiveProgress(debateId: string) {
  return getStore().progressByDebateId.get(debateId) ?? null;
}

export function clearDebateLiveProgress(debateId: string) {
  getStore().progressByDebateId.delete(debateId);
}

export function setDebateLiveProgress(progress: Omit<DebateLiveProgress, "updatedAt"> & { updatedAt?: string }) {
  const store = getStore();
  const next: DebateLiveProgress = {
    ...progress,
    updatedAt: progress.updatedAt ?? new Date().toISOString()
  };
  store.progressByDebateId.set(progress.debateId, next);
  store.emitter.emit(`debate:${progress.debateId}`, { type: "turn_start", progress: next } satisfies DebateLiveEvent);
}

export function emitDebateLiveEvent(debateId: string, event: DebateLiveEvent) {
  getStore().emitter.emit(`debate:${debateId}`, event);
}

export function subscribeDebateLiveEvents(
  debateId: string,
  listener: (event: DebateLiveEvent) => void
) {
  const store = getStore();
  const key = `debate:${debateId}`;
  store.emitter.on(key, listener);
  return () => store.emitter.off(key, listener);
}
