"use client";
import { createBrowserClient } from "@supabase/ssr";
import { env } from "@/lib/env";

let client: ReturnType<typeof createBrowserClient> | null = null;

export function getBrowserClient() {
  if (!client) client = createBrowserClient(env.supabaseUrl, env.supabaseAnonKey);
  return client;
}
