"use client";
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { useRealtimeEvent, useRealtimeStatus } from "@/components/realtime/realtime-provider";

/** Rafraîchit la page serveur quand un événement temps réel concerne la ressource. */
export function LiveRefresh({ rideId, events = ["ride.updated", "ride.event", "offer.updated"], pollMs = 5000 }: { rideId?: string; events?: string[]; pollMs?: number }) {
  const router = useRouter();
  const status = useRealtimeStatus();
  const timer = useRef<number | null>(null);
  const schedule = () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => router.refresh(), 400);
  };
  // liste fixe (règle des hooks) ; « settlement.updated » : règlement de la course (mode centrale)
  for (const ev of ["ride.updated", "ride.event", "offer.updated", "driver.updated", "ride.alert", "settlement.updated"]) {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useRealtimeEvent(ev, (p: any) => {
      if (!events.includes(ev)) return;
      if (!rideId || p?.ride_id === rideId || p?.id === rideId || p?.settlement?.ride_id === rideId) schedule();
    });
  }
  useEffect(() => {
    if (status === "live") return;
    const id = window.setInterval(() => router.refresh(), pollMs);
    return () => window.clearInterval(id);
  }, [status, router, pollMs]);
  return null;
}
