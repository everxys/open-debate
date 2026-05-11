import Link from "next/link";
import type { ButtonHTMLAttributes, ComponentProps } from "react";

import { cx } from "@/components/ui/class-names";

type ButtonVariant = "default" | "primary" | "danger" | "muted";

function buttonVariantClass(variant: ButtonVariant) {
  if (variant === "primary") return "btn-primary";
  if (variant === "danger") return "btn-danger";
  if (variant === "muted") return "btn-muted";
  return "";
}

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  active?: boolean;
};

export function Button({ className, variant = "default", active, type = "button", ...props }: ButtonProps) {
  return (
    <button
      {...props}
      type={type}
      className={cx("btn", buttonVariantClass(variant), active && "btn-active", className)}
    />
  );
}

export type ButtonLinkProps = ComponentProps<typeof Link> & {
  variant?: ButtonVariant;
  active?: boolean;
};

export function ButtonLink({ className, variant = "default", active, ...props }: ButtonLinkProps) {
  return (
    <Link
      {...props}
      className={cx("btn", buttonVariantClass(variant), active && "btn-active", className)}
    />
  );
}
