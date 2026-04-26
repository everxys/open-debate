import { deleteStrategy, getStrategyDetail, updateStrategy } from "@/lib/strategies";
import { apiRoute, jsonSuccess, readJsonBody } from "@/lib/http";

const routeMeta = ({ params }: { params: { id: string } }) => ({ strategyId: params.id });

export const GET = apiRoute<{ id: string }>(
  { route: "/api/strategies/[id]", method: "GET", logMeta: routeMeta },
  async ({ params }) => {
    const strategy = await getStrategyDetail(params.id);
    return jsonSuccess(strategy);
  }
);

export const PATCH = apiRoute<{ id: string }>(
  { route: "/api/strategies/[id]", method: "PATCH", logMeta: routeMeta },
  async ({ request, params }) => {
    const body = await readJsonBody(request);
    const strategy = await updateStrategy(params.id, body);
    return jsonSuccess(strategy);
  }
);

export const DELETE = apiRoute<{ id: string }>(
  { route: "/api/strategies/[id]", method: "DELETE", logMeta: routeMeta },
  async ({ params }) => {
    await deleteStrategy(params.id);
    return jsonSuccess(null);
  }
);
