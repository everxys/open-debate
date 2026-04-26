import { repairDebate } from "@/lib/debates";
import { apiRoute, jsonSuccess } from "@/lib/http";

export const POST = apiRoute<{ id: string }>(
  { route: "/api/debates/[id]/repair", method: "POST", logMeta: ({ params }) => ({ debateId: params.id }) },
  async ({ params }) => {
    const debate = await repairDebate(params.id);
    return jsonSuccess(debate);
  }
);
