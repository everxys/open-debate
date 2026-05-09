import { moveAgentsToCategory } from "@/lib/agents";
import { apiRoute, jsonSuccess, readJsonBody } from "@/lib/http";

export const dynamic = "force-dynamic";

export const PATCH = apiRoute({ route: "/api/agents/category-move", method: "PATCH" }, async ({ request }) => {
  const body = await readJsonBody(request);
  const agents = await moveAgentsToCategory(body);
  return jsonSuccess({ agents });
});
