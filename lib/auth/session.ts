/**
 * Session handling for the dashboard.
 *
 * The tokens Supabase issues at sign-in are held in httpOnly cookies and replayed as a bearer
 * token on every server-side query. That matters: it means dashboard reads execute *as the
 * signed-in user*, so the row-level security policies in migration 0002 are the actual access
 * boundary, not an application-level check the server could forget to make.
 *
 * The service-role client deliberately is not used for anything a browser can reach. It
 * bypasses RLS entirely and is reserved for connector workers and the cron calculation job.
 */

import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";
import { getPublicEnvironment } from "@/lib/env";

export const ACCESS_TOKEN_COOKIE = "qnch-access-token";
export const REFRESH_TOKEN_COOKIE = "qnch-refresh-token";

export const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
  path: "/",
} as const;

/** An unauthenticated client, used only to exchange credentials or refresh a session. */
export function createSupabaseAuthClient(): SupabaseClient {
  const environment = getPublicEnvironment();
  return createClient(environment.NEXT_PUBLIC_SUPABASE_URL, environment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

/**
 * A client that acts as the signed-in user. Every query it makes is subject to RLS, so a
 * missing policy shows up as no rows rather than as a data leak.
 */
export function createSupabaseUserClient(accessToken: string): SupabaseClient {
  const environment = getPublicEnvironment();
  return createClient(environment.NEXT_PUBLIC_SUPABASE_URL, environment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

/**
 * Verifies the token with Supabase rather than decoding it locally.
 *
 * Reading the claims out of the JWT without checking the signature would accept any token a
 * caller cared to write, so this is a deliberate round trip.
 */
export async function verifyAccessToken(accessToken: string): Promise<User | null> {
  const client = createSupabaseAuthClient();
  const { data, error } = await client.auth.getUser(accessToken);
  return error ? null : data.user;
}

export interface RefreshedSession {
  accessToken: string;
  refreshToken: string;
}

export async function refreshSession(refreshToken: string): Promise<RefreshedSession | null> {
  const client = createSupabaseAuthClient();
  const { data, error } = await client.auth.refreshSession({ refresh_token: refreshToken });
  if (error || !data.session) return null;
  return { accessToken: data.session.access_token, refreshToken: data.session.refresh_token };
}
