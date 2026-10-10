"use client";
// Étape courante d'une course pas encore attribuée (barre de progression de la fiche) : « Recherche d'un chauffeur »,
// « À attribuer » (dispatch automatique coupé : la course attend une attribution manuelle) ou, en Flotte Privée,
// « À confirmer » (réservation proposée au chauffeur-propriétaire). Composant client : la Flotte Privée est connue du
// fournisseur d'alertes du tableau de bord, sans propriété à passer par les fiches.
import { useAlerts } from "@/components/alerts/dispatch-alerts";

export function PendingStepLabel({ manual }: { manual: boolean }) {
  const privateFleet = useAlerts()?.privateFleet ?? false;
  if (privateFleet) return <>À confirmer</>;
  return <>{manual ? "À attribuer" : "Recherche d'un chauffeur"}</>;
}
