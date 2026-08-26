import "server-only";
import { createClient } from "@supabase/supabase-js";
import { getServerEnvironment } from "@/lib/env";

/**
 * For connector workers and migrations only. Never import this into a Client Component,
 * Route Handler response, or dashboard query path.
 */
export function createSupabaseAdminClient() {
  const environment = getServerEnvironment();
  return createClient(environment.NEXT_PUBLIC_SUPABASE_URL, environment.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
