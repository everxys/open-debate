import { importAgentsPack } from "@/lib/agents";
import { apiRoute, jsonSuccess, readJsonBody } from "@/lib/http";

export const dynamic = "force-dynamic";

export const POST = apiRoute({ route: "/api/agents/import", method: "POST" }, async ({ request }) => {
  const body = await readJsonBody(request);
  const agents = await importAgentsPack(body);
  return jsonSuccess(agents, 201);
});
