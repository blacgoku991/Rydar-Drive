import "server-only";
import { haversine, type LatLng } from "@rydar/shared";
import { lruCache } from "@/lib/geo/cache";
import { createAdminClient } from "@/lib/supabase/admin";

const cache = lruCache<LatLng | null>(500, 10 * 60_000);

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};

/**
 * Point de référence de l'activité d'une organisation : médiane des derniers départs,
 * sinon des positions de sa flotte. Sert de biais de proximité au géocodage et de
 * garde-fou contre les coordonnées aberrantes (0,0 ; latitude/longitude inversées).
 */
export async function orgAnchor(orgId: string): Promise<LatLng | null> {
  const hit = cache.get(orgId);
  if (hit !== undefined) return hit;
  const admin = createAdminClient();
  let pts: LatLng[] = [];
  const { data: rides } = await admin
    .from("rides")
    .select("pickup_lat, pickup_lng")
    .eq("organization_id", orgId)
    .order("created_at", { ascending: false })
    .limit(60);
  pts = (rides ?? []).map((r: any) => ({ lat: r.pickup_lat, lng: r.pickup_lng }));
  if (pts.length < 3) {
    const { data: locs } = await admin.from("driver_locations").select("lat, lng").eq("organization_id", orgId).limit(200);
    pts = pts.concat((locs ?? []).map((l: any) => ({ lat: l.lat, lng: l.lng })));
  }
  const anchor = pts.length ? { lat: median(pts.map((p) => p.lat)), lng: median(pts.map((p) => p.lng)) } : null;
  cache.set(orgId, anchor);
  return anchor;
}

export const MAX_PICKUP_DISTANCE_M = 600_000;

/** Diagnostic de coordonnées fournies par un client API. null = acceptables. */
export function coordinateProblem(p: LatLng, anchor: LatLng | null, maxM = MAX_PICKUP_DISTANCE_M): string | null {
  if (Math.abs(p.lat) < 0.01 && Math.abs(p.lng) < 0.01) return "Coordonnées (0, 0) invalides.";
  if (!anchor || haversine(p, anchor) <= maxM) return null;
  if (haversine({ lat: p.lng, lng: p.lat }, anchor) <= maxM) return "Latitude et longitude semblent inversées.";
  return `Coordonnées à plus de ${Math.round(maxM / 1000)} km de votre zone d'activité.`;
}
