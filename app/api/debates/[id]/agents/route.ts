import { appendAgentToDebate } from "@/lib/debates";
import { apiRoute, AppError, jsonSuccess, readJsonBody } from "@/lib/http";

export const POST = apiRoute<{ id: string }>(
  { route: "/api/debates/[id]/agents", method: "POST", logMeta: ({ params }) => ({ debateId: params.id }) },
  async ({ request, params, setLogMeta }) => {
    const body = await readJsonBody<{ agentId?: string }>(request);
    if (body.agentId) setLogMeta({ agentId: body.agentId });
    if (!body.agentId) {
      throw new AppError("VALIDATION_ERROR", 400, "agentId is required");
    }
    const debate = await appendAgentToDebate(params.id, body.agentId);
    return jsonSuccess(debate);
  }
);
