import { deleteAgentCategory, updateAgentCategory } from "@/lib/agent-categories";
import { apiRoute, jsonSuccess, readJsonBody } from "@/lib/http";

export const dynamic = "force-dynamic";

const routeMeta = ({ params }: { params: { id: string } }) => ({ agentCategoryId: params.id });

export const PATCH = apiRoute<{ id: string }>(
  { route: "/api/agents/categories/[id]", method: "PATCH", logMeta: routeMeta },
  async ({ request, params }) => {
    const body = await readJsonBody(request);
    const category = await updateAgentCategory(params.id, body);
    return jsonSuccess(category);
  }
);

export const DELETE = apiRoute<{ id: string }>(
  { route: "/api/agents/categories/[id]", method: "DELETE", logMeta: routeMeta },
  async ({ params }) => {
    await deleteAgentCategory(params.id);
    return jsonSuccess(null);
  }
);
