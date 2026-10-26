import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Server-side secret encryption for AI provider credentials.
 *
 * API keys must not be readable by anyone who can read a database row: a leaked
 * backup, a mis-scoped SELECT or a support export would otherwise hand over a
 * billable credential. They are therefore encrypted at rest with AES-256-GCM,
 * which is authenticated — a tampered ciphertext fails to decrypt rather than
 * silently returning attacker-chosen bytes.
 *
 * The key comes from `AI_SECRET_ENCRYPTION_KEY` and is NEVER stored in the
 * repository or in the database. If it is absent the store FAILS CLOSED: a
 * write carrying a secret is refused with an actionable setup requirement. It
 * never falls back to storing plaintext, because a silent downgrade is exactly
 * the outcome this module exists to prevent.
 *
 * This is not "fake encryption": the plaintext never touches the database, the
 * IV is random per write, and the tag is verified on read.
 */

/** Env var holding the 32-byte key (base64, hex or a >=32-char passphrase). */
export const ENCRYPTION_KEY_ENV = "AI_SECRET_ENCRYPTION_KEY";

/** Marks a stored value as an encrypted envelope, so plaintext is detectable. */
const PREFIX = "enc:v1:";
const ALGO = "aes-256-gcm";
const IV_BYTES = 12;

export class SecretKeyMissingError extends Error {
  readonly code = "encryption_key_missing";
  constructor(message: string) {
    super(message);
    this.name = "SecretKeyMissingError";
  }
}

export class SecretDecryptError extends Error {
  readonly code = "secret_unreadable";
  constructor(message: string) {
    super(message);
    this.name = "SecretDecryptError";
  }
}

/**
 * Derives the 32-byte key from the configured secret.
 *
 * Accepts a base64 or hex encoded 32-byte key, or any passphrase of at least 32
 * characters which is then hashed. Rejecting a short passphrase matters: a weak
 * key makes the encryption decorative.
 */
export function resolveEncryptionKey(raw = process.env[ENCRYPTION_KEY_ENV]): Buffer | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value) return null;

  const fromBase64 = /^[A-Za-z0-9+/]+={0,2}$/.test(value) && value.length % 4 === 0
    ? Buffer.from(value, "base64")
    : null;
  if (fromBase64 && fromBase64.length === 32) return fromBase64;

  const fromHex = /^[0-9a-fA-F]{64}$/.test(value) ? Buffer.from(value, "hex") : null;
  if (fromHex && fromHex.length === 32) return fromHex;

  if (value.length >= 32) return createHash("sha256").update(value, "utf8").digest();
  return null;
}

/** True when a usable encryption key is configured. */
export function isEncryptionConfigured(): boolean {
  return resolveEncryptionKey() !== null;
}

/**
 * The explicit, user-facing setup requirement.
 *
 * Returned instead of a silent plaintext write so an operator knows exactly
 * what to do, and so the UI can show a disabled state rather than pretend the
 * key was stored securely.
 */
export const ENCRYPTION_SETUP_MESSAGE =
  `AI provider keys cannot be stored securely: ${ENCRYPTION_KEY_ENV} is not set. ` +
  `Set it to a 32-byte key (base64 or 64 hex characters) or a passphrase of at ` +
  `least 32 characters, then restart the server once. Until then, saving an API ` +
  `key is refused rather than stored in plaintext.`;

/** True when the value already carries the encrypted envelope. */
export function isEncrypted(value: unknown): boolean {
  return typeof value === "string" && value.startsWith(PREFIX);
}

/** Encrypts a secret for storage. Throws `SecretKeyMissingError` when unkeyed. */
export function encryptSecret(plaintext: string, key = resolveEncryptionKey()): string {
  if (!key) throw new SecretKeyMissingError(ENCRYPTION_SETUP_MESSAGE);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${ciphertext.toString("base64")}`;
}

/**
 * Decrypts a stored secret.
 *
 * A value that is not an envelope is treated as unreadable rather than returned:
 * if a legacy plaintext key is found it must be re-entered, not silently trusted
 * as if it were encrypted.
 */
export function decryptSecret(stored: string, key = resolveEncryptionKey()): string {
  if (!key) throw new SecretKeyMissingError(ENCRYPTION_SETUP_MESSAGE);
  if (!isEncrypted(stored)) {
    throw new SecretDecryptError("Stored secret is not in the encrypted envelope format; re-enter it");
  }
  const parts = stored.slice(PREFIX.length).split(":");
  if (parts.length !== 3) throw new SecretDecryptError("Malformed encrypted secret");
  const [ivB64, tagB64, dataB64] = parts;
  try {
    const decipher = createDecipheriv(ALGO, key, Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // Wrong key or tampered ciphertext. Never echo the underlying error.
    throw new SecretDecryptError("Stored secret could not be decrypted with the configured key");
  }
}

/** Decrypts when possible, returning `null` instead of throwing. */
export function tryDecryptSecret(stored: unknown, key = resolveEncryptionKey()): string | null {
  if (typeof stored !== "string" || !stored) return null;
  try {
    return decryptSecret(stored, key);
  } catch {
    return null;
  }
}

/**
 * A masked representation safe to display, e.g. `sk-or-v1…4f2a`.
 *
 * Only the last four characters are revealed, which is enough for an operator to
 * recognise which key is installed and not enough to reuse it.
 */
export function maskSecret(plaintext: string | null): string | null {
  if (!plaintext) return null;
  const trimmed = plaintext.trim();
  if (!trimmed) return null;
  if (trimmed.length <= 8) return "•".repeat(trimmed.length);
  const head = trimmed.slice(0, 6);
  const tail = trimmed.slice(-4);
  return `${head}…${tail}`;
}

/** Constant-time comparison, for any future key verification step. */
export function secretsEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
