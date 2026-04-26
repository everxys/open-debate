import { forkStrategy } from "@/lib/strategies";
import { apiRoute, jsonSuccess } from "@/lib/http";

export const POST = apiRoute<{ id: string }>(
  {
    route: "/api/strategies/[id]/fork",
    method: "POST",
    logMeta: ({ params }) => ({ strategyId: params.id })
  },
  async ({ params }) => {
    const result = await forkStrategy(params.id);
    return jsonSuccess(result, 201);
  }
);
