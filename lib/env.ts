import { z } from "zod";

const publicEnvironmentSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(20),
});

const serverEnvironmentSchema = publicEnvironmentSchema.extend({
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  TOKEN_ENCRYPTION_KEY: z.string().min(32),
  CRON_SECRET: z.string().min(32),
  /** The tenant every server-side query is scoped to. Every table is keyed on it. */
  ORGANISATION_ID: z.uuid(),
});

/**
 * Turns a validation failure into something a person can act on.
 *
 * The raw `ZodError` reaches a deployed app as a 500 with an opaque digest, so the only way to
 * learn which variable is missing is to go and read the platform's logs. Naming them — and, for
 * the public pair, saying the thing that is not obvious — is the difference between a two-minute
 * fix and an afternoon.
 */
function describe(error: z.ZodError, scope: "public" | "server"): never {
  const problems = error.issues.map((issue) => {
    const name = String(issue.path[0] ?? "(unknown)");
    return issue.code === "invalid_type" && issue.message.includes("undefined")
      ? `  ${name} is not set`
      : `  ${name} is set but invalid: ${issue.message}`;
  });

  const lines = [
    `Environment is not configured (${scope}):`,
    ...problems,
    "",
    "Set them in .env.local locally, or in the hosting provider's environment variables.",
  ];

  // The trap worth stating outright. NEXT_PUBLIC_ values are substituted into the bundle when
  // `next build` runs and are frozen there, so setting one on a already-built deployment has no
  // effect at all — the compiled code contains `undefined` and will keep doing so until it is
  // rebuilt. Everything about the failure looks like a missing variable rather than a stale build.
  if (error.issues.some((issue) => String(issue.path[0] ?? "").startsWith("NEXT_PUBLIC_"))) {
    lines.push(
      "",
      "NEXT_PUBLIC_ variables are inlined at build time and frozen there. If you have just",
      "added one, the running build still contains the old value: redeploy without the build",
      "cache. Check too that the variable exists for this environment — Preview and Production",
      "are separate, and a value set only on one is absent on the other.",
    );
  }

  throw new Error(lines.join("\n"));
}

export function getPublicEnvironment() {
  const result = publicEnvironmentSchema.safeParse({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  });

  if (!result.success) describe(result.error, "public");
  return result.data;
}

/** Only use in server-side workers and protected route handlers. */
export function getServerEnvironment() {
  const result = serverEnvironmentSchema.safeParse({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    TOKEN_ENCRYPTION_KEY: process.env.TOKEN_ENCRYPTION_KEY,
    CRON_SECRET: process.env.CRON_SECRET,
    ORGANISATION_ID: process.env.ORGANISATION_ID,
  });

  if (!result.success) describe(result.error, "server");
  return result.data;
}

/** The variables that must exist when the bundle is built, rather than when it runs. */
export const BUILD_TIME_VARIABLES = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
] as const;
