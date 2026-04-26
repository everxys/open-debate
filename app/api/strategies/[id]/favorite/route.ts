import { favoriteStrategy, unfavoriteStrategy } from "@/lib/strategies";
import { apiRoute, jsonSuccess } from "@/lib/http";

const routeMeta = ({ params }: { params: { id: string } }) => ({ strategyId: params.id });

export const POST = apiRoute<{ id: string }>(
  { route: "/api/strategies/[id]/favorite", method: "POST", logMeta: routeMeta },
  async ({ params }) => {
    const result = await favoriteStrategy(params.id);
    return jsonSuccess(result);
  }
);

export const DELETE = apiRoute<{ id: string }>(
  { route: "/api/strategies/[id]/favorite", method: "DELETE", logMeta: routeMeta },
  async ({ params }) => {
    const result = await unfavoriteStrategy(params.id);
    return jsonSuccess(result);
  }
);
