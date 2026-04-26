import { createStrategy, listStrategies } from "@/lib/strategies";
import { apiRoute, jsonSuccess, readJsonBody } from "@/lib/http";

export const GET = apiRoute({ route: "/api/strategies", method: "GET" }, async ({ request }) => {
  const url = new URL(request.url);
  const scopeRaw = url.searchParams.get("scope") ?? "mine";
  const scope = scopeRaw === "shared" ? "shared" : "mine";
  const strategies = await listStrategies(scope);
  return jsonSuccess(strategies);
});

export const POST = apiRoute({ route: "/api/strategies", method: "POST" }, async ({ request }) => {
  const body = await readJsonBody(request);
  const strategy = await createStrategy(body);
  return jsonSuccess(strategy, 201);
});
