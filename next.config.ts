import type { NextConfig } from "next";
import { BUILD_TIME_VARIABLES } from "./lib/env";

/**
 * Refuses to produce a hosted build that cannot work.
 *
 * `NEXT_PUBLIC_` values are substituted into the bundle when `next build` runs and frozen
 * there, so a deployment built without them contains `undefined` and keeps containing it no
 * matter what is set afterwards. The failure surfaces much later, as a 500 on the login page
 * with an opaque digest, and looks like a missing variable rather than a stale build.
 *
 * Checked only when building on a host, so a local build — for tests, lint, or a quick
 * typecheck — still works without a configured environment. On a host there is no such thing as
 * a build worth shipping without these, so failing here costs a deploy and saves a debugging
 * session.
 */
function assertBuildTimeEnvironment(): void {
  if (!process.env.VERCEL) return;

  const missing = BUILD_TIME_VARIABLES.filter((name) => !process.env[name]);
  if (missing.length === 0) return;

  throw new Error(
    [
      `Cannot build: ${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} not set.`,
      "",
      "These are inlined into the bundle at build time, so a deployment built without them",
      "cannot be repaired by setting them afterwards — it has to be rebuilt.",
      "",
      "Add them to the project's environment variables for this environment (Preview and",
      "Production are separate), then redeploy without the build cache.",
    ].join("\n"),
  );
}

assertBuildTimeEnvironment();

/**
 * Response headers for a deployment holding QNCH's commercial and customer data.
 *
 * None of these is the access boundary — authentication and row-level security are, and a
 * header has never stopped anyone who has a valid session. What they do is narrow the ways a
 * browser can be talked into leaking one.
 */
const securityHeaders = [
  /**
   * Authoritative refusal to be indexed.
   *
   * `robots.txt` asks a crawler not to fetch the page; it does not stop a URL discovered some
   * other way — a link, a referrer log, a shared screenshot — from being listed. This header is
   * the instruction that actually removes it, and unlike robots.txt it is honoured on a page a
   * crawler has already reached.
   */
  { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive, nosnippet, noimageindex" },

  /**
   * No framing, by anyone.
   *
   * A finance dashboard inside someone else's iframe is a clickjacking target: the owner sees a
   * harmless page and clicks a button on the invisible one beneath it. `frame-ancestors` is the
   * modern form and `X-Frame-Options` covers browsers that still only read that.
   */
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Frame-Options", value: "DENY" },

  /** Stops a browser second-guessing a content type and executing something as script. */
  { key: "X-Content-Type-Options", value: "nosniff" },

  /**
   * No referrer off-site.
   *
   * Dashboard URLs carry report parameters — which metrics, which dates — and a full referrer
   * would hand those to any third party a link leads to.
   */
  { key: "Referrer-Policy", value: "no-referrer" },

  /** HTTPS only, for two years, subdomains included. Vercel already redirects; this forbids. */
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },

  /** Hardware and identity APIs this application has no use for. */
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,

  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
