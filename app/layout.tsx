import "./globals.css";
import type { ReactNode } from "react";

export const metadata = {
  title: "Open Debate V1",
  description: "V1 MVP scaffold for multi-agent AI debate."
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
