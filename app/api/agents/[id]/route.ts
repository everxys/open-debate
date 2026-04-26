import { deleteAgent, getAgentViewById, updateAgent } from "@/lib/agents";
import { apiRoute, jsonSuccess, readJsonBody } from "@/lib/http";

export const dynamic = "force-dynamic";

const routeMeta = ({ params }: { params: { id: string } }) => ({ agentId: params.id });

export const GET = apiRoute<{ id: string }>(
  { route: "/api/agents/[id]", method: "GET", logMeta: routeMeta },
  async ({ params }) => {
    const agent = await getAgentViewById(params.id);
    return jsonSuccess(agent);
  }
);

export const PATCH = apiRoute<{ id: string }>(
  { route: "/api/agents/[id]", method: "PATCH", logMeta: routeMeta },
  async ({ request, params }) => {
    const body = await readJsonBody(request);
    const agent = await updateAgent(params.id, body);
    return jsonSuccess(agent);
  }
);

export const DELETE = apiRoute<{ id: string }>(
  { route: "/api/agents/[id]", method: "DELETE", logMeta: routeMeta },
  async ({ params }) => {
    await deleteAgent(params.id);
    return jsonSuccess(null);
  }
);
