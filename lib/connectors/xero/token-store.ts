/**
 * The Supabase-backed token store for Xero.
 *
 * Kept apart from the OAuth logic so the rotation rule can be tested against an in-memory fake,
 * without a database. The rule it has to honour is unforgiving: a refresh token is single use,
 * so if this store fails to write the rotated value the connection is permanently lost. Every
 * failure here therefore throws rather than being logged and stepped over.
 *
 * The access token is stored alongside the refresh token so that a process starting up shortly
 * after another one finished does not spend a rotation refreshing a token that is still valid.
 * Each rotation consumes one of a finite chain, and a chain broken by a crash between refresh
 * and save cannot be repaired without a human reconnecting.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { bytesFromStored, CURRENT_KEY_VERSION, decryptToken, encryptToken } from "../crypto";
import type { XeroTokens, XeroTokenStore } from "./oauth";

export interface SupabaseXeroTokenStoreOptions {
  connectionId: string;
  encryptionKey: string;
}

export function createSupabaseXeroTokenStore(
  client: SupabaseClient,
  options: SupabaseXeroTokenStoreOptions,
): XeroTokenStore {
  const { connectionId, encryptionKey } = options;

  return {
    async load(): Promise<XeroTokens> {
      const { data, error } = await client
        .from("integration_tokens")
        .select("encrypted_refresh_token, encrypted_access_token, access_token_expires_at")
        .eq("connection_id", connectionId)
        .maybeSingle();
      if (error) throw error;
      if (!data) throw new Error(`No stored Xero token for connection ${connectionId}`);

      const accessToken = data.encrypted_access_token
        ? decryptToken(bytesFromStored(data.encrypted_access_token as string), encryptionKey)
        : "";

      return {
        refreshToken: decryptToken(bytesFromStored(data.encrypted_refresh_token as string), encryptionKey),
        accessToken,
        // No stored access token means "expired": the epoch forces a refresh rather than a
        // request carrying an empty bearer, which Xero answers with a bare 401.
        expiresAt: accessToken
          ? ((data.access_token_expires_at as string | null) ?? new Date(0).toISOString())
          : new Date(0).toISOString(),
      };
    },

    async save(tokens: XeroTokens): Promise<void> {
      const { error } = await client
        .from("integration_tokens")
        .update({
          encrypted_refresh_token: encryptToken(tokens.refreshToken, encryptionKey),
          encrypted_access_token: encryptToken(tokens.accessToken, encryptionKey),
          access_token_expires_at: tokens.expiresAt,
          key_version: CURRENT_KEY_VERSION,
          updated_at: new Date().toISOString(),
        })
        .eq("connection_id", connectionId);

      // Deliberately fatal. Continuing would use a token whose rotation is unrecorded, which
      // ends with a connection nobody can explain the loss of.
      if (error) throw new Error(`Failed to persist the rotated Xero refresh token: ${error.message}`);
    },

    async markNeedsReauth(reason: string): Promise<void> {
      // Best effort: the refresh has already failed, and losing the status update must not
      // replace that error with this one.
      await client
        .from("integration_connections")
        .update({ status: "needs_reauth", updated_at: new Date().toISOString() })
        .eq("id", connectionId);

      console.error(`Xero connection ${connectionId} needs reauthorisation: ${reason}`);
    },
  };
}
