import Link from "next/link";
import type { ReactNode } from "react";

import { UserMenu } from "@/components/auth/user-menu";
import { MainNav } from "@/components/nav/main-nav";
import { VersionMenu } from "@/components/nav/version-menu";
import { getOptionalUser } from "@/lib/auth";
import { getCurrentRelease } from "@/lib/version";

export default async function MainLayout({ children }: { children: ReactNode }) {
  const user = await getOptionalUser();
  const currentRelease = getCurrentRelease();

  return (
    <div className="shell">
      <div className="topbar">
        <div>
          <Link className="topbarBrand" href="/debates">
            <strong>Open Debate</strong>
            <span className="topbarVersion">{currentRelease.version}</span>
          </Link>
          <div className="muted">
            {user ? `已登录: ${user.email}` : "Docker Compose + Next.js + Postgres"}
          </div>
        </div>
        <div className="nav">
          <MainNav
            items={[
              { href: "/debates", label: "辩论" },
              { href: "/workspaces", label: "工作台" },
              { href: "/strategies", label: "策略" },
              { href: "/agents", label: "AI 配置" },
              { href: "/playground", label: "Playground" }
            ]}
          />
          <VersionMenu currentVersion={currentRelease.version} />
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
