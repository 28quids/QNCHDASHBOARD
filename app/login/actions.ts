"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  ACCESS_TOKEN_COOKIE,
  REFRESH_TOKEN_COOKIE,
  SESSION_COOKIE_OPTIONS,
  createSupabaseAuthClient,
} from "@/lib/auth/session";

export interface SignInState {
  error?: string;
}

export async function signIn(_previous: SignInState, formData: FormData): Promise<SignInState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const next = String(formData.get("next") ?? "/");

  if (!email || !password) return { error: "Enter your email address and password." };

  const client = createSupabaseAuthClient();
  const { data, error } = await client.auth.signInWithPassword({ email, password });

  // Supabase already distinguishes a wrong password from an unknown account; the message is
  // not repeated back, so this cannot be used to discover which addresses have accounts.
  if (error || !data.session) return { error: "Those credentials were not accepted." };

  const store = await cookies();
  store.set(ACCESS_TOKEN_COOKIE, data.session.access_token, SESSION_COOKIE_OPTIONS);
  store.set(REFRESH_TOKEN_COOKIE, data.session.refresh_token, SESSION_COOKIE_OPTIONS);

  // Only relative paths, so a crafted `next` cannot bounce the user to another origin.
  redirect(next.startsWith("/") && !next.startsWith("//") ? next : "/");
}

export async function signOut(): Promise<void> {
  const store = await cookies();
  store.delete(ACCESS_TOKEN_COOKIE);
  store.delete(REFRESH_TOKEN_COOKIE);
  redirect("/login");
}
