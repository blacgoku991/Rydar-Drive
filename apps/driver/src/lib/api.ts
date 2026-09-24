import type { DriverHome, DriverOffer, Ride, RideStatus, RpcResult } from "@rydar/shared";
import { humanizeError } from "@rydar/shared";
import { appConfig } from "./config";
import { supabase } from "./supabase";

async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args ?? {});
  if (error) throw new Error(humanizeError(error.message, "Connexion impossible. Réessayez."));
  return data as T;
}

/** Connexion via l'API web (anti brute force), repli direct Supabase. */
export async function signIn(email: string, password: string): Promise<void> {
  if (appConfig.apiUrl) {
    const res = await fetch(`${appConfig.apiUrl}/api/auth/driver-login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: email.trim().toLowerCase(), password }),
    }).catch(() => null);
    if (!res) throw new Error("Réseau indisponible.");
    const json = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; error?: string };
    if (!res.ok || !json.access_token || !json.refresh_token) throw new Error(json.error ?? "Connexion impossible.");
    const { error } = await supabase.auth.setSession({ access_token: json.access_token, refresh_token: json.refresh_token });
    if (error) throw new Error("Session invalide.");
    return;
  }
  const { error } = await supabase.auth.signInWithPassword({ email: email.trim().toLowerCase(), password });
  if (error) throw new Error("E-mail ou mot de passe incorrect.");
}

export const api = {
  home: () => rpc<DriverHome>("driver_home"),
  offers: () => rpc<DriverOffer[]>("driver_offers"),
  setOnline: (online: boolean) => rpc<RpcResult & { presence: string }>("driver_set_online", { p_online: online }),
  accept: (offerId: string) => rpc<RpcResult & { ride_id?: string }>("accept_ride_offer", { p_offer_id: offerId }),
  decline: (offerId: string) => rpc<RpcResult>("decline_ride_offer", { p_offer_id: offerId }),
  updateStatus: (rideId: string, status: RideStatus) => rpc<RpcResult>("driver_update_ride_status", { p_ride_id: rideId, p_status: status }),
  location: (p: { lat: number; lng: number; heading?: number | null; speed?: number | null; accuracy?: number | null; battery?: number | null; recordedAt?: string }) =>
    rpc<{ ok: boolean; next_interval_s: number; presence: string }>("update_driver_location", {
      p_lat: p.lat,
      p_lng: p.lng,
      p_heading: p.heading ?? null,
      p_speed: p.speed ?? null,
      p_accuracy: p.accuracy ?? null,
      p_battery: p.battery ?? null,
      p_recorded_at: p.recordedAt ?? null,
    }),
  registerDevice: (p: { installationId: string; platform: "ios" | "android"; token?: string | null; provider?: "expo" | "fcm" | "apns"; deviceName?: string | null; osVersion?: string | null; appVersion?: string | null }) =>
    rpc<RpcResult>("driver_register_device", {
      p_installation_id: p.installationId,
      p_platform: p.platform,
      p_push_token: p.token ?? null,
      p_provider: p.provider ?? "expo",
      p_device_name: p.deviceName ?? null,
      p_os_version: p.osVersion ?? null,
      p_app_version: p.appVersion ?? null,
    }),
  unregisterToken: (token: string) => rpc<RpcResult>("driver_unregister_push_token", { p_token: token }),
  /** Courses du chauffeur (RLS : uniquement les siennes, coordonnées client incluses). */
  ride: async (id: string) => {
    const { data, error } = await supabase.from("rides").select("*").eq("id", id).maybeSingle();
    if (error) throw new Error("Course indisponible.");
    return data as Ride | null;
  },
  upcoming: async () => {
    const { data } = await supabase
      .from("rides")
      .select("*")
      .in("status", ["ACCEPTED", "DRIVER_EN_ROUTE", "DRIVER_ARRIVED", "PASSENGER_ONBOARD", "IN_PROGRESS"])
      .order("pickup_at", { ascending: true })
      .limit(50);
    return (data ?? []) as Ride[];
  },
};
