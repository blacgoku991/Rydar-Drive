// Textes des cartes de Réglages du réseau partagé qui dépendent du modèle de l'organisation (flotte : véhicules et
// assurance de l'organisation ; centrale : chauffeurs indépendants, leur véhicule et leur assurance) et des délais de
// règlement. Module pur (tests : settings-copy.test.ts). Textes à faire relire par le juriste (spec §7.7).
import { NETWORK_PARAMS, type DispatchModel } from "@rydar/shared";

const NB = "\u00a0";

/** Délai de reversement d'un chauffeur partenaire : celui de l'organisation, au moins 48 h. */
export function driverGraceHours(graceHours: number | null | undefined): number {
  return Math.max(graceHours ?? 24, NETWORK_PARAMS.minDriverGraceHours);
}

/**
 * Qui fait les courses reçues, et sous quelle assurance : flotte (véhicules et assurance de l'organisation) ou centrale
 * (chauffeurs indépendants, leur véhicule et leur assurance). Textes à faire relire par le juriste (spec §7.7).
 */
export const RECEIVE_COPY: Record<DispatchModel, { description: string; insurance: string; insuranceHint: string; activate: string }> = {
  fleet: {
    description: "Vos chauffeurs les font avec vos véhicules et sous votre assurance ; votre organisation ne touche rien.",
    insurance: "Mon assurance couvre les courses faites pour d'autres organisations",
    insuranceHint: "Responsabilité civile circulation et transport de personnes à titre onéreux : à confirmer avant de recevoir des courses.",
    activate: "Ils les font avec vos véhicules et sous votre assurance ; votre organisation ne touche rien.",
  },
  centrale: {
    description: "Vos chauffeurs indépendants les font avec leur véhicule et sous leur assurance ; votre centrale ne touche rien.",
    insurance: "L'assurance de mes chauffeurs couvre les courses faites pour d'autres organisations",
    insuranceHint:
      "Responsabilité civile circulation et transport de personnes à titre onéreux de chaque chauffeur : à vérifier avant de recevoir des courses.",
    activate: "Vos chauffeurs indépendants les font avec leur véhicule et sous leur assurance ; votre centrale ne touche rien.",
  },
};

/**
 * Points de la fenêtre de première activation : qui paie qui, avec quels moyens et sous quel délai (partage) ; qui fait
 * les courses et sous quelle assurance, selon le modèle (réception).
 */
export function activateCopy(side: "out" | "in", model: DispatchModel, graceHours: number): { title: string; points: string[] } {
  if (side === "out") {
    return {
      title: "Activer le partage",
      points: [
        "Une course qu'aucun de vos chauffeurs n'accepte est proposée aux chauffeurs des organisations partenaires proches.",
        `Course payée à bord${NB}: le chauffeur vous reverse votre part avec vos moyens de paiement (lien, RIB, espèces), sous ${graceHours}${NB}h. Course déjà payée${NB}: vous lui versez la sienne sous ${NETWORK_PARAMS.payoutDays}${NB}jours.`,
        "Vous restez responsable envers votre client et lui délivrez le reçu ou la facture.",
      ],
    };
  }
  return {
    title: "Activer la réception",
    points: [
      "Vos chauffeurs libres et proches reçoivent les courses des organisations partenaires, après leurs propres chauffeurs.",
      RECEIVE_COPY[model].activate,
      "Chaque chauffeur règle lui-même avec l'organisation qui lui confie la course.",
    ],
  };
}
