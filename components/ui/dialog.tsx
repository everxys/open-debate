import type { CSSProperties, HTMLAttributes, ReactNode } from "react";

import { cx } from "@/components/ui/class-names";

const DEFAULT_OVERLAY_STYLE: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(15, 23, 42, 0.45)",
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "center",
  padding: 24,
  zIndex: 1000
};

export type DialogProps = HTMLAttributes<HTMLDivElement> & {
  onClose?: () => void;
  children: ReactNode;
};

export function Dialog({ className, onClose, style, children, ...props }: DialogProps) {
  return (
    <div
      {...props}
      className={className}
      role="dialog"
      aria-modal="true"
      style={{ ...DEFAULT_OVERLAY_STYLE, ...style }}
      onClick={onClose}
    >
      {children}
    </div>
  );
}

export function DialogPanel({ className, onClick, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...props}
      className={cx("panel stack", className)}
      onClick={(event) => {
        event.stopPropagation();
        onClick?.(event);
      }}
    />
  );
}
