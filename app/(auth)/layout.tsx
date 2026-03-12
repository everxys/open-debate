import type { ReactNode } from "react";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="authShell">
      <div className="authInner">{children}</div>
    </div>
  );
}

