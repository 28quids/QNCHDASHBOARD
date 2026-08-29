import type { MetadataRoute } from "next";

/**
 * Refuses every crawler on every path.
 *
 * This is not an access control — anything relying on a crawler's good manners is not one.
 * Authentication and row-level security are what stop the data being read. This stops the
 * deployment being *found*: an indexed login page tells a competitor the brand runs a control
 * centre and where it lives, which is worth denying separately from denying the data itself.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", disallow: "/" }],
  };
}
