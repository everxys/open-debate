import { clearPlaygroundChecklist, listPlaygroundChecklist } from "@/lib/playground/checklist";
import { apiRoute, AppError, jsonSuccess } from "@/lib/http";

export const dynamic = "force-dynamic";

export const GET = apiRoute(
  { route: "/api/agents/playground/checklist", method: "GET" },
  async ({ request }) => {
    const url = new URL(request.url);
    const agentId = url.searchParams.get("agentId")?.trim() ?? "";
    if (!agentId) {
      throw new AppError("VALIDATION_ERROR", 400, "agentId is required");
    }
    const result = await listPlaygroundChecklist(agentId);
    return jsonSuccess(result);
  }
);

export const DELETE = apiRoute(
  { route: "/api/agents/playground/checklist", method: "DELETE" },
  async ({ request }) => {
    const url = new URL(request.url);
    const agentId = url.searchParams.get("agentId")?.trim() ?? "";
    if (!agentId) {
      throw new AppError("VALIDATION_ERROR", 400, "agentId is required");
    }
    await clearPlaygroundChecklist(agentId);
    return jsonSuccess(null);
  }
);
