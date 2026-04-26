import type { Dispatch, SetStateAction } from "react";
import { useEffect, useMemo, useState } from "react";

import { createFsTreeModel, type FsNode, normalizeFsPath } from "@/lib/fs-tree";

export function useDebateAllFilesTree(input: {
  allFilesMetaByVirtualPath: Record<string, unknown>;
  setSelectedAllFileVirtualPaths: Dispatch<SetStateAction<string[]>>;
  setAllFilesSelectionAnchor: Dispatch<SetStateAction<string>>;
}) {
  const { allFilesMetaByVirtualPath, setAllFilesSelectionAnchor, setSelectedAllFileVirtualPaths } = input;
  const allFilesTreeModel = useMemo(
    () =>
      createFsTreeModel({
        normalizePath: normalizeFsPath
      }),
    []
  );
  const [allFilesTree, setAllFilesTree] = useState<FsNode[]>([]);

  useEffect(() => {
    allFilesTreeModel.sync(Object.keys(allFilesMetaByVirtualPath));
    setAllFilesTree(allFilesTreeModel.getTree());
  }, [allFilesMetaByVirtualPath, allFilesTreeModel]);

  const allFilesTreePaths = useMemo(() => {
    const paths = new Set<string>();
    const stack = [...allFilesTree];
    while (stack.length > 0) {
      const node = stack.pop();
      if (!node) continue;
      paths.add(node.path);
      if (node.children?.length) {
        for (const child of node.children) stack.push(child);
      }
    }
    return paths;
  }, [allFilesTree]);

  useEffect(() => {
    setSelectedAllFileVirtualPaths((current) => current.filter((path) => allFilesTreePaths.has(path)));
    setAllFilesSelectionAnchor((current) => (current && allFilesTreePaths.has(current) ? current : ""));
  }, [allFilesTreePaths, setAllFilesSelectionAnchor, setSelectedAllFileVirtualPaths]);

  return { allFilesTree, allFilesTreePaths };
}

export function useEscapeKeyClose(enabled: boolean, onClose: () => void) {
  useEffect(() => {
    if (!enabled) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [enabled, onClose]);
}
