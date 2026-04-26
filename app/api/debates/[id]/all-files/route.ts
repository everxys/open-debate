import { listDebateAllFiles } from "@/lib/debates";
import { apiRoute, jsonSuccess } from "@/lib/http";

export const GET = apiRoute<{ id: string }>(
  { route: "/api/debates/[id]/all-files", method: "GET", logMeta: ({ params }) => ({ debateId: params.id }) },
  async ({ params }) => {
    const entries = await listDebateAllFiles(params.id);
    return jsonSuccess(entries);
  }
);
