import { exportAgentsPack } from "@/lib/agents";
import { apiRoute, jsonSuccess } from "@/lib/http";

export const GET = apiRoute<{ id: string }>(
  { route: "/api/agents/[id]/export", method: "GET", logMeta: ({ params }) => ({ agentId: params.id }) },
  async ({ params }) => {
    const pack = await exportAgentsPack({ agentIds: [params.id] });
    return jsonSuccess(pack);
  }
);
