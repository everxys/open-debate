import { apiRoute, jsonSuccess, readJsonBody } from "@/lib/http";
import { runPlaygroundSession } from "@/lib/playground/session";
import { playgroundRunRequestSchema } from "@/lib/playground/types";

export const dynamic = "force-dynamic";

export const POST = apiRoute(
  { route: "/api/agents/playground", method: "POST" },
  async ({ request }) => {
    const body = playgroundRunRequestSchema.parse(await readJsonBody(request, {}));
    const result = await runPlaygroundSession(body);
    return jsonSuccess(result);
  }
);
