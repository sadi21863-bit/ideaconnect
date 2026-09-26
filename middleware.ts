import { auth, isAdmin } from "@/lib/auth";
import { NextResponse } from "next/server";

const PUBLIC_PATHS = [
  "/",
  "/sign-in",
  "/sign-up",
  "/api/og",
  "/api/health",
  "/api/auth",
  "/api/cron",    // cron routes have their own Bearer CRON_SECRET auth
  "/ai-lab",      // AI Lab live page — public (no auth required to view)
];

function isPublic(pathname: string) {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/") || pathname.startsWith(p + "?"));
}

export default auth(async (req) => {
  const { pathname } = req.nextUrl;

  // Forward pathname so layout can guard unenrolled users → /onboarding
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-pathname", pathname);
  const next = () => NextResponse.next({ request: { headers: requestHeaders } });

  const isLoggedIn = !!req.auth;

  // Admin routes: must be authenticated AND admin
  if (pathname.startsWith("/admin")) {
    if (!isLoggedIn) {
      return NextResponse.redirect(new URL("/sign-in", req.url));
    }
    const admin = await isAdmin();
    if (!admin) {
      return NextResponse.redirect(new URL("/", req.url));
    }
    return next();
  }

  // Non-public routes require authentication
  if (!isPublic(pathname) && !isLoggedIn) {
    return NextResponse.redirect(
      new URL(`/sign-in?redirect_url=${encodeURIComponent(req.url)}`, req.url)
    );
  }

  return next();
});

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
