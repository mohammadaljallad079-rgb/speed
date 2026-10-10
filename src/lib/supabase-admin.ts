import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// The service-role client is untyped against the database schema (as before this
// change), so `from(...)` returns the generic builder rather than `never`.
type AdminClient = SupabaseClient<any, "public", any>;

function createAdminClient(): AdminClient {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseServiceRoleKey) {
    throw new Error("Missing Supabase service role configuration.");
  }

  return createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

let cached: AdminClient | null = null;

function admin(): AdminClient {
  if (!cached) cached = createAdminClient();
  return cached;
}

/**
 * Service-role client (server-only, bypasses RLS).
 *
 * Initialisation is deferred until first use so that merely importing a module
 * that references this client does not throw when the environment is not
 * configured (e.g. unit tests, static analysis). The client still fails hard the
 * moment it is actually used without a service-role key — configuration is never
 * silently skipped, and no request is ever served unauthenticated because of it.
 */
export const supabaseAdmin = new Proxy({} as AdminClient, {
  get(_target, prop, receiver) {
    const client = admin();
    const value = Reflect.get(client as object, prop, receiver);
    return typeof value === "function" ? value.bind(client) : value;
  },
});
