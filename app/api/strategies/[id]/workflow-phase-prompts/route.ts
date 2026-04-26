import { apiRoute, jsonSuccess, readJsonBody } from "@/lib/http";
import { getStrategyWorkflowPhasePrompts, updateStrategyWorkflowPhasePrompts } from "@/lib/strategies";

const routeMeta = ({ params }: { params: { id: string } }) => ({ strategyId: params.id });

export const GET = apiRoute<{ id: string }>(
  { route: "/api/strategies/[id]/workflow-phase-prompts", method: "GET", logMeta: routeMeta },
  async ({ params }) => {
    const data = await getStrategyWorkflowPhasePrompts(params.id);
    return jsonSuccess(data);
  }
);

export const PUT = apiRoute<{ id: string }>(
  { route: "/api/strategies/[id]/workflow-phase-prompts", method: "PUT", logMeta: routeMeta },
  async ({ request, params }) => {
    const body = await readJsonBody(request);
    const data = await updateStrategyWorkflowPhasePrompts(params.id, body);
    return jsonSuccess(data);
  }
);
