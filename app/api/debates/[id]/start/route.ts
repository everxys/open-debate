import { startDebate } from "@/lib/debates";
import { apiRoute, jsonSuccess } from "@/lib/http";

export const POST = apiRoute<{ id: string }>(
  { route: "/api/debates/[id]/start", method: "POST", logMeta: ({ params }) => ({ debateId: params.id }) },
  async ({ params }) => {
    const debate = await startDebate(params.id);
    return jsonSuccess(debate);
  }
);
