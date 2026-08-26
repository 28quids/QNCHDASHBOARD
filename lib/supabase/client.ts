import { createClient } from "@supabase/supabase-js";
import { getPublicEnvironment } from "@/lib/env";

/** Browser client. RLS is the sole access boundary for queries made with this client. */
export function createSupabaseBrowserClient() {
  const environment = getPublicEnvironment();
  return createClient(environment.NEXT_PUBLIC_SUPABASE_URL, environment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
}
