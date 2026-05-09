import { createAgentCategory, listAgentCategories } from "@/lib/agent-categories";
import { apiRoute, jsonSuccess, readJsonBody } from "@/lib/http";

export const dynamic = "force-dynamic";

export const GET = apiRoute({ route: "/api/agents/categories", method: "GET" }, async () => {
  const categories = await listAgentCategories();
  return jsonSuccess(categories);
});

export const POST = apiRoute({ route: "/api/agents/categories", method: "POST" }, async ({ request }) => {
  const body = await readJsonBody(request);
  const category = await createAgentCategory(body);
  return jsonSuccess(category, 201);
});
