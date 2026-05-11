import { getOptionalUser } from "@/lib/auth";
import {
  getBackgroundJobDashboard,
  normalizeJobSourceFilter,
  normalizeJobStatusFilter,
  parseJobLimit,
  rerunBackgroundJob,
  type BackgroundJobSource
} from "@/lib/job-dashboard";
import { apiRoute, AppError, jsonSuccess, readJsonBody } from "@/lib/http";

export const runtime = "nodejs";

async function requireAdminApi() {
  const user = await getOptionalUser();
  if (!user) throw new AppError("AUTH_REQUIRED", 401, "Authentication required");
  if (user.role !== "admin") throw new AppError("FORBIDDEN", 403, "Admin required");
}

function parseSource(value: unknown): BackgroundJobSource {
  if (value === "summary" || value === "resume") return value;
  throw new AppError("VALIDATION_ERROR", 400, "source must be summary or resume");
}

export const GET = apiRoute({ route: "/api/system/jobs", method: "GET" }, async ({ request }) => {
  await requireAdminApi();
  const url = new URL(request.url);
  const source = normalizeJobSourceFilter(url.searchParams.get("source"));
  const status = normalizeJobStatusFilter(url.searchParams.get("status"));
  const limit = parseJobLimit(url.searchParams.get("limit"));
  return jsonSuccess(await getBackgroundJobDashboard({ source, status, limit }));
});

export const POST = apiRoute({ route: "/api/system/jobs", method: "POST" }, async ({ request, setLogMeta }) => {
  await requireAdminApi();
  const body = (await readJsonBody(request, {})) as { action?: unknown; source?: unknown; id?: unknown };
  if (body.action !== "rerun") {
    throw new AppError("VALIDATION_ERROR", 400, "action must be rerun");
  }
  const source = parseSource(body.source);
  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!id) throw new AppError("VALIDATION_ERROR", 400, "id is required");
  setLogMeta({ action: "rerun", source, jobId: id });
  return jsonSuccess(await rerunBackgroundJob(source, id));
});
