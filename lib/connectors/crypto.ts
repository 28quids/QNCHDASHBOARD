import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Envelope encryption for provider OAuth tokens.
 *
 * Tokens are stored as ciphertext in `integration_tokens` and are never returned to a browser.
 * The stored value is self-describing so a key rotation can decrypt old rows:
 *
 *   [version:1][iv:12][authTag:16][ciphertext:...]
 */

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export const CURRENT_KEY_VERSION = 1;

/**
 * Accepts base64, hex or raw 32-byte key material. Anything that does not yield exactly
 * 32 bytes is rejected rather than padded or hashed into shape.
 */
export function resolveEncryptionKey(key: string): Buffer {
  const candidates = [tryDecode(key, "base64"), tryDecode(key, "hex"), Buffer.from(key, "utf8")];
  const usable = candidates.find((candidate) => candidate?.length === KEY_BYTES);

  if (!usable) {
    throw new Error(`TOKEN_ENCRYPTION_KEY must be ${KEY_BYTES} bytes (base64, hex, or raw)`);
  }
  return usable;
}

function tryDecode(value: string, encoding: "base64" | "hex"): Buffer | null {
  try {
    const decoded = Buffer.from(value, encoding);
    // Buffer.from is lenient, so confirm the value round-trips before trusting the length.
    return decoded.toString(encoding).replace(/=+$/, "") === value.replace(/=+$/, "") ? decoded : null;
  } catch {
    return null;
  }
}

export function encryptToken(plaintext: string, key: string, keyVersion = CURRENT_KEY_VERSION): Buffer {
  if (plaintext.length === 0) throw new Error("Refusing to encrypt an empty token");

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, resolveEncryptionKey(key), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);

  return Buffer.concat([Buffer.from([keyVersion]), iv, cipher.getAuthTag(), ciphertext]);
}

export function decryptToken(payload: Buffer, key: string): string {
  if (payload.length <= 1 + IV_BYTES + TAG_BYTES) {
    throw new Error("Encrypted token payload is truncated");
  }

  const iv = payload.subarray(1, 1 + IV_BYTES);
  const authTag = payload.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
  const ciphertext = payload.subarray(1 + IV_BYTES + TAG_BYTES);

  const decipher = createDecipheriv(ALGORITHM, resolveEncryptionKey(key), iv);
  decipher.setAuthTag(authTag);
  // A wrong key or tampered ciphertext throws here rather than returning rubbish.
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

export function readKeyVersion(payload: Buffer): number {
  if (payload.length === 0) throw new Error("Encrypted token payload is empty");
  return payload[0];
}

/**
 * Stable hash of a provider payload, used to skip rewriting an unchanged record and to give
 * `raw_import_objects` a natural dedupe key. Object keys are sorted so that a re-serialised
 * payload hashes identically.
 */
export function payloadHash(payload: unknown): string {
  return createHash("sha256").update(canonicalise(payload)).digest("hex");
}

function canonicalise(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalise).join(",")}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalise(item)}`).join(",")}}`;
}

/** Constant-time comparison for the cron shared secret. */
export function secretsMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
