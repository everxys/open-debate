import { getDebateManagedFileInfo } from "@/lib/debate-file-status";
import { apiRoute, AppError, jsonSuccess, readJsonBody } from "@/lib/http";

export const dynamic = "force-dynamic";

type RequestBody =
  | { scope?: "debate"; path?: unknown }
  | { scope?: "agent"; debateAgentId?: unknown; path?: unknown };

export const POST = apiRoute<{ id: string }>(
  {
    route: "/api/debates/[id]/file-info",
    method: "POST",
    requireSession: { message: "Authentication required" },
    logMeta: ({ params }) => ({ debateId: params.id })
  },
  async ({ request, params, setLogMeta }) => {
    const body = await readJsonBody<RequestBody>(request, {});
    const scope = body.scope === "agent" ? "agent" : "debate";
    const path = String(body.path ?? "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
    const debateAgentId =
      scope === "agent" ? String((body as { debateAgentId?: unknown }).debateAgentId ?? "").trim() || null : null;

    setLogMeta({
      scope,
      ...(path ? { path } : {}),
      ...(debateAgentId ? { debateAgentId } : {})
    });

    if (!path) {
      throw new AppError("VALIDATION_ERROR", 400, "File path is required");
    }
    if (scope === "agent" && !debateAgentId) {
      throw new AppError("VALIDATION_ERROR", 400, "debateAgentId is required");
    }

    const data = await getDebateManagedFileInfo({
      debateId: params.id,
      scope,
      path,
      debateAgentId
    });
    return jsonSuccess(data);
  }
);
