import { duplicateAgent } from "@/lib/agents";
import { apiRoute, jsonSuccess } from "@/lib/http";

export const dynamic = "force-dynamic";

export const POST = apiRoute<{ id: string }>(
  { route: "/api/agents/[id]/duplicate", method: "POST", logMeta: ({ params }) => ({ agentId: params.id }) },
  async ({ params }) => {
    const created = await duplicateAgent(params.id);
    return jsonSuccess(created, 201);
  }
);
