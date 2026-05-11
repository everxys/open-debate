"use client";

import { useMemo, useRef } from "react";

import type {
  FileWorkspaceAdapter,
  FileWorkspaceFileWithContent
} from "@/components/file-workspace/file-workspace";
import { FileWorkspace } from "@/components/file-workspace/file-workspace";
import { normalizeFsPath } from "@/lib/fs-tree";

export type DraftStrategyRoleFile = {
  path: string;
  content: string;
  createdAt: string;
  updatedAt: string;
};

function sortFiles(files: DraftStrategyRoleFile[]) {
  return [...files].sort((a, b) => a.path.localeCompare(b.path));
}

function timestamp() {
  return new Date().toISOString();
}

export function DraftRoleFilesManagerColumns({
  files,
  onFilesChange,
  readOnly
}: {
  files: DraftStrategyRoleFile[];
  onFilesChange: (next: DraftStrategyRoleFile[]) => void;
  readOnly?: boolean;
}) {
  const filesRef = useRef(files);
  filesRef.current = files;

  const adapter = useMemo<FileWorkspaceAdapter>(
    () => ({
      async list() {
        return filesRef.current;
      },
      async read(path: string) {
        const file = filesRef.current.find((item) => item.path === path);
        if (!file) throw new Error("文件不存在");
        return file;
      },
      async upsert(path: string, content: string) {
        const now = timestamp();
        const current = filesRef.current;
        const existing = current.find((item) => item.path === path);
        const updated: FileWorkspaceFileWithContent = {
          path,
          content,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now
        };
        const next = sortFiles([
          ...current.filter((item) => item.path !== path),
          updated as DraftStrategyRoleFile
        ]);
        filesRef.current = next;
        onFilesChange(next);
        return updated;
      },
      async deleteFile(path: string) {
        const next = filesRef.current.filter((item) => item.path !== path);
        filesRef.current = next;
        onFilesChange(next);
      },
      async deleteDirectory(prefix: string) {
        const normalizedPrefix = prefix ? `${prefix.replace(/\/+$/, "")}/` : "";
        const next = filesRef.current.filter((item) => !item.path.startsWith(normalizedPrefix));
        filesRef.current = next;
        onFilesChange(next);
      },
      async moveFile(fromPath: string, toPath: string) {
        const from = normalizeFsPath(fromPath);
        const to = normalizeFsPath(toPath);
        const current = filesRef.current;
        const existing = current.find((item) => item.path === from);
        if (!existing) throw new Error("文件不存在");
        if (current.some((item) => item.path === to)) throw new Error("目标路径已存在");
        const moved = { ...existing, path: to, updatedAt: timestamp() };
        const next = sortFiles(current.map((item) => (item.path === from ? moved : item)));
        filesRef.current = next;
        onFilesChange(next);
        return moved;
      }
    }),
    [onFilesChange]
  );

  return (
    <FileWorkspace
      adapter={adapter}
      resetKey="draft-role-files"
      readOnly={readOnly}
      treeTitle="目录"
      editorTitle="编辑"
      treeHeight="auto"
      editorHeight="auto"
      createFilePrompt="新建文件：输入相对路径（例如 prompts/AGENTS.md）"
      createFolderPrompt="新建文件夹：输入相对路径（例如 prompts 或 prompts/system）"
    />
  );
}
