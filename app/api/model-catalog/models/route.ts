import { listCatalogModels } from "@/lib/model-catalog";
import { apiRoute, jsonSuccess } from "@/lib/http";

export const GET = apiRoute({ route: "/api/model-catalog/models", method: "GET" }, async ({ request, setLogMeta }) => {
  const url = new URL(request.url);
  const source = url.searchParams.get("source") ?? "openrouter";
  setLogMeta({ source });
  if (source !== "openrouter") {
    return jsonSuccess([]);
  }
  const models = await listCatalogModels("openrouter");
  return jsonSuccess(models);
});
