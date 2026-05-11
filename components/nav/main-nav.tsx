"use client";

import { usePathname } from "next/navigation";
import type { ComponentProps } from "react";

import { ButtonLink } from "@/components/ui/button";

type NavItem = { href: ComponentProps<typeof ButtonLink>["href"]; label: string };

/** Check if nav item is active based on current pathname */
function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** Render navigation items with active state highlighting */
export function MainNav({ items }: { items: NavItem[] }) {
  const pathname = usePathname();

  return items.map((item) => {
    const hrefString = typeof item.href === "string" ? item.href : item.href.pathname ?? "";
    const active = isActive(pathname, hrefString);
    return (
      <ButtonLink
        key={hrefString}
        href={item.href}
        active={active}
        aria-current={active ? "page" : undefined}
      >
        {item.label}
      </ButtonLink>
    );
  });
}
