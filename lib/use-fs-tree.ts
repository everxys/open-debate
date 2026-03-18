"use client";

import { useCallback, useRef, useState } from "react";

import { createFsTreeModel, type FsNode } from "@/lib/fs-tree";

type Options = Parameters<typeof createFsTreeModel>[0];

export function useFsTree(options?: Options) {
  const modelRef = useRef<ReturnType<typeof createFsTreeModel> | null>(null);
  if (!modelRef.current) modelRef.current = createFsTreeModel(options);
  const model = modelRef.current;
  const [treeData, setTreeData] = useState<FsNode[]>(() => model.getTree());

  const sync = useCallback(
    (paths: string[]) => {
      model.sync(paths);
      setTreeData(model.getTree());
    },
    [model]
  );

  const reset = useCallback(
    (paths: string[]) => {
      model.reset(paths);
      setTreeData(model.getTree());
    },
    [model]
  );

  const upsertPath = useCallback(
    (path: string) => {
      model.upsertPath(path);
      setTreeData(model.getTree());
    },
    [model]
  );

  const deletePath = useCallback(
    (path: string) => {
      model.deletePath(path);
      setTreeData(model.getTree());
    },
    [model]
  );

  const deletePaths = useCallback(
    (paths: string[]) => {
      for (const path of paths) model.deletePath(path);
      setTreeData(model.getTree());
    },
    [model]
  );

  const movePath = useCallback(
    (fromPath: string, toPath: string) => {
      model.movePath(fromPath, toPath);
      setTreeData(model.getTree());
    },
    [model]
  );

  return { model, treeData, sync, reset, upsertPath, deletePath, deletePaths, movePath };
}
