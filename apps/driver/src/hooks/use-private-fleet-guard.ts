// Écrans sans objet en Flotte Privée (messagerie, commissions, réseau partagé : conditions et coordonnées bancaires) :
// retour à l'accueil (docs/FLOTTE-PRIVEE.md § 10.4). Le serveur refuse de toute façon ces fonctions hors de son
// organisation ; l'app ne fait que simplifier (lien direct, notification d'une version antérieure, retour arrière).
import { router } from "expo-router";
import { useEffect } from "react";
import { useDriver } from "@/hooks/driver-context";

/** true : Flotte Privée, l'écran ne s'affiche pas (remplacé par l'accueil). */
export function usePrivateFleetGuard(): boolean {
  const { privateFleet } = useDriver();
  useEffect(() => {
    if (privateFleet) router.replace("/home");
  }, [privateFleet]);
  return privateFleet;
}
