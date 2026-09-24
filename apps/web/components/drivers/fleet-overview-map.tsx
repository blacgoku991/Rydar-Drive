"use client";
import { useRouter } from "next/navigation";
import { FleetMap } from "@/components/map/fleet-map";
import type { LiveDriver } from "@/lib/queries/live";

/** Carte de la flotte (page Chauffeurs) : clic sur un véhicule → fiche du chauffeur. */
export function FleetOverviewMap({ drivers }: { drivers: LiveDriver[] }) {
  const router = useRouter();
  return (
    <FleetMap
      drivers={drivers}
      rides={[]}
      offers={[]}
      showLabels
      showOffline={false}
      initialZoom={11}
      padding={{ top: 50, bottom: 50, left: 50, right: 50 }}
      onSelectDriver={(id) => id && router.push(`/dashboard/drivers/${id}`)}
    />
  );
}
