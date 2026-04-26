import { apiRoute, AppError, jsonSuccess, readJsonBody } from "@/lib/http";
import { runPlaygroundChecklistCase } from "@/lib/playground/checklist";
import { PLAYGROUND_TOOL_NAMES, type PlaygroundToolName } from "@/lib/playground/types";

export const dynamic = "force-dynamic";

export const POST = apiRoute(
  { route: "/api/agents/playground/checklist/run", method: "POST" },
  async ({ request }) => {
    const body = (await readJsonBody(request, {})) as { agentId?: unknown; toolId?: unknown };
    const agentId = typeof body.agentId === "string" ? body.agentId.trim() : "";
    const toolId = typeof body.toolId === "string" ? body.toolId.trim() : "";
    if (!agentId || !toolId) {
      throw new AppError("VALIDATION_ERROR", 400, "agentId and toolId are required");
    }
    if (!PLAYGROUND_TOOL_NAMES.includes(toolId as PlaygroundToolName)) {
      throw new AppError("VALIDATION_ERROR", 400, `Unknown toolId: ${toolId}`);
    }
    const result = await runPlaygroundChecklistCase(agentId, toolId as PlaygroundToolName);
    return jsonSuccess(result);
  }
);
