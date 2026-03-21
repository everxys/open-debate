import { listOpenRouterModels } from "@/lib/openrouter";

export type ModelCatalogSource = "openrouter";

export type CatalogModel = {
  id: string;
  name: string;
  contextLength: number | null;
  maxOutputTokens: number | null;
};

export async function listCatalogModels(source: ModelCatalogSource): Promise<CatalogModel[]> {
  if (source === "openrouter") return listOpenRouterModels();
  return [];
}
