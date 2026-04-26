import { deleteStrategyFileAccessRule, updateStrategyFileAccessRule } from "@/lib/strategies";
import { apiRoute, jsonSuccess, readJsonBody } from "@/lib/http";

const routeMeta = ({ params }: { params: { id: string; ruleId: string } }) => ({
  strategyId: params.id,
  ruleId: params.ruleId
});

export const PATCH = apiRoute<{ id: string; ruleId: string }>(
  { route: "/api/strategies/[id]/file-access-rules/[ruleId]", method: "PATCH", logMeta: routeMeta },
  async ({ request, params }) => {
    const body = await readJsonBody(request);
    const rule = await updateStrategyFileAccessRule(params.id, params.ruleId, body);
    return jsonSuccess(rule);
  }
);

export const DELETE = apiRoute<{ id: string; ruleId: string }>(
  { route: "/api/strategies/[id]/file-access-rules/[ruleId]", method: "DELETE", logMeta: routeMeta },
  async ({ params }) => {
    await deleteStrategyFileAccessRule(params.id, params.ruleId);
    return jsonSuccess({ deleted: 1 });
  }
);
