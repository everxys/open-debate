import type { HTMLAttributes } from "react";

import { cx } from "@/components/ui/class-names";

export type BadgeTone = "default" | "pending" | "running" | "paused" | "completed" | "stopped" | "failed" | "recovering" | "recovered";

export type BadgeProps = HTMLAttributes<HTMLSpanElement> & {
  tone?: BadgeTone;
};

export function Badge({ className, tone = "default", ...props }: BadgeProps) {
  return <span {...props} className={cx("badge", tone !== "default" && `badge-${tone}`, className)} />;
}
