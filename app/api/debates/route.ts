import { createDebate, listDebates } from "@/lib/debates";
import { apiRoute, jsonSuccess, readJsonBody } from "@/lib/http";

export const GET = apiRoute({ route: "/api/debates", method: "GET" }, async ({ request }) => {
  const url = new URL(request.url);
  const scope = url.searchParams.get("scope") === "shared" ? "shared" : "mine";
  const debates = await listDebates(scope);
  return jsonSuccess(debates);
});

export const POST = apiRoute({ route: "/api/debates", method: "POST" }, async ({ request }) => {
  const body = await readJsonBody(request);
  const debate = await createDebate(body);
  return jsonSuccess(debate, 201);
});
