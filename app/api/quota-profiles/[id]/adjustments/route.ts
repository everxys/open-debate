import { adjustQuotaProfile } from "@/lib/quota-control";
import { apiRoute, jsonSuccess, readJsonBody } from "@/lib/http";

export const dynamic = "force-dynamic";

export const POST = apiRoute<{ id: string }>(
  { route: "/api/quota-profiles/[id]/adjustments", method: "POST", logMeta: ({ params }) => ({ quotaProfileId: params.id }) },
  async ({ request, params }) => {
    const body = await readJsonBody(request);
    const profile = await adjustQuotaProfile(params.id, body);
    return jsonSuccess(profile);
  }
);
