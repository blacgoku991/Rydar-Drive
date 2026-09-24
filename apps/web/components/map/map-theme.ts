import type { DriverPresence, RideStatus } from "@rydar/shared";

export const PRESENCE_COLOR: Record<DriverPresence, string> = {
  available: "#c8f03c",
  offered: "#f5b544",
  en_route: "#6aa6ff",
  arrived: "#b39dfa",
  on_trip: "#45d6e6",
  offline: "#666d79",
};

export function rideColor(status: RideStatus | string): string {
  switch (status) {
    case "CREATED":
    case "SEARCHING_DRIVER":
    case "OFFERED":
      return "#f5b544";
    case "ACCEPTED":
    case "DRIVER_EN_ROUTE":
      return "#6aa6ff";
    case "DRIVER_ARRIVED":
      return "#b39dfa";
    case "PASSENGER_ONBOARD":
    case "IN_PROGRESS":
      return "#45d6e6";
    case "NO_DRIVER_FOUND":
      return "#f2555a";
    case "COMPLETED":
      return "#4fd58f";
    default:
      return "#666d79";
  }
}

export const DEFAULT_CENTER: [number, number] = [2.3488, 48.8634];

/** Couleurs des tracés sur la carte */
export const ROUTE_COLOR = { trip: "#e3e7ec", approach: "#6aa6ff", onboard: "#45d6e6", casing: "#0b0d10" };
