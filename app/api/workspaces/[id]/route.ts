import { getWorkspaceDetail, updateWorkspace } from "@/lib/workspaces";
import { apiRoute, jsonSuccess, readJsonBody } from "@/lib/http";

const routeMeta = ({ params }: { params: { id: string } }) => ({ workspaceId: params.id });

export const GET = apiRoute<{ id: string }>(
  { route: "/api/workspaces/[id]", method: "GET", logMeta: routeMeta },
  async ({ params }) => {
    const item = await getWorkspaceDetail(params.id);
    return jsonSuccess(item);
  }
);

export const PATCH = apiRoute<{ id: string }>(
  { route: "/api/workspaces/[id]", method: "PATCH", logMeta: routeMeta },
  async ({ request, params }) => {
    const body = await readJsonBody(request);
    const item = await updateWorkspace(params.id, body);
    return jsonSuccess(item);
  }
);
