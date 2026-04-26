import type { PlaygroundChecklistItem } from "@/lib/playground/types";

type PlaygroundChecklistStreamEvent =
  | { type: "snapshot"; items: PlaygroundChecklistItem[] }
  | { type: "checklist_progress"; item: PlaygroundChecklistItem }
  | { type: "checklist_finished"; item: PlaygroundChecklistItem };

type Listener = (event: PlaygroundChecklistStreamEvent) => void;

const globalStore = globalThis as typeof globalThis & {
  openDebatePlaygroundListeners?: Map<string, Set<Listener>>;
};

function getRegistry() {
  if (!globalStore.openDebatePlaygroundListeners) {
    globalStore.openDebatePlaygroundListeners = new Map();
  }
  return globalStore.openDebatePlaygroundListeners;
}

function toKey(userId: string, agentId: string) {
  return `${userId}:${agentId}`;
}

export function subscribePlaygroundChecklistEvents(userId: string, agentId: string, listener: Listener) {
  const registry = getRegistry();
  const key = toKey(userId, agentId);
  const listeners = registry.get(key) ?? new Set<Listener>();
  listeners.add(listener);
  registry.set(key, listeners);
  return () => {
    const current = registry.get(key);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) {
      registry.delete(key);
    }
  };
}

export function publishPlaygroundChecklistEvent(userId: string, agentId: string, event: PlaygroundChecklistStreamEvent) {
  const registry = getRegistry();
  const listeners = registry.get(toKey(userId, agentId));
  if (!listeners?.size) return;
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
    }
  }
}

