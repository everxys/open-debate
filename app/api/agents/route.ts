import { createAgent, listAgents } from "@/lib/agents";
import { apiRoute, jsonSuccess, readJsonBody } from "@/lib/http";

export const dynamic = "force-dynamic";

export const GET = apiRoute({ route: "/api/agents", method: "GET" }, async () => {
  const agents = await listAgents();
  return jsonSuccess(agents);
});

export const POST = apiRoute({ route: "/api/agents", method: "POST" }, async ({ request }) => {
  const body = await readJsonBody(request);
  const agent = await createAgent(body);
  return jsonSuccess(agent, 201);
});
