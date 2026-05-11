"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";

export function VersionMenu({ currentVersion }: { currentVersion: string }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const active = pathname === "/changelog" || pathname.startsWith("/changelog/") || pathname === "/feedback";

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

  return (
    <div
      className="versionMenu"
      ref={rootRef}
      onPointerEnter={() => setOpen(true)}
      onPointerLeave={() => setOpen(false)}
    >
      <button
        className={`btn versionMenuTrigger ${active ? "btn-active" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((value) => !value)}
      >
        更多
      </button>

      {open ? (
        <div className="versionMenuPanel" role="menu" id={menuId}>
          <div className="versionMenuHeader">
            <div className="muted">当前版本</div>
            <div className="versionMenuCurrent">{currentVersion}</div>
          </div>
          <div className="versionMenuItems">
            <Link className="versionMenuItem" role="menuitem" href="/changelog" onClick={() => setOpen(false)}>
              更新日志
            </Link>
            <Link className="versionMenuItem" role="menuitem" href="/feedback" onClick={() => setOpen(false)}>
              反馈与建议
            </Link>
          </div>
        </div>
      ) : null}
    </div>
  );
}
