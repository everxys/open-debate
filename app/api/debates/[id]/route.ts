import {
  deleteDebate,
  getDebateDetail,
  ignoreDebateRuntimeError,
  updateDebateAutoRecover,
  updateDebateQuestion,
  updateDebateSharing
} from "@/lib/debates";
import { apiRoute, jsonSuccess, readJsonBody } from "@/lib/http";

const routeMeta = ({ params }: { params: { id: string } }) => ({ debateId: params.id });

export const GET = apiRoute<{ id: string }>(
  { route: "/api/debates/[id]", method: "GET", logMeta: routeMeta },
  async ({ params }) => {
    const debate = await getDebateDetail(params.id);
    return jsonSuccess(debate);
  }
);

export const PATCH = apiRoute<{ id: string }>(
  { route: "/api/debates/[id]", method: "PATCH", logMeta: routeMeta },
  async ({ request, params, setLogMeta }) => {
    setLogMeta({ action: "update_sharing" });
    const body = await readJsonBody(request);
    const patchAction =
      body && typeof body === "object" && "question" in body
        ? "update_question"
        : body && typeof body === "object" && "ignoreRuntimeError" in body
          ? "ignore_runtime_error"
          : body && typeof body === "object" && "autoRecoverOnceOnFailed" in body
            ? "update_auto_recover"
            : "update_sharing";
    setLogMeta({ action: patchAction });
    const debate =
      body && typeof body === "object" && "question" in body
        ? await updateDebateQuestion(params.id, body)
        : body && typeof body === "object" && "ignoreRuntimeError" in body
          ? await ignoreDebateRuntimeError(params.id, body)
          : body && typeof body === "object" && "autoRecoverOnceOnFailed" in body
            ? await updateDebateAutoRecover(params.id, body)
          : await updateDebateSharing(params.id, body);
    return jsonSuccess(debate);
  }
);

export const DELETE = apiRoute<{ id: string }>(
  { route: "/api/debates/[id]", method: "DELETE", logMeta: routeMeta },
  async ({ params }) => {
    const result = await deleteDebate(params.id);
    return jsonSuccess(result);
  }
);
