import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";

import { cx } from "@/components/ui/class-names";

export function TabsBar({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={cx("tabsBar", className)} />;
}

export type TabButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  active?: boolean;
  dirty?: boolean;
  label?: ReactNode;
};

export function TabButton({ active, dirty, label, className, children, type = "button", ...props }: TabButtonProps) {
  return (
    <button {...props} type={type} className={cx("tab", active && "tabActive", className)}>
      {label ? <span className="tabName">{label}</span> : children}
      {dirty ? <span className="tabDirtyDot" aria-hidden="true" /> : null}
    </button>
  );
}
