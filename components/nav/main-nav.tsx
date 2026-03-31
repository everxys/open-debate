"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ComponentProps } from "react";

type NavItem = { href: ComponentProps<typeof Link>["href"]; label: string };

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
      <Link
        key={hrefString}
        className={`btn ${active ? "btn-active" : ""}`}
        href={item.href}
        aria-current={active ? "page" : undefined}
      >
        {item.label}
      </Link>
    );
  });
}
