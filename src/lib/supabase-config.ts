/**
 * Pure helpers for validating the Supabase client configuration.
 *
 * The browser authenticates directly against `${NEXT_PUBLIC_SUPABASE_URL}` using
 * `${NEXT_PUBLIC_SUPABASE_ANON_KEY}`. If those two values belong to different
 * projects — or the values embedded at build time differ from the ones PM2's
 * runtime environment provides — sign-in fails with an opaque `Invalid login
 * credentials`. These helpers make that mismatch detectable without ever
 * exposing the key.
 */

/** Project ref encoded in the URL host: `https://<ref>.supabase.co`. */
export function projectRefFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const match = /^https?:\/\/([a-z0-9]+)\.supabase\.co/i.exec(url.trim());
  return match ? match[1] : null;
}

/**
 * Project ref declared inside a Supabase anon/service key (a JWT's `ref` claim).
 * Returns `null` for non-JWT or malformed values. Never returns the key itself.
 */
export function projectRefFromKey(key: string | null | undefined): string | null {
  if (!key) return null;
  const parts = key.trim().split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(atob(parts[1]));
    return typeof payload?.ref === "string" ? payload.ref : null;
  } catch {
    return null;
  }
}

/**
 * True when the URL and key plausibly belong to the same Supabase project.
 * A key without a `ref` claim (e.g. a newer opaque key format) is treated as
 * "cannot tell" rather than a hard mismatch.
 */
export function supabaseConfigConsistent(
  url: string | null | undefined,
  key: string | null | undefined,
): boolean {
  const urlRef = projectRefFromUrl(url);
  const keyRef = projectRefFromKey(key);
  if (!urlRef || !keyRef) return true;
  return urlRef === keyRef;
}
