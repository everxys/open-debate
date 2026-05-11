import type { HTMLAttributes, LabelHTMLAttributes, ReactNode } from "react";

import { cx } from "@/components/ui/class-names";

export function Panel({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={cx("panel", className)} />;
}

export function SoftBox({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={cx("softBox", className)} />;
}

export function Stack({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={cx("stack", className)} />;
}

export function Row({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={cx("row", className)} />;
}

export type FieldProps = HTMLAttributes<HTMLDivElement> & {
  label?: ReactNode;
  labelProps?: LabelHTMLAttributes<HTMLLabelElement>;
};

export function Field({ className, label, labelProps, children, ...props }: FieldProps) {
  return (
    <div {...props} className={cx("field", className)}>
      {label ? <label {...labelProps}>{label}</label> : null}
      {children}
    </div>
  );
}
