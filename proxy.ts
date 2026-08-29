/**
 * Keeps the signed-in session alive and blocks unauthenticated access.
 *
 * Refreshing happens here because a Server Component cannot set a cookie. Without it a
 * session would simply expire mid-session and drop the user at the login screen with no
 * explanation.
 *
 * This is a liveness check, not the security boundary: it only tests that a token is present
 * and refreshable. Authorisation is enforced by row-level security on every query, so a
 * forged cookie that got past here would still read nothing.
 */

import { NextResponse, type NextRequest } from "next/server";
import {
  ACCESS_TOKEN_COOKIE,
  REFRESH_TOKEN_COOKIE,
  SESSION_COOKIE_OPTIONS,
  refreshSession,
  verifyAccessToken,
} from "@/lib/auth/session";

const PUBLIC_PATHS = ["/login", "/api/cron"];

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (PUBLIC_PATHS.some((path) => pathname.startsWith(path))) return NextResponse.next();

  const accessToken = request.cookies.get(ACCESS_TOKEN_COOKIE)?.value;
  const refreshToken = request.cookies.get(REFRESH_TOKEN_COOKIE)?.value;

  if (accessToken && (await verifyAccessToken(accessToken))) return NextResponse.next();

  if (refreshToken) {
    const refreshed = await refreshSession(refreshToken);
    if (refreshed) {
      const response = NextResponse.next();
      response.cookies.set(ACCESS_TOKEN_COOKIE, refreshed.accessToken, SESSION_COOKIE_OPTIONS);
      response.cookies.set(REFRESH_TOKEN_COOKIE, refreshed.refreshToken, SESSION_COOKIE_OPTIONS);
      return response;
    }
  }

  const login = new URL("/login", request.url);
  // Preserved so a bookmarked deep link survives the round trip through sign-in.
  if (pathname !== "/") login.searchParams.set("next", pathname);

  const response = NextResponse.redirect(login);
  response.cookies.delete(ACCESS_TOKEN_COOKIE);
  response.cookies.delete(REFRESH_TOKEN_COOKIE);
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
