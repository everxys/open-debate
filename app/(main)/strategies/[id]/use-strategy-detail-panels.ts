import { useCallback, useEffect, useState } from "react";

import type { MountedStrategyPanels, StrategyFileAccessRule, StrategyPanel } from "./strategy-detail-types";
import { normalizeStrategyFileAccessRules, readPayload } from "./strategy-detail-utils";

export function useMountedStrategyPanels(strategyPanel: StrategyPanel) {
  const [mountedPanels, setMountedPanels] = useState<MountedStrategyPanels>({
    shared: true,
    roleFiles: false,
    roleEditor: false,
    phaseUnlock: false
  });

  useEffect(() => {
    setMountedPanels((current) => {
      if (strategyPanel === "shared" && current.shared) return current;
      if (strategyPanel === "roleFiles" && current.roleFiles) return current;
      if (strategyPanel === "roleEditor" && current.roleEditor) return current;
      if (strategyPanel === "phaseUnlock" && current.phaseUnlock) return current;
      return {
        shared: current.shared || strategyPanel === "shared",
        roleFiles: current.roleFiles || strategyPanel === "roleFiles",
        roleEditor: current.roleEditor || strategyPanel === "roleEditor",
        phaseUnlock: current.phaseUnlock || strategyPanel === "phaseUnlock"
      };
    });
  }, [strategyPanel]);

  return mountedPanels;
}

export function useStrategyFileAccessRules(input: {
  strategyId: string;
  showToast: (type: "success" | "error", text: string) => void;
}) {
  const { strategyId, showToast } = input;
  const [fileAccessRules, setFileAccessRules] = useState<StrategyFileAccessRule[]>([]);
  const [fileAccessRulesLoading, setFileAccessRulesLoading] = useState(false);

  const refreshFileAccessRules = useCallback(async () => {
    if (!strategyId) return;
    setFileAccessRulesLoading(true);
    try {
      const response = await fetch(`/api/strategies/${strategyId}/file-access-rules`, { cache: "no-store" });
      const payload = await readPayload(response);
      if (!response.ok) {
        showToast("error", payload.error?.message ?? "加载文件读取规则失败");
        return;
      }
      setFileAccessRules(normalizeStrategyFileAccessRules(payload.data));
    } finally {
      setFileAccessRulesLoading(false);
    }
  }, [showToast, strategyId]);

  return {
    fileAccessRules,
    setFileAccessRules,
    fileAccessRulesLoading,
    refreshFileAccessRules
  };
}
