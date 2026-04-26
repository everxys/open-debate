import { apiRoute, jsonSuccess, readJsonBody } from "@/lib/http";
import { getRetrievalConfig, updateRetrievalConfig } from "@/lib/retrieval";

export const GET = apiRoute({ route: "/api/retrieval-config", method: "GET" }, async () => {
  const data = await getRetrievalConfig();
  return jsonSuccess(data);
});

export const PATCH = apiRoute({ route: "/api/retrieval-config", method: "PATCH" }, async ({ request }) => {
  const body = await readJsonBody(request);
  const data = await updateRetrievalConfig(body);
  return jsonSuccess(data);
});
