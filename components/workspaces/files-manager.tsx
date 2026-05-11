"use client";

import { useMemo } from "react";

import { FileWorkspace } from "@/components/file-workspace/file-workspace";
import { createHttpFileWorkspaceAdapter } from "@/components/file-workspace/http-adapter";

export function WorkspaceFilesManager({
  workspaceId,
  readOnly,
  onChanged
}: {
  workspaceId: string;
  readOnly?: boolean;
  onChanged?: () => void;
}) {
  const adapter = useMemo(
    () => createHttpFileWorkspaceAdapter(`/api/workspaces/${workspaceId}/files`),
    [workspaceId]
  );

  return (
    <FileWorkspace
      adapter={adapter}
      resetKey={workspaceId}
      layout="grid"
      readOnly={readOnly}
      onChanged={onChanged}
      treeTitle="私有文件"
      treeEmptyText="暂无私有文件"
      editorTitle="文件编辑"
      editorEmptyPathText="请选择一个文件"
      createFilePrompt="新建文件：输入相对路径（例如 workspace/ideas/raw-idea-bank.md）"
      createFolderPrompt="新建文件夹：输入相对路径（例如 workspace/ideas 或 workspace/reference）"
    />
  );
}
