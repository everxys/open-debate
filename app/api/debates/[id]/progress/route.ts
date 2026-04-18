import { query } from "@/lib/db";
import { getDebateLiveProgress } from "@/lib/debate-live";
import { toErrorResponse } from "@/lib/http";
import { readSession } from "@/lib/session";
import { getSummaryWorkerHealthSnapshot, listActiveDebateSummaryJobs, toDebateSummaryJobLiveView } from "@/lib/summary-jobs";

export const runtime = "nodejs";

function shouldPreferLiveJob(
  dbJob: ReturnType<typeof toDebateSummaryJobLiveView> | undefined,
  liveJob: ReturnType<typeof toDebateSummaryJobLiveView>
) {
  if (!dbJob) return true;
  if ((dbJob.leaseState === "stale" || dbJob.leaseState === "recovering") && dbJob.status === liveJob.status) {
    return false;
  }
  return liveJob.updatedAt > dbJob.updatedAt;
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const session = await readSession();
    if (!session) {
      return new Response(JSON.stringify({ success: false, error: { code: "AUTH_REQUIRED" } }), {
        status: 401,
        headers: { "Content-Type": "application/json" }
      });
    }

    const { id } = await context.params;
    const ownership = await query<{ user_id: string; is_shared: boolean }>(
      "select user_id, is_shared from debates where id = $1",
      [id]
    );
    if ((ownership.rowCount ?? 0) !== 1) {
      return new Response(JSON.stringify({ success: false, error: { code: "NOT_FOUND" } }), {
        status: 404,
        headers: { "Content-Type": "application/json" }
      });
    }
    const row = ownership.rows[0];
    if (String(row.user_id) !== session.userId && !Boolean(row.is_shared)) {
      return new Response(JSON.stringify({ success: false, error: { code: "NOT_FOUND" } }), {
        status: 404,
        headers: { "Content-Type": "application/json" }
      });
    }

    const live = getDebateLiveProgress(id);
    const dbJobs = await listActiveDebateSummaryJobs(id).catch(() => []);
    const mergedJobs = new Map<string, ReturnType<typeof toDebateSummaryJobLiveView>>();
    for (const job of dbJobs) {
      mergedJobs.set(job.jobKey, toDebateSummaryJobLiveView(job));
    }
    for (const job of live.summaryJobs) {
      const current = mergedJobs.get(job.key);
      if (shouldPreferLiveJob(current, job)) mergedJobs.set(job.key, job);
    }
    const workerHealth = await getSummaryWorkerHealthSnapshot().catch(() => ({ workers: [], queue: [] }));

    return new Response(JSON.stringify({ success: true, data: { progress: live.progress, summaryJobs: [...mergedJobs.values()], workerHealth } }), {
      headers: { "Content-Type": "application/json" }
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
