import type { DriverPresence, RideStatus } from "@rydar/shared";

export const PRESENCE_COLOR: Record<DriverPresence, string> = {
  available: "#c8f03c",
  offered: "#ffb020",
  en_route: "#4c9dff",
  arrived: "#a78bfa",
  on_trip: "#22d3ee",
  offline: "#5f6777",
};

export function rideColor(status: RideStatus | string): string {
  switch (status) {
    case "CREATED":
    case "SEARCHING_DRIVER":
    case "OFFERED":
      return "#c8f03c";
    case "ACCEPTED":
    case "DRIVER_EN_ROUTE":
      return "#4c9dff";
    case "DRIVER_ARRIVED":
      return "#a78bfa";
    case "PASSENGER_ONBOARD":
    case "IN_PROGRESS":
      return "#22d3ee";
    case "NO_DRIVER_FOUND":
      return "#ff4d5e";
    case "COMPLETED":
      return "#3ddc97";
    default:
      return "#5f6777";
  }
}

export const DEFAULT_CENTER: [number, number] = [2.3488, 48.8634];
