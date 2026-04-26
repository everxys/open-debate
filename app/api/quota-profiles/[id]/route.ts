import { deleteQuotaProfile, getQuotaProfileViewById, updateQuotaProfile } from "@/lib/quota-control";
import { apiRoute, jsonSuccess, readJsonBody } from "@/lib/http";

export const dynamic = "force-dynamic";

const routeMeta = ({ params }: { params: { id: string } }) => ({ quotaProfileId: params.id });

export const GET = apiRoute<{ id: string }>(
  { route: "/api/quota-profiles/[id]", method: "GET", logMeta: routeMeta },
  async ({ params }) => {
    const profile = await getQuotaProfileViewById(params.id);
    return jsonSuccess(profile);
  }
);

export const PATCH = apiRoute<{ id: string }>(
  { route: "/api/quota-profiles/[id]", method: "PATCH", logMeta: routeMeta },
  async ({ request, params }) => {
    const body = await readJsonBody(request);
    const profile = await updateQuotaProfile(params.id, body);
    return jsonSuccess(profile);
  }
);

export const DELETE = apiRoute<{ id: string }>(
  { route: "/api/quota-profiles/[id]", method: "DELETE", logMeta: routeMeta },
  async ({ params }) => {
    await deleteQuotaProfile(params.id);
    return jsonSuccess(null);
  }
);
