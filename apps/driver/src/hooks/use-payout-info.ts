// Coordonnées bancaires du chauffeur (versements des courses partenaires déjà payées), sans jamais prendre l'inconnu pour
// « non renseignées » : celles de l'état réseau (driver_network_state) ; état réseau absent (interrupteur coupé ensuite
// alors qu'un versement reste attendu, état pas encore lu au démarrage depuis une notification) : lues directement
// (driver_payout_info) quand l'écran en a besoin. null : inconnues (aucune invitation à les renseigner).
import type { DriverPayoutInfo } from "@rydar/shared";
import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { useDriver } from "@/hooks/driver-context";
import { api } from "@/lib/api";

export function usePayoutInfo(needed: boolean): DriverPayoutInfo | null {
  const { network } = useDriver();
  const known = network?.payout ?? null;
  const [read, setRead] = useState<DriverPayoutInfo | null>(null);
  useFocusEffect(
    useCallback(() => {
      if (!needed || known) return undefined;
      let alive = true;
      api.payoutInfo().then(
        (p) => {
          if (alive) setRead(p ?? null);
        },
        () => undefined,
      );
      return () => {
        alive = false;
      };
    }, [needed, known]),
  );
  return known ?? read;
}
