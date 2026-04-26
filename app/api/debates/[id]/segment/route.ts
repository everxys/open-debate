import { startDebateSegment } from "@/lib/debates";
import { apiRoute, jsonSuccess, readJsonBody } from "@/lib/http";

export const POST = apiRoute<{ id: string }>(
  { route: "/api/debates/[id]/segment", method: "POST", logMeta: ({ params }) => ({ debateId: params.id }) },
  async ({ request, params }) => {
    const body = await readJsonBody(request, {});
    const result = await startDebateSegment(params.id, body);
    return jsonSuccess(result);
  }
);
