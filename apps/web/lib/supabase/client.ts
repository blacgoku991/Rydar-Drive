"use client";
import { createBrowserClient } from "@supabase/ssr";
import { env } from "@/lib/env";

let client: ReturnType<typeof createBrowserClient> | null = null;

export function getBrowserClient() {
  // Attribut Secure sur les cookies de session écrits par le navigateur (site servi en https)
  if (!client) client = createBrowserClient(env.supabaseUrl, env.supabaseAnonKey, { cookieOptions: { secure: typeof window !== "undefined" && window.location.protocol === "https:" } });
  return client;
}
