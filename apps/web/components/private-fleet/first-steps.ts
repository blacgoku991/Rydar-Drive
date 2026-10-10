// Flotte Privée, « Premiers pas » de l'Accueil (docs/FLOTTE-PRIVEE.md § 7.3) : liste calculée à chaque affichage,
// aucun stockage, masquée une fois complète — module pur, testé (first-steps.test.ts).

export type FirstStepKey = "company" | "pricing" | "documents" | "app" | "site";

export type FirstStep = { key: FirstStepKey; label: string; hint: string; href: string | null; done: boolean };

export type FirstStepsInput = {
  /** Organisation : raison sociale, SIRET et n° d'inscription au registre VTC */
  org: { legal_name: string | null; siret: string | null; vtc_registration: string | null } | null;
  /** Grilles tarifaires actives */
  activePricingRules: number;
  /** Carte VTC et assurance valides (non expirées, validées) */
  vtcCardValid: boolean;
  insuranceValid: boolean;
  /** Application déjà utilisée (drivers.last_seen_at) */
  appSeenAt: string | null;
  /** Clé du site active et première réservation reçue par l'API */
  siteKeyActive: boolean;
  siteBookings: number;
};

const filled = (v: string | null | undefined) => !!v && v.trim().length > 0;

export function firstSteps(i: FirstStepsInput): FirstStep[] {
  return [
    {
      key: "company",
      label: "Entreprise complète",
      hint: "Raison sociale, SIRET et n° d'inscription au registre VTC.",
      href: "/dashboard/settings?tab=org",
      done: filled(i.org?.legal_name) && filled(i.org?.siret) && filled(i.org?.vtc_registration),
    },
    {
      key: "pricing",
      label: "Tarifs actifs",
      hint: "Votre grille calcule le prix affiché par votre site.",
      href: "/dashboard/settings?tab=pricing",
      done: i.activePricingRules > 0,
    },
    {
      key: "documents",
      label: "Carte VTC et assurance valides",
      hint: "Ajoutez-les avec leur date d'expiration.",
      href: "/dashboard/profil",
      done: i.vtcCardValid && i.insuranceValid,
    },
    {
      key: "app",
      label: "Application utilisée",
      hint: "Connectez-vous à l'application Rydar Drive avec les mêmes identifiants.",
      href: null,
      done: !!i.appSeenAt,
    },
    {
      key: "site",
      label: "Site relié",
      hint: "Clé du site active et première réservation reçue.",
      href: "/dashboard/site",
      done: i.siteKeyActive && i.siteBookings > 0,
    },
  ];
}

/** Liste à afficher (null : tout est fait, la carte disparaît). */
export function pendingFirstSteps(i: FirstStepsInput): FirstStep[] | null {
  const steps = firstSteps(i);
  return steps.every((s) => s.done) ? null : steps;
}
