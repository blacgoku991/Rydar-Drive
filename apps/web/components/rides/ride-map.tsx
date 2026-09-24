"use client";
import { FleetMap } from "@/components/map/fleet-map";
import type { LiveDriver, LiveOffer, LiveRide } from "@/lib/queries/live";

export function RideMap({ ride, drivers, offers }: { ride: LiveRide; drivers: LiveDriver[]; offers: LiveOffer[] }) {
  return (
    <FleetMap
      rides={[ride]}
      drivers={drivers}
      offers={offers}
      selectedRideId={ride.id}
      showLabels
      showOffline
      padding={{ top: 60, bottom: 60, left: 60, right: 60 }}
      initialZoom={12}
      focus={[
        [ride.pickup_lng, ride.pickup_lat],
        ...(ride.dropoff_lng != null && ride.dropoff_lat != null ? [[ride.dropoff_lng, ride.dropoff_lat] as [number, number]] : []),
        ...drivers.filter((d) => d.location).map((d) => [d.location!.lng, d.location!.lat] as [number, number]),
      ]}
    />
  );
}
