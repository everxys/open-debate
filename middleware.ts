import { NextResponse, type NextRequest } from "next/server";

import { verifySessionToken } from "@/lib/session";

export async function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const isProtected =
    pathname.startsWith("/agents") ||
    pathname.startsWith("/debates") ||
    pathname.startsWith("/settings") ||
    pathname.startsWith("/admin");
  const token = request.cookies.get("open_debate_session")?.value;
  const session = token ? await verifySessionToken(token) : null;

  if (!session && isProtected) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  if (session && pathname.startsWith("/admin") && session.role !== "admin") {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"]
};
