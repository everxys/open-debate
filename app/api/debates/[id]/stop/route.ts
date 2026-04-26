import { stopDebate } from "@/lib/debates";
import { apiRoute, jsonSuccess } from "@/lib/http";

export const POST = apiRoute<{ id: string }>(
  { route: "/api/debates/[id]/stop", method: "POST", logMeta: ({ params }) => ({ debateId: params.id }) },
  async ({ params }) => {
    const debate = await stopDebate(params.id, "stopped by user");
    return jsonSuccess(debate);
  }
);
