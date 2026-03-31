export type FsNode = {
  id: string;
  name: string;
  type: "dir" | "file";
  path: string; // dir path without trailing slash; file path
  children?: FsNode[];
};

export function joinFsPath(base: string, leaf: string) {
  const b = String(base ?? "").replace(/\/+$/, "");
  const l = String(leaf ?? "").replace(/^\/+/, "");
  if (!b) return l;
  if (!l) return b;
  return `${b}/${l}`;
}

export function normalizeFsPath(value: string) {
  return String(value ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/{2,}/g, "/");
}

export function isKeepMarkerPath(path: string) {
  return normalizeFsPath(path).endsWith("/.keep");
}

type Options = {
  normalizePath?: (path: string) => string;
  isDirMarker?: (path: string) => boolean;
};

type DirEntry = {
  node: FsNode;
  parent: DirEntry | null;
  name: string;
  path: string;
  dirs: Map<string, DirEntry>;
  files: Map<string, FsNode>;
};

function toDirId(path: string) {
  return `d:${path}`;
}

function toFileId(path: string) {
  return `f:${path}`;
}

function defaultNormalizePath(value: string) {
  return normalizeFsPath(value);
}

function defaultIsDirMarker(_path: string) {
  return false;
}

function sortChildren(children: FsNode[]) {
  children.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return children;
}

export class FsTreeModel {
  private normalizePath: (path: string) => string;
  private isDirMarker: (path: string) => boolean;
  private root: DirEntry;
  private knownPaths: Set<string>;

  constructor(options?: Options) {
    this.normalizePath = options?.normalizePath ?? defaultNormalizePath;
    this.isDirMarker = options?.isDirMarker ?? defaultIsDirMarker;
    this.root = this.createRoot();
    this.knownPaths = new Set();
  }

  private createRoot(): DirEntry {
    const node: FsNode = { id: toDirId(""), name: "", type: "dir", path: "", children: [] };
    return { node, parent: null, name: "", path: "", dirs: new Map(), files: new Map() };
  }

  private rebuildChildren(dir: DirEntry) {
    const children: FsNode[] = [];
    for (const sub of dir.dirs.values()) children.push(sub.node);
    for (const file of dir.files.values()) children.push(file);
    dir.node.children = sortChildren(children);
  }

  private ensureDir(pathParts: string[]) {
    let current = this.root;
    let prefix = "";
    for (const part of pathParts) {
      prefix = prefix ? `${prefix}/${part}` : part;
      const existing = current.dirs.get(part);
      if (existing) {
        current = existing;
        continue;
      }
      const node: FsNode = { id: toDirId(prefix), name: part, type: "dir", path: prefix, children: [] };
      const next: DirEntry = { node, parent: current, name: part, path: prefix, dirs: new Map(), files: new Map() };
      current.dirs.set(part, next);
      this.rebuildChildren(current);
      current = next;
    }
    return current;
  }

  private pruneIfEmpty(dir: DirEntry) {
    let current: DirEntry | null = dir;
    while (current && current.parent) {
      if (current.dirs.size > 0) return;
      if (current.files.size > 0) return;
      const parent: DirEntry = current.parent;
      parent.dirs.delete(current.name);
      this.rebuildChildren(parent);
      current = parent;
    }
  }

  reset(paths: string[]) {
    this.root = this.createRoot();
    this.knownPaths = new Set();
    this.sync(paths);
    return this.getTree();
  }

  sync(paths: string[]) {
    const nextSet = new Set<string>();
    for (const raw of paths) {
      const normalized = this.normalizePath(raw);
      if (!normalized) continue;
      nextSet.add(normalized);
    }

    // Delete removed paths
    for (const existing of this.knownPaths) {
      if (!nextSet.has(existing)) this.deletePath(existing);
    }

    // Add new paths
    for (const incoming of nextSet) {
      if (!this.knownPaths.has(incoming)) this.upsertPath(incoming);
    }

    this.knownPaths = nextSet;
    return this.getTree();
  }

  upsertPath(rawPath: string) {
    const normalized = this.normalizePath(rawPath);
    if (!normalized) return this.getTree();
    this.knownPaths.add(normalized);

    const parts = normalized.split("/").filter(Boolean);
    if (parts.length === 0) return this.getTree();
    const dirParts = parts.slice(0, -1);
    const fileName = parts[parts.length - 1];
    const dir = this.ensureDir(dirParts);

    if (!this.isDirMarker(normalized)) {
      if (!dir.files.has(fileName)) {
        dir.files.set(fileName, {
          id: toFileId(normalized),
          name: fileName,
          type: "file",
          path: normalized
        });
        this.rebuildChildren(dir);
      }
    }
    return this.getTree();
  }

  deletePath(rawPath: string) {
    const normalized = this.normalizePath(rawPath);
    if (!normalized) return this.getTree();
    this.knownPaths.delete(normalized);

    const parts = normalized.split("/").filter(Boolean);
    if (parts.length === 0) return this.getTree();
    const dirParts = parts.slice(0, -1);
    const fileName = parts[parts.length - 1];

    // Walk to parent dir (no creation on delete).
    let current = this.root;
    for (const part of dirParts) {
      const next = current.dirs.get(part);
      if (!next) return this.getTree();
      current = next;
    }

    // If marker file: treat as deleting only marker (no file node), but still try prune.
    if (!this.isDirMarker(normalized)) {
      if (current.files.delete(fileName)) {
        this.rebuildChildren(current);
      }
    }
    this.pruneIfEmpty(current);
    return this.getTree();
  }

  movePath(fromPath: string, toPath: string) {
    const from = this.normalizePath(fromPath);
    const to = this.normalizePath(toPath);
    if (!from || !to || from === to) return this.getTree();
    this.deletePath(from);
    this.upsertPath(to);
    return this.getTree();
  }

  getTree() {
    return this.root.node.children ?? [];
  }
}

export function createFsTreeModel(options?: Options) {
  return new FsTreeModel(options);
}
