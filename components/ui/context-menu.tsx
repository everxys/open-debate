import type { ButtonHTMLAttributes, HTMLAttributes } from "react";

import { cx } from "@/components/ui/class-names";

export function ContextMenuOverlay({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={cx("contextOverlay", className)} />;
}

export function ContextMenu({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={cx("contextMenu", className)} />;
}

export type ContextMenuItemProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  danger?: boolean;
};

export function ContextMenuItem({ className, danger, type = "button", ...props }: ContextMenuItemProps) {
  return (
    <button
      {...props}
      type={type}
      className={cx("contextMenuItem", danger && "contextMenuDanger", className)}
    />
  );
}
