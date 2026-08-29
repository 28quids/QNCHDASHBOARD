import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { getServerEnvironment } from "@/lib/env";
import { ACCESS_TOKEN_COOKIE, createSupabaseUserClient, verifyAccessToken } from "./session";

export interface DashboardSession {
  user: User;
  /** Scoped to the signed-in user, so every read is filtered by row-level security. */
  client: SupabaseClient;
  organisationId: string;
  organisationName: string;
  businessTimezone: string;
}

/**
 * The session for a dashboard page, or a redirect to sign in.
 *
 * Membership is not asserted here — it is enforced by the policies. If the user is not a
 * member of the organisation, the organisation query returns no row and they are sent to a
 * page that says so, rather than to an empty dashboard that looks like a business with no
 * revenue.
 */
export async function requireSession(): Promise<DashboardSession> {
  const store = await cookies();
  const accessToken = store.get(ACCESS_TOKEN_COOKIE)?.value;
  if (!accessToken) redirect("/login");

  const user = await verifyAccessToken(accessToken);
  if (!user) redirect("/login");

  const client = createSupabaseUserClient(accessToken);
  const organisationId = getServerEnvironment().ORGANISATION_ID;

  const { data, error } = await client
    .from("organisations")
    .select("name, business_timezone")
    .eq("id", organisationId)
    .maybeSingle();
  if (error) throw error;
  if (!data) redirect("/login?error=no-access");

  return {
    user,
    client,
    organisationId,
    organisationName: data.name as string,
    businessTimezone: data.business_timezone as string,
  };
}
