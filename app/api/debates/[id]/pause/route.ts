import { pauseDebate } from "@/lib/debates";
import { apiRoute, jsonSuccess } from "@/lib/http";

export const POST = apiRoute<{ id: string }>(
  { route: "/api/debates/[id]/pause", method: "POST", logMeta: ({ params }) => ({ debateId: params.id }) },
  async ({ params }) => {
    const debate = await pauseDebate(params.id);
    return jsonSuccess(debate);
  }
);
