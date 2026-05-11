import type { HTMLAttributes } from "react";

import { cx } from "@/components/ui/class-names";
import type { ToastState } from "@/components/ui/use-toast";

type Tone = "default" | "success" | "error";

function toneClass(prefix: "alert" | "toast", tone: Tone) {
  if (tone === "success") return `${prefix}-success`;
  if (tone === "error") return `${prefix}-error`;
  return "";
}

export type AlertProps = HTMLAttributes<HTMLDivElement> & {
  tone?: Tone;
};

export function Alert({ className, tone = "default", ...props }: AlertProps) {
  return <div {...props} className={cx("alert", toneClass("alert", tone), className)} />;
}

export type ToastProps = HTMLAttributes<HTMLDivElement> & {
  toast: NonNullable<ToastState>;
};

export function Toast({ className, toast, role = "status", ...props }: ToastProps) {
  return (
    <div
      {...props}
      className={cx("toast", toneClass("toast", toast.type), className)}
      role={role}
      aria-live={props["aria-live"] ?? "polite"}
    >
      {toast.text}
    </div>
  );
}

export function ToastOutlet({ toast }: { toast: ToastState }) {
  return toast ? <Toast toast={toast} /> : null;
}
