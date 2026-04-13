import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd(), process.env.NODE_ENV !== "production");
process.env.OPEN_DEBATE_DISABLE_EMBEDDED_SUMMARY_WORKER = "1";

async function main() {
  const workerModule = await import("../lib/summary-job-worker");
  const workerApi = ((workerModule as any).default ?? workerModule) as typeof import("../lib/summary-job-worker");
  const { runSummaryJobWorkerOnce, startSummaryJobWorkerLoop, stopSummaryJobWorkerLoop } = workerApi;

  if (process.argv.includes("--once")) {
    const result = await runSummaryJobWorkerOnce({ reason: "standalone_worker_once", mode: "standalone" });
    console.log("summary worker tick completed", result);
    process.exit(0);
  }

  const started = await startSummaryJobWorkerLoop({
    reason: "standalone_worker",
    mode: "standalone",
    unrefTimer: false
  });

  console.log("summary worker started", started);

  async function shutdown(signal: string) {
    console.log(`summary worker stopping: ${signal}`);
    await stopSummaryJobWorkerLoop();
    process.exit(0);
  }

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await new Promise(() => {});
}

void main().catch((error) => {
  console.error("summary worker crashed", error);
  process.exit(1);
});
