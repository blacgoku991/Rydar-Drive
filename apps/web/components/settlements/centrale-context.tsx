"use client";
// Mode « Centrale à commission » : ce que les écrans du tableau de bord doivent savoir de l'organisation
// (modèle, fuseau, rôle, lien de paiement, instructions). Fourni par le shell, lu par les alertes, la fiche
// course, le panneau du command center et le formulaire de nouvelle course.
import type { DispatchModel, OrgRole, SettlementMethod } from "@rydar/shared";
import { createContext, useContext } from "react";

export type CentraleInfo = {
  model: DispatchModel;
  orgId: string;
  orgName: string;
  timeZone: string;
  role: OrgRole;
  /** Modèle de lien de paiement ({montant}, {montant_centimes}, {reference}) — null si non configuré */
  link: string | null;
  instructions: string | null;
  methods: SettlementMethod[];
  /** Blocage automatique des retardataires (commission en retard ou contestée) */
  blockUnpaid: boolean;
};

const CentraleContext = createContext<CentraleInfo | null>(null);

export function CentraleProvider({ value, children }: { value: CentraleInfo; children: React.ReactNode }) {
  return <CentraleContext.Provider value={value}>{children}</CentraleContext.Provider>;
}

/** Informations de l'organisation (null hors du tableau de bord). */
export function useCentrale(): CentraleInfo | null {
  return useContext(CentraleContext);
}

/** true en mode centrale (option 2). */
export function useIsCentrale(): boolean {
  return useContext(CentraleContext)?.model === "centrale";
}

export const canManageSettlements = (role: OrgRole | null | undefined) => role === "owner" || role === "admin";
