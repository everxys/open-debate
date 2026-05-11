import { createFeedback } from "@/lib/feedback";
import { apiRoute, jsonSuccess, readJsonBody } from "@/lib/http";

export const dynamic = "force-dynamic";

export const POST = apiRoute(
  { route: "/api/feedback", method: "POST", requireSession: { message: "Authentication required" } },
  async ({ request, session }) => {
    const body = await readJsonBody(request);
    const feedback = await createFeedback(session!.userId, body);
    return jsonSuccess(feedback, 201);
  }
);
