import type { NextConfig } from "next";

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
