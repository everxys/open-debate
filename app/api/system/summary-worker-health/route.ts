import { getOptionalUser } from "@/lib/auth";
import { getBackgroundJobWorkerSnapshot } from "@/lib/job-dashboard";
import { AppError, toErrorResponse } from "@/lib/http";

export const runtime = "nodejs";

export async function GET() {
  try {
    const user = await getOptionalUser();
    if (!user) throw new AppError("AUTH_REQUIRED", 401, "Authentication required");
    if (user.role !== "admin") throw new AppError("FORBIDDEN", 403, "Admin required");
    const snapshot = await getBackgroundJobWorkerSnapshot();
    return Response.json({ success: true, data: snapshot });
  } catch (error) {
    return toErrorResponse(error);
  }
}
