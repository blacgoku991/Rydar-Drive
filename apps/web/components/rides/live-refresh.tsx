"use client";
import { useRouter } from "next/navigation";
import { useRealtimeEvent } from "@/components/realtime/realtime-provider";
import { useLiveSync } from "@/components/realtime/use-live-sync";

/**
 * Rafraîchit la page serveur quand un événement temps réel concerne la ressource : la course `rideId`, ou le chauffeur
 * `driverId` (fiche chauffeur : « driver.updated » est diffusé pour CHAQUE chauffeur de la centrale, à chaque vague de
 * dispatch ou étape de course), sinon tout événement de la liste. Onglet caché : un seul rafraîchissement au retour.
 * Sans temps réel : sondage à délai croissant (pollMs → ×3 → … → maxPollMs, 60 s par défaut), en pause onglet caché.
 */
export function LiveRefresh({
  rideId,
  driverId,
  events = ["ride.updated", "ride.event", "offer.updated"],
  pollMs = 5000,
  maxPollMs = 60_000,
}: {
  rideId?: string;
  driverId?: string;
  events?: string[];
  pollMs?: number;
  maxPollMs?: number;
}) {
  const router = useRouter();
  const { schedule } = useLiveSync(() => router.refresh(), { pollMs, maxPollMs, debounceMs: 400 });
  // liste fixe (règle des hooks) ; « settlement.updated » : règlement de la course (mode centrale)
  for (const ev of ["ride.updated", "ride.event", "offer.updated", "driver.updated", "ride.alert", "settlement.updated"]) {
    useRealtimeEvent(ev, (p: any) => {
      if (!events.includes(ev)) return;
      if (driverId) {
        if ((ev === "driver.updated" ? p?.id : p?.driver_id) === driverId) schedule();
        return;
      }
      if (!rideId || p?.ride_id === rideId || p?.id === rideId || p?.settlement?.ride_id === rideId) schedule();
    });
  }
  return null;
}
