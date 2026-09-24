"use client";
import { FleetMap } from "@/components/map/fleet-map";
import type { LiveDriver } from "@/lib/queries/live";

export function DriverMap({ driver }: { driver: LiveDriver }) {
  return (
    <FleetMap
      drivers={[driver]}
      rides={[]}
      offers={[]}
      selectedDriverId={driver.id}
      showOffline
      showLabels
      initialZoom={13}
      focus={driver.location ? [[driver.location.lng, driver.location.lat]] : undefined}
    />
  );
}
