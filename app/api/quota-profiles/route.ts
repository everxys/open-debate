import { createQuotaProfile, listQuotaProfiles } from "@/lib/quota-control";
import { apiRoute, jsonSuccess, readJsonBody } from "@/lib/http";

export const dynamic = "force-dynamic";

export const GET = apiRoute({ route: "/api/quota-profiles", method: "GET" }, async () => {
  const profiles = await listQuotaProfiles();
  return jsonSuccess(profiles);
});

export const POST = apiRoute({ route: "/api/quota-profiles", method: "POST" }, async ({ request }) => {
  const body = await readJsonBody(request);
  const profile = await createQuotaProfile(body);
  return jsonSuccess(profile, 201);
});
