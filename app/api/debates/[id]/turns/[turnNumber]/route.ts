import { getDebateTurnDetail } from "@/lib/debates";
import { apiRoute, jsonSuccess } from "@/lib/http";

export const GET = apiRoute<{ id: string; turnNumber: string }>(
  {
    route: "/api/debates/[id]/turns/[turnNumber]",
    method: "GET",
    logMeta: ({ params }) => ({ debateId: params.id, turnNumber: params.turnNumber })
  },
  async ({ params }) => {
    const safeTurnNumber = Number(params.turnNumber);
    const detail = await getDebateTurnDetail(params.id, safeTurnNumber);
    return jsonSuccess(detail);
  }
);
