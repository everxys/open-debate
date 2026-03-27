"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import type { UserRole } from "@/lib/roles";

function initials(email: string) {
  const value = email.trim();
  if (!value) return "?";
  return value.slice(0, 1).toUpperCase();
}

export function UserMenu(props: { email: string; role: UserRole }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);

  const avatar = useMemo(() => initials(props.email), [props.email]);

  useEffect(() => {
    function onPointerDown(event: PointerEvent) {
      if (!open) return;
      const el = rootRef.current;
      if (!el) return;
      if (event.target instanceof Node && el.contains(event.target)) return;
      setOpen(false);
    }

    function onKeyDown(event: KeyboardEvent) {
      if (!open) return;
      if (event.key === "Escape") setOpen(false);
    }

    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

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
        <span className="userAvatar" aria-hidden="true">
          {avatar}
        </span>
      </button>

      {open ? (
        <div className="userMenuPanel" role="menu" id={menuId}>
          <div className="userMenuHeader">
            <div className="userMenuEmail">{props.email}</div>
            <div className="hint">{props.role === "admin" ? "管理员" : "普通用户"}</div>
          </div>

          <div className="userMenuItems">
            <Link className="userMenuItem" role="menuitem" href="/settings/security">
              安全管理
            </Link>
            <Link className="userMenuItem" role="menuitem" href="/settings/retrieval">
              检索配置
            </Link>
            {props.role === "admin" ? (
              <Link className="userMenuItem" role="menuitem" href="/admin/observability">
                监控面板
              </Link>
            ) : null}
            <button className="userMenuItem userMenuDanger" role="menuitem" onClick={() => void logout()}>
              退出
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
