import Link from "next/link";
import type { ReactNode } from "react";

import { UserMenu } from "@/components/auth/user-menu";
import { MainNav } from "@/components/nav/main-nav";
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
          <MainNav
            items={[
              { href: "/debates", label: "辩论" },
              { href: "/strategies", label: "策略" },
              { href: "/agents", label: "AI 配置" }
            ]}
          />
          {user ? (
            <UserMenu email={user.email} role={user.role} />
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
