import { apiRoute, jsonSuccess, readJsonBody } from "@/lib/http";
import { testRetrievalConfig } from "@/lib/retrieval";

export const POST = apiRoute({ route: "/api/retrieval-config/test", method: "POST" }, async ({ request }) => {
  const body = await readJsonBody(request);
  const data = await testRetrievalConfig(body);
  return jsonSuccess(data);
});
