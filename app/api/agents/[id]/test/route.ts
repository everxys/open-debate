import { testAgentConnection, testAgentConnectionDebug } from "@/lib/agents";
import { apiRoute, jsonSuccess } from "@/lib/http";

export const dynamic = "force-dynamic";

export const POST = apiRoute<{ id: string }>(
  { route: "/api/agents/[id]/test", method: "POST", logMeta: ({ params }) => ({ agentId: params.id }) },
  async ({ request, params, setLogMeta }) => {
    const url = new URL(request.url);
    const debug = url.searchParams.get("debug") === "1";
    if (debug) setLogMeta({ debug: true });
    const result = debug ? await testAgentConnectionDebug(params.id) : await testAgentConnection(params.id);
    return jsonSuccess(result);
  }
);
