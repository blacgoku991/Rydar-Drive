// Itinéraires routiers pour le worker (simulateur, rattrapage des tracés) via OSRM.
import { decodePolyline, encodePolyline, estimateRoute, simplifyLine, type Coord, type LatLng } from "@rydar/shared";

const OSRM_URL = (process.env.OSRM_URL ?? "https://router.project-osrm.org").replace(/\/$/, "");

export type SimpleRoute = { coords: Coord[]; distanceM: number; durationS: number; polyline: string; approximate: boolean };

export async function osrmRoute(from: LatLng, to: LatLng, timeoutMs = 4000): Promise<SimpleRoute> {
  try {
    const url = `${OSRM_URL}/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=polyline&steps=false`;
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    const data = (await res.json()) as { code: string; routes?: { geometry: string; distance: number; duration: number }[] };
    const r = data.routes?.[0];
    if (data.code !== "Ok" || !r) throw new Error(data.code);
    const coords = simplifyLine(decodePolyline(r.geometry), 6);
    return { coords, distanceM: Math.round(r.distance), durationS: Math.round(r.duration), polyline: encodePolyline(coords), approximate: false };
  } catch {
    const e = estimateRoute(from, to);
    const coords: Coord[] = [[from.lng, from.lat], [to.lng, to.lat]];
    return { coords, distanceM: e.distanceM, durationS: e.durationS, polyline: encodePolyline(coords), approximate: true };
  }
}
