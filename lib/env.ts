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

export function getPublicEnvironment() {
  return publicEnvironmentSchema.parse({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  });
}
/** Only use in server-side workers and protected route handlers. */
export function getServerEnvironment() {
  return serverEnvironmentSchema.parse({
    ...getPublicEnvironment(),
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    TOKEN_ENCRYPTION_KEY: process.env.TOKEN_ENCRYPTION_KEY,
    CRON_SECRET: process.env.CRON_SECRET,
    ORGANISATION_ID: process.env.ORGANISATION_ID,
  });
}
