import { exportAgentsPack } from "@/lib/agents";
import { apiRoute, jsonSuccess, readJsonBody } from "@/lib/http";

export const dynamic = "force-dynamic";

export const POST = apiRoute({ route: "/api/agents/export", method: "POST" }, async ({ request }) => {
  const body = await readJsonBody(request);
  const pack = await exportAgentsPack(body);
  return jsonSuccess(pack);
});
