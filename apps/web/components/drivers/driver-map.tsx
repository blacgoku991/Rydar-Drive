"use client";
import { initials, type Coord } from "@rydar/shared";
import { PRESENCE_COLOR } from "@/components/map/map-theme";
import { RoutePreview } from "@/components/map/route-preview";
import type { LiveDriver } from "@/lib/queries/live";

/** Position du chauffeur et son trajet récent (historique GPS). */
export function DriverMap({ driver, trail = [] }: { driver: LiveDriver; trail?: Coord[] }) {
  const loc = driver.location;
  if (!loc) return null;
  return (
    <RoutePreview
      approach={trail.length > 1 ? [...trail, [loc.lng, loc.lat]] : null}
      drivers={[{ id: driver.id, name: `${driver.first_name} ${initials(driver.first_name, driver.last_name).slice(1)}.`, lat: loc.lat, lng: loc.lng, heading: loc.heading, color: PRESENCE_COLOR[driver.presence] }]}
      padding={48}
    />
  );
}
