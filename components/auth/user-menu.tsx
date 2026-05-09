"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import type { UserRole } from "@/lib/roles";

/** Extract avatar initial from email */
function getAvatarInitial(email: string): string {
  const value = email.trim();
  return value ? value.slice(0, 1).toUpperCase() : "?";
}

/** User dropdown menu with avatar, settings links, and logout */
export function UserMenu(props: { email: string; role: UserRole }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const avatar = useMemo(() => getAvatarInitial(props.email), [props.email]);

  // Close menu on outside click or Escape key
  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      const el = rootRef.current;
      if (el && event.target instanceof Node && !el.contains(event.target)) setOpen(false);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const handleLogout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  };

  return (
    <div className="userMenu" ref={rootRef}>
      <button
        className="userMenuTrigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        title={props.email}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="userAvatar" aria-hidden="true">{avatar}</span>
      </button>

      {open && (
        <div className="userMenuPanel" role="menu" id={menuId}>
          <div className="userMenuHeader">
            <div className="userMenuEmail">{props.email}</div>
            <div className="hint">{props.role === "admin" ? "管理员" : "普通用户"}</div>
          </div>

          <div className="userMenuItems">
            <Link className="userMenuItem" role="menuitem" href="/settings/security">安全管理</Link>
            {props.role === "admin" && (
              <Link className="userMenuItem" role="menuitem" href="/admin/observability">监控面板</Link>
            )}
            <button className="userMenuItem userMenuDanger" role="menuitem" onClick={handleLogout}>退出</button>
          </div>
        </div>
      )}
    </div>
  );
}
