import { createWorkspace, listWorkspaces } from "@/lib/workspaces";
import { apiRoute, jsonSuccess, readJsonBody } from "@/lib/http";

export const GET = apiRoute({ route: "/api/workspaces", method: "GET" }, async () => {
  const items = await listWorkspaces();
  return jsonSuccess(items);
});

export const POST = apiRoute({ route: "/api/workspaces", method: "POST" }, async ({ request }) => {
  const body = await readJsonBody(request);
  const item = await createWorkspace(body);
  return jsonSuccess(item, 201);
});
