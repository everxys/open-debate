import { createDebateFromWorkspace } from "@/lib/workspaces";
import { apiRoute, jsonSuccess, readJsonBody } from "@/lib/http";

export const POST = apiRoute<{ id: string }>(
  {
    route: "/api/workspaces/[id]/create-debate",
    method: "POST",
    logMeta: ({ params }) => ({ workspaceId: params.id })
  },
  async ({ request, params }) => {
    const body = await readJsonBody(request, {});
    const debate = await createDebateFromWorkspace(params.id, body);
    return jsonSuccess(debate, 201);
  }
);
