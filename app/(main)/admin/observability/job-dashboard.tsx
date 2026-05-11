"use client";

import { BackgroundJobDashboard } from "@/components/background-job/dashboard";

export function JobDashboard() {
  return (
    <BackgroundJobDashboard
      endpoint="/api/system/jobs"
      description="统一查看 summary worker、恢复任务和后续批处理任务的运行状态"
      sourceOptions={[
        { value: "summary", label: "Summary Worker" },
        { value: "resume", label: "恢复任务" }
      ]}
    />
  );
}
