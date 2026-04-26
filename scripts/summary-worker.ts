import { loadEnvConfig } from "@next/env";

import { writeServerLog } from "../lib/logger/server";

loadEnvConfig(process.cwd(), process.env.NODE_ENV !== "production");
process.env.OPEN_DEBATE_DISABLE_EMBEDDED_SUMMARY_WORKER = "1";

async function main() {
  const workerModule = await import("../lib/summary-job-worker");
  const workerApi = ((workerModule as any).default ?? workerModule) as typeof import("../lib/summary-job-worker");
  const { runSummaryJobWorkerOnce, startSummaryJobWorkerLoop, stopSummaryJobWorkerLoop } = workerApi;

  if (process.argv.includes("--once")) {
    const result = await runSummaryJobWorkerOnce({ reason: "standalone_worker_once", mode: "standalone" });
    await writeServerLog("info", "summary-worker.cli", "summary worker tick completed", { result });
    process.exit(0);
  }

  const started = await startSummaryJobWorkerLoop({
    reason: "standalone_worker",
    mode: "standalone",
    unrefTimer: false
  });

  await writeServerLog("info", "summary-worker.cli", "summary worker started", { started });

  async function shutdown(signal: string) {
    await writeServerLog("info", "summary-worker.cli", "summary worker stopping", { signal });
    await stopSummaryJobWorkerLoop();
    process.exit(0);
  }

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await new Promise(() => {});
}

void main().catch((error) => {
  void (async () => {
    await writeServerLog("error", "summary-worker.cli", "summary worker crashed", { error });
    process.exit(1);
  })();
});
