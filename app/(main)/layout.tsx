import Link from "next/link";
import type { ReactNode } from "react";

import { LogoutButton } from "@/components/auth/logout-button";
import { getOptionalUser } from "@/lib/auth";

export default async function MainLayout({ children }: { children: ReactNode }) {
  const user = await getOptionalUser();

  return (
    <div className="shell">
      <div className="topbar">
        <div>
          <Link href="/debates">
            <strong>Open Debate V1</strong>
          </Link>
          <div className="muted">
            {user ? `已登录: ${user.email}` : "Docker Compose + Next.js + Postgres"}
          </div>
        </div>
        <div className="nav">
          <Link className="btn" href="/debates">
            辩论
          </Link>
          <Link className="btn" href="/agents">
            AI 配置
          </Link>
          {user ? (
            <LogoutButton />
          ) : (
            <Link className="btn btn-primary" href="/login">
              登录
            </Link>
          )}
        </div>
      </div>
      {children}
    </div>
  );
}
