import { testAgentConfig } from "@/lib/agents";
import { apiRoute, jsonSuccess, readJsonBody } from "@/lib/http";

export const dynamic = "force-dynamic";

export const POST = apiRoute({ route: "/api/agents/test-config", method: "POST" }, async ({ request }) => {
  const body = await readJsonBody(request);
  const result = await testAgentConfig(body);
  return jsonSuccess(result);
});
