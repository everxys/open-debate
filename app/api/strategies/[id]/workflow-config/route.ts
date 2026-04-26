import { apiRoute, jsonSuccess, readJsonBody } from "@/lib/http";
import { getStrategyWorkflowConfig, updateStrategyWorkflowConfig } from "@/lib/strategies";

const routeMeta = ({ params }: { params: { id: string } }) => ({ strategyId: params.id });

export const GET = apiRoute<{ id: string }>(
  { route: "/api/strategies/[id]/workflow-config", method: "GET", logMeta: routeMeta },
  async ({ params }) => {
    const data = await getStrategyWorkflowConfig(params.id);
    return jsonSuccess(data);
  }
);

export const PUT = apiRoute<{ id: string }>(
  { route: "/api/strategies/[id]/workflow-config", method: "PUT", logMeta: routeMeta },
  async ({ request, params }) => {
    const body = await readJsonBody(request);
    const data = await updateStrategyWorkflowConfig(params.id, body);
    return jsonSuccess(data);
  }
);
