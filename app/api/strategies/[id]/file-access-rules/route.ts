import { createStrategyFileAccessRule, listStrategyFileAccessRules } from "@/lib/strategies";
import { apiRoute, jsonSuccess, readJsonBody } from "@/lib/http";

const routeMeta = ({ params }: { params: { id: string } }) => ({ strategyId: params.id });

export const GET = apiRoute<{ id: string }>(
  { route: "/api/strategies/[id]/file-access-rules", method: "GET", logMeta: routeMeta },
  async ({ params }) => {
    const rules = await listStrategyFileAccessRules(params.id);
    return jsonSuccess(rules);
  }
);

export const POST = apiRoute<{ id: string }>(
  { route: "/api/strategies/[id]/file-access-rules", method: "POST", logMeta: routeMeta },
  async ({ request, params }) => {
    const body = await readJsonBody(request);
    const rule = await createStrategyFileAccessRule(params.id, body);
    return jsonSuccess(rule);
  }
);
