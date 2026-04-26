import { listDebateManagedFileStatuses } from "@/lib/debate-file-status";
import { apiRoute, jsonSuccess } from "@/lib/http";

export const dynamic = "force-dynamic";

export const GET = apiRoute<{ id: string }>(
  {
    route: "/api/debates/[id]/file-statuses",
    method: "GET",
    requireSession: { message: "Authentication required" },
    logMeta: ({ params }) => ({ debateId: params.id })
  },
  async ({ params }) => {
    const data = await listDebateManagedFileStatuses(params.id);
    return jsonSuccess(data);
  }
);
