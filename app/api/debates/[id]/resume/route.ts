import { resumeDebate } from "@/lib/debates";
import { apiRoute, jsonSuccess } from "@/lib/http";

export const POST = apiRoute<{ id: string }>(
  { route: "/api/debates/[id]/resume", method: "POST", logMeta: ({ params }) => ({ debateId: params.id }) },
  async ({ params }) => {
    const debate = await resumeDebate(params.id);
    return jsonSuccess(debate);
  }
);
