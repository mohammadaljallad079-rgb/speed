import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import type { AppUser } from "./supabase";

/**
 * Server-side Supabase client bound to the request cookies.
 * Uses the anon key so GoTrue validates the caller's JWT.
 */
export const createSupabaseServerClient = async () => {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (cookiesToSet) => {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // Called from a Server Component: middleware refreshes the session.
          }
        },
      },
    },
  );
};

/**
 * Reads the authenticated application user from the server session.
 * Returns `null` when there is no valid session. `users` is the application
 * profile table (the previously referenced `app_users` table never existed).
 */
export const getAppUser = async (): Promise<AppUser | null> => {
  try {
    const supabaseServer = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabaseServer.auth.getUser();
    if (!user) return null;

    const { data } = await supabaseServer
      .from("users")
      .select("id, email, full_name, role, customer_id")
      .eq("id", user.id)
      .maybeSingle();

    return (data as AppUser | null) ?? null;
  } catch {
    return null;
  }
};

export type { AppUser };
