// Conditions des courses du réseau partagé proposées UNE fois à l'accueil, quand l'organisation du chauffeur reçoit le
// réseau, puis à chaque nouvelle version (lib/network.ts : shouldProposeNetworkTerms). Jamais pendant une offre ou une
// course, ni avant l'acceptation des conditions d'utilisation (écran TermsGate), ni application en arrière-plan.
// Version déjà proposée gardée sur le téléphone, par compte.
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { DriverPresence } from "@rydar/shared";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { AppState } from "react-native";
import { useDriver } from "@/hooks/driver-context";
import { termsAcceptedFor } from "@/lib/legal";
import { shouldProposeNetworkTerms } from "@/lib/network";

/** Offre reçue ou course en cours : rien ne s'ouvre par-dessus. */
const BUSY = new Set<DriverPresence>(["offered", "en_route", "arrived", "on_trip"]);

const key = (userId: string) => `rydar.driver.networkTermsProposed.${userId}`;

/**
 * `focused` : accueil au premier plan (aucun écran d'offre ni de course par-dessus) ; `now` : horloge de l'accueil (la
 * proposition attend l'acceptation des conditions d'utilisation, relue à chaque tic).
 */
export function useNetworkTermsPrompt(focused: boolean, now: number) {
  const { session, network, home } = useDriver();
  const userId = session?.user.id ?? null;
  // undefined : pas encore lu sur le téléphone
  const [proposed, setProposed] = useState<{ userId: string; version: string | null } | undefined>(undefined);

  useEffect(() => {
    setProposed(undefined);
    if (!userId) return;
    let alive = true;
    void AsyncStorage.getItem(key(userId))
      .catch(() => null)
      .then((v) => alive && setProposed({ userId, version: v }));
    return () => {
      alive = false;
    };
  }, [userId]);

  useEffect(() => {
    if (!focused || !userId || !network || proposed?.userId !== userId) return;
    if (!shouldProposeNetworkTerms(network, proposed.version)) return;
    if (!home || home.driver.current_ride_id || BUSY.has(home.driver.presence)) return;
    if (!termsAcceptedFor(userId) || AppState.currentState !== "active") return;
    const version = network.terms.version;
    setProposed({ userId, version });
    void AsyncStorage.setItem(key(userId), version).catch(() => null);
    router.push({ pathname: "/network-terms", params: { from: "home" } });
  }, [focused, userId, network, proposed, home, now]);
}
