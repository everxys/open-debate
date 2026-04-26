import { apiRoute, AppError, jsonSuccess, readJsonBody } from "@/lib/http";
import { runAllPlaygroundChecklistCases } from "@/lib/playground/checklist";
import { PLAYGROUND_CHECKLIST_SUITE_IDS, type PlaygroundChecklistSuiteId } from "@/lib/playground/types";

export const dynamic = "force-dynamic";

export const POST = apiRoute(
  { route: "/api/agents/playground/checklist/run-all", method: "POST" },
  async ({ request }) => {
    const body = (await readJsonBody(request, {})) as { agentId?: unknown; suiteIds?: unknown };
    const agentId = typeof body.agentId === "string" ? body.agentId.trim() : "";
    if (!agentId) {
      throw new AppError("VALIDATION_ERROR", 400, "agentId is required");
    }
    const suiteIds = Array.isArray(body.suiteIds)
      ? body.suiteIds
          .filter((value): value is PlaygroundChecklistSuiteId => typeof value === "string" && PLAYGROUND_CHECKLIST_SUITE_IDS.includes(value as PlaygroundChecklistSuiteId))
      : [];
    const result = await runAllPlaygroundChecklistCases(agentId, suiteIds);
    return jsonSuccess(result);
  }
);
