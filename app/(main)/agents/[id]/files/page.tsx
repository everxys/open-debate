"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { FileWorkspace } from "@/components/file-workspace/file-workspace";
import { createHttpFileWorkspaceAdapter } from "@/components/file-workspace/http-adapter";

type Agent = {
  id: string;
  name: string;
  provider: string;
  model: string;
  baseUrl: string;
};

export default function AgentFilesPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const [agent, setAgent] = useState<Agent | null>(null);
  const [agentError, setAgentError] = useState("");

  const adapter = useMemo(() => createHttpFileWorkspaceAdapter(`/api/agents/${id}/files`), [id]);

  useEffect(() => {
    let cancelled = false;
    async function loadAgent() {
      if (!id) return;
      setAgentError("");
      try {
        const response = await fetch(`/api/agents/${id}`, { cache: "no-store" });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(payload.error?.message ?? "加载失败");
        }
        if (!cancelled) setAgent(payload.data as Agent);
      } catch (error) {
        if (!cancelled) setAgentError(error instanceof Error ? error.message : "加载失败");
      }
    }
    void loadAgent();
    return () => {
      cancelled = true;
    };
  }, [id]);

  return (
    <FileWorkspace
      adapter={adapter}
      resetKey={id}
      layout="grid"
      treeTitle="目录"
      editorTitle="编辑"
      createFilePrompt="新建文件：输入相对路径（例如 prompts/AGENTS.md）"
      createFolderPrompt="新建文件夹：输入相对路径（例如 prompts 或 prompts/system）"
      sidebarHeader={
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div>
            <h2 style={{ margin: 0 }}>文件管理</h2>
            <div className="muted">
              {agent ? (
                <>
                  {agent.name} · {agent.provider} · {agent.model}
                </>
              ) : agentError ? (
                agentError
              ) : (
                "加载中..."
              )}
            </div>
          </div>
          <Link className="btn" href="/agents">
            返回
          </Link>
        </div>
      }
    />
  );
}
