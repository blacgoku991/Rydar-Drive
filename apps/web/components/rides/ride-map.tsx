"use client";
import { decodePolyline } from "@rydar/shared";
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
      padding={{ top: 50, bottom: 50, left: 50, right: 50 }}
      initialZoom={12}
      focus={[
        [ride.pickup_lng, ride.pickup_lat],
        ...(ride.dropoff_lng != null && ride.dropoff_lat != null ? [[ride.dropoff_lng, ride.dropoff_lat] as [number, number]] : []),
        ...(ride.route_polyline ? decodePolyline(ride.route_polyline) : []),
        ...drivers.filter((d) => d.location).map((d) => [d.location!.lng, d.location!.lat] as [number, number]),
      ]}
    />
  );
}
