// Réseau partagé entre organisations (flottes et centrales) — CONTRATS (lot 0).
//
// Vocabulaire : A = organisation qui CONFIE la course (propriétaire du client, du prix, de la course : la course reste
// chez A à vie, rides.organization_id = A) ; B = organisation du chauffeur qui l'EXÉCUTE ; « chauffeur partenaire » =
// chauffeur de B qui fait une course de A.
//
// Décisions du propriétaire appliquées ici :
//   • Q1 : le chauffeur partenaire est traité comme les chauffeurs de A ; B ne prend rien. Part de A = commission + frais
//     Rydar (A centrale) ou frais Rydar seuls (A flotte). Pas de « commission partenaire ».
//   • Q2 : la contrepartie est TOUJOURS le chauffeur exécutant (constante « driver »), jamais B : client payé à bord →
//     le chauffeur reverse la part de A avec les moyens de A ; client prépayé → A verse au chauffeur sa part.
//   • Frais Rydar : dus par A, au taux de A, rien pour B. Q5 : B ne voit pas la position de son chauffeur pendant la
//     course partenaire.
//   • Interrupteur plateforme coupé par défaut (public.shared_network_enabled()) : tant qu'il est coupé, rien ne change.
//
// Ce module fixe les formes JSON des RPC réseau (migrations 20260924006700 à 20260924007100 : schéma 006700, dispatch
// 006800, argent 006900, accès 007000, administration 007100), les raisons
// (dispatch, lisibilité, blocages) avec leurs libellés, la version de la convention, et networkTerms() : miroir EXACT de
// private.network_terms (arrondis du SQL : round() de PostgreSQL sur numeric, demi-unité loin de zéro).
// Mots interdits dans tous les textes du réseau (§7.1) : NETWORK_FORBIDDEN_WORDS.
import { formatPrice } from "./format";
import { percentOfCents } from "./platform-fees";
import type { DriverStatus, OrgStatus, PaymentMethod, RideStatus, RideType, Tone, VehicleCategory } from "./domain";
import type {
  DispatchModel, DriverBlocker, DriverOffer, Iso, RideFlightFields, Settlement, SettlementBank, SettlementDirection,
  SettlementMethod, SettlementStatus, Uuid,
} from "./types";

// =============================================================================
// Constantes
// =============================================================================

/**
 * Version courante de la convention du réseau (documents « network » et « network_driver »), versionnée à part de
 * LEGAL_VERSION : égale au défaut de platform_settings.network_terms_version de la dernière migration qui le change
 * (network.test.ts). Une correction du juriste = nouvelle version réseau (avec délai de grâce), jamais LEGAL_VERSION.
 */
export const NETWORK_TERMS_VERSION = "2026-11-01";

/** Documents du réseau dans legal_acceptances (acceptés par RPC dédiées, jamais par accept_legal_documents). */
export const NETWORK_DOCUMENTS = {
  /** Convention entre organisations (owner / admin) */
  network: { label: "Convention du réseau partagé", path: "/reseau-partage/conditions" },
  /** Conditions du chauffeur (écran de l'app) */
  network_driver: { label: "Conditions du réseau partagé (chauffeur)", path: "/reseau-partage/chauffeur" },
} as const;
export type NetworkDocument = keyof typeof NETWORK_DOCUMENTS;

/** Paramètres fixes de la v1 (aucun réglage) : mêmes valeurs que le SQL. */
export const NETWORK_PARAMS = {
  /** Planifiée : réseau à prise en charge − 120 min… */
  scheduledLeadMinutes: 120,
  /** … jamais moins de 15 min après le début du dispatch */
  scheduledMinAfterStartMinutes: 15,
  /** Nom et téléphone du client visibles par le partenaire de prise en charge − 60 min (immédiate : dès l'acceptation)… */
  clientDataBeforeMinutes: 60,
  /** … jusqu'à fin + 60 min */
  clientDataAfterMinutes: 60,
  /** Téléphone du chauffeur chez A et de A chez le chauffeur : jusqu'à fin + 48 h (prolongé tant qu'un règlement est ouvert, 30 j max) */
  phoneAfterHours: 48,
  phoneMaxDays: 30,
  /** Échéance d'un reversement par le chauffeur : greatest(délai de A, 48 h) */
  minDriverGraceHours: 48,
  /** Échéance d'un versement par A */
  payoutDays: 7,
  /** Versement prépayé retenu quand la course est « à vérifier » */
  payoutHoldHours: 72,
  /** Versement réseau en retard de plus de N jours : A ne partage plus */
  overdueSharingDays: 7,
  /** « Contester la course » : N jours après la fin */
  contestDays: 7,
  /** App non déclarée capable depuis plus de N jours : pas d'offre réseau */
  appCapableDays: 7,
  /** Retraits répétés : N exécutions retirées sur la période → exclusion du chauffeur */
  releasesLimit: 3,
  releasesWindowDays: 30,
  autoExclusionDays: 30,
  /** Plafond par chauffeur (B) : défaut et bornes (centimes) */
  executorCreditLimitDefaultCents: 15_000,
  executorCreditLimitMaxCents: 100_000,
  /** Offre réseau : coordonnées arrondies (~300 m) */
  coordStepDegrees: 0.003,
  /** Courses en phase réseau traitées par tick, erreurs avant fin du réseau pour une course */
  maxPerTick: 50,
  maxErrors: 3,
  /** Relance manuelle d'un chauffeur partenaire : 1 par 30 min */
  remindIntervalMinutes: 30,
} as const;

/**
 * Contrepartie d'un règlement réseau : TOUJOURS le chauffeur exécutant (décision Q2). Colonnes SQL
 * ride_network_executions.counterparty et ride_settlements.network_counterparty contraintes à 'driver' ; une extension
 * (organisation) se ferait par une nouvelle migration.
 */
export const NETWORK_COUNTERPARTIES = ["driver"] as const;
export type NetworkCounterparty = (typeof NETWORK_COUNTERPARTIES)[number];

/** Vocabulaire interdit partout (convention, CGV, interface, app, docs) : Rydar est un logiciel de dispatch (§7.1). */
export const NETWORK_FORBIDDEN_WORDS = ["mise en relation", "intermédiaire", "intermediaire", "place de marché", "marketplace"] as const;

/** Départ d'une offre réseau sans code postal reconnaissable dans l'adresse. */
export const NETWORK_PICKUP_HIDDEN_LABEL = "Départ communiqué après acceptation";

/** Remplace {giver} (A), {executor} (B), {date}, {amount}… dans un libellé du réseau. */
export function networkText(template: string, vars: Record<string, string | null | undefined> = {}): string {
  return template.replace(/\{([a-z_]+)\}/g, (all, key: string) => vars[key] ?? all);
}

// =============================================================================
// Montants d'une course partagée — miroir de private.network_terms (§10.1, Q1 recommandé)
// =============================================================================


/** Champs de la course lus par private.network_terms. */
export interface NetworkTermsRideInput {
  price_cents: number | null | undefined;
  payment_method: PaymentMethod;
  /** Répartition stockée sur la course (A centrale, rides_centrale_split) : prioritaire sur le calcul, comme en SQL */
  commission_cents?: number | null;
  platform_fee_cents?: number | null;
}

/** Taux de A lus par private.network_terms (organizations + organization_settings). */
export interface NetworkTermsGiverInput {
  dispatch_model: DispatchModel;
  platform_fee_percent: number | string | null | undefined;
  platform_fee_fixed_cents: number | null | undefined;
  /** organization_settings.driver_commission_percent / _fixed_cents (A centrale) */
  driver_commission_percent?: number | string | null;
  driver_commission_fixed_cents?: number | null;
}

/**
 * Termes d'une course partagée (ride_offers.network_terms, figés dans ride_network_executions.terms à l'acceptation) :
 * ce que le partenaire voit est ce qui sera réglé. Comparaison OFFER_CHANGED : tous ces champs.
 */
export interface NetworkTerms {
  price_cents: number;
  payment_method: PaymentMethod;
  /** Espèces / carte à bord : le chauffeur encaisse le client */
  collects: boolean;
  /** Commission de A (centrale) ; 0 si A est une flotte */
  commission_cents: number;
  /** Frais Rydar de A (au taux de A) */
  platform_fee_cents: number;
  /** « Part de A » = commission + frais Rydar (seul montant montré au chauffeur avec sa part) */
  giver_cut_cents: number;
  /** Part du chauffeur = prix − part de A (> 0, sinon la course n'est pas partageable) */
  driver_payout_cents: number;
  /** driver_owes : le chauffeur reverse la part de A ; centrale_owes : A verse sa part au chauffeur */
  direction: SettlementDirection;
  /** driver_owes : part de A ; centrale_owes : part du chauffeur */
  amount_cents: number;
}

/** Course non partageable : sans prix, ou part du chauffeur ≤ 0. */
export type NetworkTermsRefusal = "no_price" | "no_payout";
export type NetworkTermsResult = { ok: true; terms: NetworkTerms } | { ok: false; reason: NetworkTermsRefusal };

/** Frais Rydar d'une course de FLOTTE (private.fleet_platform_fee) : % du prix + fixe, sans plafond au prix. */
function fleetFee(price: number, giver: NetworkTermsGiverInput): number {
  return Math.min(10_000_000, percentOfCents(Math.max(price, 0), giver.platform_fee_percent) + (giver.platform_fee_fixed_cents ?? 0));
}

/** Répartition d'une course de CENTRALE (private.compute_ride_split sans commission saisie). */
function centraleSplit(price: number, giver: NetworkTermsGiverInput): { commission: number; fee: number } {
  const fee = Math.min(price, percentOfCents(price, giver.platform_fee_percent) + (giver.platform_fee_fixed_cents ?? 0));
  const commission = Math.min(price - fee,
    percentOfCents(price, giver.driver_commission_percent) + (giver.driver_commission_fixed_cents ?? 0));
  return { commission, fee };
}

/**
 * Miroir EXACT de private.network_terms(r rides) (aperçu de l'onglet, exemple chiffré, tests) :
 *   • prix obligatoire (NULL → no_price) ;
 *   • A centrale : commission = rides.commission_cents, frais = rides.platform_fee_cents (répartition de la course,
 *     éventuellement saisie), repli private.compute_ride_split(A, prix, null) champ par champ ;
 *   • A flotte : commission = 0, frais = private.fleet_platform_fee(prix, % de A, fixe de A) — règle des flottes de
 *     20260924006400 (rides.platform_fee_cents, NULL en flotte ou hérité d'un passage en centrale, n'est pas lu) ;
 *   • part de A = commission + frais ; part du chauffeur = prix − part de A, ≤ 0 → no_payout (jamais partagée) ;
 *   • sens : espèces / carte → driver_owes (montant = part de A), sinon centrale_owes (montant = part du chauffeur).
 */
export function networkTerms(ride: NetworkTermsRideInput, giver: NetworkTermsGiverInput): NetworkTermsResult {
  if (ride.price_cents == null) return { ok: false, reason: "no_price" };
  const price = ride.price_cents;
  let commission = 0;
  let fee: number;
  if (giver.dispatch_model === "centrale") {
    const stored = { commission: ride.commission_cents ?? null, fee: ride.platform_fee_cents ?? null };
    const split = stored.commission == null || stored.fee == null ? centraleSplit(price, giver) : null;
    commission = stored.commission ?? split!.commission;
    fee = stored.fee ?? split!.fee;
  } else {
    fee = fleetFee(price, giver);
  }
  const giverCut = commission + fee;
  const payout = price - giverCut;
  if (payout <= 0) return { ok: false, reason: "no_payout" };
  const collects = ride.payment_method === "cash" || ride.payment_method === "card";
  return {
    ok: true,
    terms: {
      price_cents: price,
      payment_method: ride.payment_method,
      collects,
      commission_cents: commission,
      platform_fee_cents: fee,
      giver_cut_cents: giverCut,
      driver_payout_cents: payout,
      direction: collects ? "driver_owes" : "centrale_owes",
      amount_cents: collects ? giverCut : payout,
    },
  };
}

/**
 * Exemple chiffré de la carte « Partager mes courses non prises » (vrais taux de l'organisation) : course de 50 €
 * payée à bord (le chauffeur reverse) et déjà payée (l'organisation verse).
 */
export function networkShareExample(giver: NetworkTermsGiverInput, priceCents = 5_000) {
  const onBoard = networkTerms({ price_cents: priceCents, payment_method: "cash" }, giver);
  const prepaid = networkTerms({ price_cents: priceCents, payment_method: "online" }, giver);
  return { priceCents, onBoard: onBoard.ok ? onBoard.terms : null, prepaid: prepaid.ok ? prepaid.terms : null };
}

/** Une seule ligne d'argent pour le chauffeur (jamais commission ni frais Rydar, U4). */
export function networkMoneyLine(m: Pick<NetworkDriverMoney, "price_cents" | "currency" | "collects" | "driver_part_cents" | "giver_part_cents">,
  giverName: string): string {
  const price = formatPrice(m.price_cents, m.currency);
  return m.collects
    ? `Le client vous paie ${price} à bord · vous reverserez ${formatPrice(m.giver_part_cents, m.currency)} à ${giverName}`
    : `Course déjà payée à ${giverName} · ${giverName} vous versera ${formatPrice(m.driver_part_cents, m.currency)}`;
}

// =============================================================================
// Raisons : dispatch (journal), éligibilité, lisibilité, blocages
// =============================================================================

/** private.network_org_reason(p_org, p_dir) : NULL = éligible. */
export const NETWORK_ORG_REASONS = [
  "network_off", "org_inactive", "not_sharing", "not_receiving", "approval_pending", "suspended", "terms",
  "online_payment_method", "platform_fee", "payouts_overdue", "insurance",
] as const;
export type NetworkOrgReason = (typeof NETWORK_ORG_REASONS)[number];

/** private.network_ride_reason(r) : raison d'organisation (sens « out ») ou de la course. */
export type NetworkRideReason = NetworkOrgReason | NetworkTermsRefusal;

/** private.network_identity_block(chauffeur, A). */
export const NETWORK_IDENTITY_BLOCKS = ["banned", "debtor", "giver_driver", "excluded"] as const;
export type NetworkIdentityBlock = (typeof NETWORK_IDENTITY_BLOCKS)[number];

/**
 * private.network_blocker(chauffeur, A, montant) : règles LOCALES (§10.7). own_unpaid et executor_limit = règles de B
 * (garante) ; giver_unpaid et giver_credit_limit = règles de A, pour les seules courses de A.
 */
export const NETWORK_BLOCKERS = ["own_unpaid", "giver_unpaid", "giver_credit_limit", "executor_limit"] as const;
export type NetworkBlocker = (typeof NETWORK_BLOCKERS)[number];
/** Motif de blocage d'une offre (propre : DriverBlocker ; réseau : NetworkBlocker). */
export type OfferBlocker = DriverBlocker | NetworkBlocker;

/** private.network_driver_reason(d, r) : NULL = éligible ; « busy » → DRIVER_BUSY_AT_TIME à l'acceptation. */
export type NetworkDriverReason =
  | "consent" | "app_update" | "inactive" | "excluded_until" | "documents" | "operator_registration" | "busy"
  | NetworkIdentityBlock | NetworkBlocker;

/** Journal dispatch.network_skipped (data.reason) : la course n'est pas proposée au réseau. */
export type NetworkSkipReason = NetworkRideReason | "no_partner_nearby";

export const NETWORK_SKIP_REASON_LABELS: Record<NetworkSkipReason, string> = {
  network_off: "réseau partagé fermé",
  org_inactive: "organisation suspendue",
  not_sharing: "partage désactivé",
  not_receiving: "réception désactivée",
  approval_pending: "vérification Rydar en attente",
  suspended: "réseau partagé suspendu",
  terms: "convention à accepter",
  online_payment_method: "aucun moyen de paiement en ligne",
  platform_fee: "frais Rydar à définir",
  payouts_overdue: "versement réseau en retard",
  insurance: "assurance à confirmer",
  no_price: "course sans prix",
  no_payout: "part du chauffeur nulle",
  no_partner_nearby: "aucun chauffeur partenaire à proximité",
};

/** Messages de blocage réseau : {giver} = A (donneuse), {executor} = B (organisation du chauffeur). */
export const NETWORK_BLOCKER_META: Record<NetworkBlocker, { label: string; message: string; payable: boolean }> = {
  own_unpaid: {
    label: "Commissions à régler",
    message: "Commissions en retard ou contestées chez {executor} : réglez-les pour recevoir les courses partenaires.",
    payable: true,
  },
  giver_unpaid: {
    label: "Impayé envers {giver}",
    message: "Un impayé envers {giver} bloque seulement les courses de {giver} : réglez-le pour en recevoir à nouveau.",
    payable: true,
  },
  giver_credit_limit: {
    label: "Plafond de {giver} atteint",
    message: "Plafond de {giver} atteint : réglez vos courses de {giver} pour en recevoir d'autres.",
    payable: true,
  },
  executor_limit: {
    label: "Plafond de {executor} atteint",
    message: "Plafond de {executor} atteint : réglez d'abord vos courses partenaires.",
    payable: true,
  },
};

export const isNetworkBlocker = (reason: string | null | undefined): reason is NetworkBlocker =>
  !!reason && (NETWORK_BLOCKERS as readonly string[]).includes(reason);

/** Libellé et message d'un blocage réseau, noms des organisations insérés. */
export function networkBlockerMessage(reason: NetworkBlocker, names: { giver?: string | null; executor?: string | null }) {
  const vars = { giver: names.giver || "l'organisation", executor: names.executor || "votre organisation" };
  const meta = NETWORK_BLOCKER_META[reason];
  return { label: networkText(meta.label, vars), message: networkText(meta.message, vars), payable: meta.payable };
}

// -----------------------------------------------------------------------------
// Lisibilité : « pourquoi rien n'arrive » (org_network_readiness, network_driver_readiness, §6.4)
// -----------------------------------------------------------------------------

/** Actions proposées à côté d'une raison (le web et l'app les traduisent en liens / écrans). */
export type NetworkReadinessAction =
  // organisation (onglet « Réseau partagé »)
  | "enable_sharing" | "enable_receiving" | "accept_terms" | "edit_organization" | "edit_payment_methods"
  | "confirm_insurance" | "view_payouts" | "contact_rydar" | "allow_driver" | "review_documents" | "edit_driver"
  | "view_settlements"
  // chauffeur (app)
  | "enable_network" | "open_network_terms" | "update_app" | "open_documents" | "pay_own" | "pay_network";

export interface NetworkReadinessStep {
  action: NetworkReadinessAction;
  label: string;
}

/** Codes de l'organisation, dans l'ordre d'affichage (le SQL renvoie missing / warnings dans cet ordre). */
export const ORG_NETWORK_READINESS_CODES = [
  "network_off", "org_inactive", "suspended", "not_sharing", "not_receiving", "terms", "vtc_registration",
  "approval_refused", "approval_lost", "approval_pending", "online_payment_method", "insurance", "platform_fee",
  "payouts_overdue", "terms_grace",
] as const;
export type OrgNetworkReadinessCode = (typeof ORG_NETWORK_READINESS_CODES)[number];

export interface OrgNetworkReadinessMeta {
  label: string;
  hint: string;
  /** false : simple avertissement (le sens reste actif), ex. convention en délai de grâce */
  blocking: boolean;
  action: NetworkReadinessStep | null;
}

const CONTACT_RYDAR: NetworkReadinessStep = { action: "contact_rydar", label: "Contacter Rydar" };
const ACCEPT_TERMS: NetworkReadinessStep = { action: "accept_terms", label: "Lire la convention" };

export const ORG_NETWORK_READINESS_META: Record<OrgNetworkReadinessCode, OrgNetworkReadinessMeta> = {
  network_off: { label: "Réseau partagé fermé", hint: "Rydar n'a pas encore ouvert le réseau partagé.", blocking: true, action: null },
  org_inactive: {
    label: "Organisation suspendue",
    hint: "Votre organisation est suspendue ou archivée : le réseau partagé est indisponible.",
    blocking: true, action: CONTACT_RYDAR,
  },
  suspended: {
    label: "Réseau partagé suspendu",
    hint: "Rydar a suspendu votre participation pour manquement à la convention ou aux CGV. Les courses déjà acceptées vont à leur terme.",
    blocking: true, action: CONTACT_RYDAR,
  },
  not_sharing: {
    label: "Partage désactivé",
    hint: "Activez « Partager mes courses non prises » pour proposer au réseau les courses qu'aucun de vos chauffeurs n'accepte.",
    blocking: true, action: { action: "enable_sharing", label: "Activer le partage" },
  },
  not_receiving: {
    label: "Réception désactivée",
    hint: "Activez « Recevoir les courses du réseau » pour que vos chauffeurs reçoivent les courses des organisations partenaires.",
    blocking: true, action: { action: "enable_receiving", label: "Activer la réception" },
  },
  terms: {
    label: "Convention à accepter",
    hint: "Le propriétaire ou un administrateur doit lire et accepter la convention du réseau partagé.",
    blocking: true, action: ACCEPT_TERMS,
  },
  vtc_registration: {
    label: "N° d'inscription VTC manquant",
    hint: "Renseignez la raison sociale, le SIRET et le n° d'inscription au registre des exploitants VTC de votre organisation.",
    blocking: true, action: { action: "edit_organization", label: "Compléter" },
  },
  approval_refused: {
    label: "Inscription refusée par Rydar",
    hint: "Rydar n'a pas pu vérifier votre inscription au registre des exploitants VTC (motif ci-dessous).",
    blocking: true, action: CONTACT_RYDAR,
  },
  approval_lost: {
    label: "Nouvelle vérification nécessaire",
    hint: "Le nom, la raison sociale, le SIRET ou le n° VTC de votre organisation a changé : Rydar doit de nouveau vérifier votre inscription.",
    blocking: true, action: null,
  },
  approval_pending: {
    label: "Vérification Rydar en attente",
    hint: "Rydar vérifie votre inscription au registre des exploitants VTC (vérification administrative).",
    blocking: true, action: null,
  },
  online_payment_method: {
    label: "Moyen de paiement en ligne manquant",
    hint: "Un chauffeur partenaire ne passe pas à vos bureaux : ajoutez un lien de paiement ou un RIB ; les espèces restent possibles en plus.",
    blocking: true, action: { action: "edit_payment_methods", label: "Ajouter un moyen de paiement" },
  },
  insurance: {
    label: "Assurance à confirmer",
    hint: "Confirmez que votre assurance couvre les courses faites pour d'autres organisations.",
    blocking: true, action: { action: "confirm_insurance", label: "Confirmer" },
  },
  platform_fee: {
    label: "Frais Rydar à définir",
    hint: "Partager vos courses demande des frais Rydar réglés pour votre organisation : contactez Rydar.",
    blocking: true, action: CONTACT_RYDAR,
  },
  payouts_overdue: {
    label: "Versement en retard",
    hint: "Un versement à un chauffeur partenaire a plus de 7 jours de retard : réglez-le pour partager à nouveau.",
    blocking: true, action: { action: "view_payouts", label: "Voir les versements" },
  },
  terms_grace: {
    label: "Nouvelle convention",
    hint: "Une nouvelle version de la convention est à accepter avant le {date}.",
    blocking: false, action: ACCEPT_TERMS,
  },
};

/** Codes d'un chauffeur, dans l'ordre d'affichage (le premier manque est montré dans le profil de l'app). */
export const DRIVER_NETWORK_READINESS_CODES = [
  "network_off", "org_reception_off", "inactive", "org_disallowed", "driver_off", "terms", "app_update", "vtc_card",
  "insurance", "vehicle_registration", "driving_license", "vtc_card_number", "operator_registration", "excluded_until",
  "blocked:own_unpaid", "blocked:executor_limit", "terms_grace",
] as const;
export type DriverNetworkReadinessCode = (typeof DRIVER_NETWORK_READINESS_CODES)[number];

export interface DriverNetworkReadinessMeta {
  /** Libellé court, neutre (« Manque : … » chez B, profil de l'app) */
  label: string;
  /** Explication adressée au chauffeur */
  hint: string;
  blocking: boolean;
  /** Bouton dans l'app chauffeur */
  driver: NetworkReadinessStep | null;
  /** Bouton dans la liste des chauffeurs de B (owner / admin) */
  organization: NetworkReadinessStep | null;
}

const OPEN_DOCUMENTS: NetworkReadinessStep = { action: "open_documents", label: "Mes documents" };
const REVIEW_DOCUMENTS: NetworkReadinessStep = { action: "review_documents", label: "Voir les documents" };
const EDIT_DRIVER: NetworkReadinessStep = { action: "edit_driver", label: "Compléter la fiche" };
const DRIVER_TERMS: NetworkReadinessStep = { action: "open_network_terms", label: "Lire les conditions" };

export const DRIVER_NETWORK_READINESS_META: Record<DriverNetworkReadinessCode, DriverNetworkReadinessMeta> = {
  network_off: {
    label: "Réseau partagé fermé", hint: "Le réseau partagé n'est pas encore ouvert.", blocking: true, driver: null, organization: null,
  },
  org_reception_off: {
    label: "Réception non active",
    hint: "Votre organisation ne reçoit pas les courses du réseau partagé pour le moment.",
    blocking: true, driver: null, organization: { action: "enable_receiving", label: "Voir les réglages" },
  },
  inactive: {
    label: "Compte chauffeur inactif", hint: "Votre fiche chauffeur n'est pas active.",
    blocking: true, driver: null, organization: { action: "edit_driver", label: "Ouvrir la fiche" },
  },
  org_disallowed: {
    label: "Non autorisé par l'organisation",
    hint: "Votre organisation ne vous a pas autorisé à recevoir les courses du réseau partagé.",
    blocking: true, driver: null, organization: { action: "allow_driver", label: "Autoriser" },
  },
  driver_off: {
    label: "Courses du réseau désactivées",
    hint: "Activez « Courses du réseau partagé » dans votre profil.",
    blocking: true, driver: { action: "enable_network", label: "Activer" }, organization: null,
  },
  terms: {
    label: "Conditions à accepter", hint: "Lisez et acceptez les conditions du réseau partagé.",
    blocking: true, driver: DRIVER_TERMS, organization: null,
  },
  app_update: {
    label: "Application à mettre à jour",
    hint: "Ouvrez la dernière version de l'application Rydar Drive pour recevoir les courses partenaires.",
    blocking: true, driver: { action: "update_app", label: "Mettre à jour" }, organization: null,
  },
  vtc_card: {
    label: "Carte VTC à valider",
    hint: "Votre carte professionnelle VTC doit être validée et valable à la date de la course.",
    blocking: true, driver: OPEN_DOCUMENTS, organization: REVIEW_DOCUMENTS,
  },
  insurance: {
    label: "Assurance à valider",
    hint: "Votre attestation d'assurance doit être validée et valable à la date de la course.",
    blocking: true, driver: OPEN_DOCUMENTS, organization: REVIEW_DOCUMENTS,
  },
  vehicle_registration: {
    label: "Carte grise à valider",
    hint: "La carte grise de votre véhicule doit être validée et valable à la date de la course.",
    blocking: true, driver: OPEN_DOCUMENTS, organization: REVIEW_DOCUMENTS,
  },
  driving_license: {
    label: "Permis à valider",
    hint: "Votre permis de conduire doit être validé et valable à la date de la course.",
    blocking: true, driver: OPEN_DOCUMENTS, organization: REVIEW_DOCUMENTS,
  },
  vtc_card_number: {
    label: "N° de carte VTC manquant",
    hint: "Le n° de votre carte VTC doit figurer sur votre fiche : demandez à votre organisation de le renseigner.",
    blocking: true, driver: null, organization: EDIT_DRIVER,
  },
  operator_registration: {
    label: "N° d'exploitant VTC manquant",
    hint: "Votre n° d'inscription au registre des exploitants VTC doit figurer sur votre fiche : demandez à votre organisation de le renseigner.",
    blocking: true, driver: null, organization: EDIT_DRIVER,
  },
  excluded_until: {
    label: "Exclu temporairement",
    hint: "Plusieurs courses partagées vous ont été retirées : courses du réseau indisponibles jusqu'au {date}.",
    blocking: true, driver: null, organization: null,
  },
  "blocked:own_unpaid": {
    label: "Commissions à régler",
    hint: "Réglez vos commissions en retard auprès de votre organisation pour recevoir les courses du réseau.",
    blocking: true, driver: { action: "pay_own", label: "Régler" }, organization: { action: "view_settlements", label: "Voir les règlements" },
  },
  "blocked:executor_limit": {
    label: "Plafond atteint",
    hint: "Vous avez atteint le plafond des sommes dues aux organisations partenaires : réglez d'abord vos courses partenaires.",
    blocking: true, driver: { action: "pay_network", label: "Régler" }, organization: null,
  },
  terms_grace: {
    label: "Nouvelles conditions",
    hint: "De nouvelles conditions du réseau partagé sont à accepter avant le {date}.",
    blocking: false, driver: DRIVER_TERMS, organization: null,
  },
};

/** Libellés et actions de lisibilité (organisation et chauffeur). */
export const NETWORK_READINESS_META = {
  organization: ORG_NETWORK_READINESS_META,
  driver: DRIVER_NETWORK_READINESS_META,
} as const;

export interface NetworkTermsState {
  /** Version courante (platform_settings.network_terms_version) */
  version: string;
  /** Version précédente encore valable jusqu'à grace_until */
  min_version: string | null;
  grace_until: Iso | null;
}

/** Miroir de private.network_terms_ok(v) : version courante, ou version précédente pendant la grâce. */
export function networkTermsOk(accepted: string | null | undefined, terms: NetworkTermsState, now: Date = new Date()): boolean {
  if (!accepted) return false;
  if (accepted === terms.version) return true;
  return accepted === terms.min_version && !!terms.grace_until && now.getTime() < new Date(terms.grace_until).getTime();
}

export interface OrgNetworkSideReadiness {
  /** Sens effectif (toutes les conditions remplies) */
  active: boolean;
  /** Raisons bloquantes, dans l'ordre de ORG_NETWORK_READINESS_CODES */
  missing: OrgNetworkReadinessCode[];
  /** Avertissements non bloquants (terms_grace) */
  warnings: OrgNetworkReadinessCode[];
}

export type NetworkApprovalStatus = "none" | "pending" | "approved" | "refused" | "lost";

/** RPC org_network_readiness(p_org) (tout membre). */
export interface OrgNetworkReadiness {
  /** public.shared_network_enabled() */
  enabled: boolean;
  share_out: OrgNetworkSideReadiness;
  share_in: OrgNetworkSideReadiness;
  terms: NetworkTermsState & { accepted_version: string | null; accepted_at: Iso | null };
  approval: { status: NetworkApprovalStatus; requested_at: Iso | null; approved_at: Iso | null; refused_reason: string | null };
  suspended_reason: string | null;
}

/** RPC network_driver_readiness(p_driver) (owner / admin de B ; NULL = le chauffeur appelant). */
export interface NetworkDriverReadiness {
  ready: boolean;
  missing: DriverNetworkReadinessCode[];
  warnings: DriverNetworkReadinessCode[];
  /** terms_grace : fin du délai de grâce */
  terms_grace_until: Iso | null;
  /** excluded_until : fin de l'exclusion automatique */
  excluded_until: Iso | null;
}

// =============================================================================
// États d'une course partagée, journal, contrôles
// =============================================================================

export const NETWORK_SHARE_STATUSES = ["open", "accepted", "completed", "closed"] as const;
export type NetworkShareStatus = (typeof NETWORK_SHARE_STATUSES)[number];
export type NetworkShareStage = "instant" | "scheduled_window" | "scheduled_geo";

/** ride_network_shares.closed_reason */
export const NETWORK_SHARE_CLOSED_REASONS = [
  "cancelled", "no_driver", "redispatch", "removed_by_giver", "reassigned_own", "executor_unavailable", "executor_released",
  "window_elapsed", "flight_rescheduled", "error", "not_performed", "sharing_stopped",
] as const;
export type NetworkShareClosedReason = (typeof NETWORK_SHARE_CLOSED_REASONS)[number];

export const NETWORK_SHARE_CLOSED_LABELS: Record<NetworkShareClosedReason, string> = {
  cancelled: "Course annulée",
  no_driver: "Aucun chauffeur",
  redispatch: "Recherche relancée",
  removed_by_giver: "Retirée au partenaire",
  reassigned_own: "Attribuée à l'un de vos chauffeurs",
  executor_unavailable: "Chauffeur partenaire indisponible",
  executor_released: "Retirée par l'organisation du chauffeur",
  window_elapsed: "Rendue à vos chauffeurs avant la prise en charge",
  flight_rescheduled: "Vol retardé",
  error: "Interrompu (erreur)",
  not_performed: "Non effectuée",
  sharing_stopped: "Partage arrêté",
};

/**
 * ride_network_executions.end_reason. Course partagée terminée = toujours « completed », quelle que soit la voie
 * (clôture par A, close_network_ride : « closed_by_giver » dans suspect_reasons) : prédicat unique des règlements et
 * des frais Rydar.
 */
export const NETWORK_EXECUTION_END_REASONS = [
  "completed", "cancelled_by_giver", "removed_by_giver", "reassigned_own", "executor_released", "executor_unavailable",
  "not_performed",
] as const;
export type NetworkExecutionEndReason = (typeof NETWORK_EXECUTION_END_REASONS)[number];

export const NETWORK_EXECUTION_END_LABELS: Record<NetworkExecutionEndReason, string> = {
  completed: "Terminée",
  cancelled_by_giver: "Annulée par l'organisation",
  removed_by_giver: "Retirée au chauffeur",
  reassigned_own: "Attribuée à un autre chauffeur",
  executor_released: "Retirée par l'organisation du chauffeur",
  executor_unavailable: "Chauffeur indisponible",
  not_performed: "Non effectuée",
};

/** Contrôles de fin (private.network_completion_checks) : jamais un refus, la course est « à vérifier ». */
export const NETWORK_SUSPECT_REASONS = ["no_gps", "far_from_pickup", "far_from_dropoff", "too_fast", "closed_by_giver"] as const;
export type NetworkSuspectReason = (typeof NETWORK_SUSPECT_REASONS)[number];

export const NETWORK_SUSPECT_REASON_META: Record<NetworkSuspectReason, { label: string }> = {
  no_gps: { label: "Position absente pendant la course" },
  far_from_pickup: { label: "Arrivé à plus de 500 m du départ" },
  far_from_dropoff: { label: "Terminée à plus de 1 km de l'arrivée" },
  too_fast: { label: "Durée très inférieure à l'estimation" },
  closed_by_giver: { label: "Clôturée par l'organisation" },
};

/** Nouvelles valeurs de ride_offers.closed_reason (offres réseau). */
export type NetworkOfferClosedReason = "terms_changed" | "network_unavailable" | "flight_rescheduled" | "sharing_stopped" | "driver_busy";

/**
 * Retrait d'une course de A au chauffeur partenaire qui la tient, avant la prise en charge (private.unassign_network_ride,
 * 20260924006800) : A la reprend (« Retirer », public.reassign_ride) ; B la lui retire (public.ban_driver,
 * public.set_driver_status, retrait du réseau) ; chauffeur ou B indisponibles (chien de garde). Mêmes valeurs dans
 * ride_network_executions.end_reason et ride_network_shares.closed_reason.
 */
export const NETWORK_UNASSIGN_REASONS = ["removed_by_giver", "executor_released", "executor_unavailable"] as const;
export type NetworkUnassignReason = (typeof NETWORK_UNASSIGN_REASONS)[number];

/** Chien de garde (private.network_watch) : pourquoi le chauffeur partenaire ne peut plus faire la course. */
export const NETWORK_WATCH_CAUSES = ["driver_inactive", "executor_inactive", "executor_suspended", "driver_withdrawn"] as const;
export type NetworkWatchCause = (typeof NETWORK_WATCH_CAUSES)[number];

/** public.close_network_ride : clôture permise parce que la fiche ou l'organisation du chauffeur est inactive, ou sans position depuis 30 min. */
export const NETWORK_CLOSE_CAUSES = ["driver_inactive", "executor_inactive", "no_position"] as const;
export type NetworkCloseCause = (typeof NETWORK_CLOSE_CAUSES)[number];

/** Événements du journal de A (ride_events.type) propres au réseau. Jamais l'identifiant d'un chauffeur partenaire. */
export type NetworkRideEventType =
  | "dispatch.network" | "dispatch.network_skipped" | "dispatch.network_error"
  | "ride.network_unassigned" | "ride.network_closed" | "network.executor_unavailable";
export interface NetworkRideEventData {
  "dispatch.network": { partners_nearby: number; stage?: NetworkShareStage; cycle?: number };
  "dispatch.network_skipped": { reason: NetworkSkipReason };
  "dispatch.network_error": { errors: number };
  /**
   * Course retirée au partenaire et remise en recherche chez A (niveau warning ; acteur : le membre de A pour
   * removed_by_giver, le système sinon — jamais un membre de B). note : motif saisi par A.
   */
  "ride.network_unassigned": {
    network: true; reason: NetworkUnassignReason; execution_id: Uuid | null; previous_status: RideStatus; type: RideType;
    auto: boolean; closed_alerts: number; closed_offers: number; note?: string;
  };
  /** Clôturée par A (public.close_network_ride) : « à vérifier » */
  "ride.network_closed": { network: true; execution_id: Uuid | null; cause: NetworkCloseCause; previous_status: RideStatus };
  /** Alerte (niveau warning, une fois par exécution) : partenaire indisponible, client à bord — il peut terminer, sinon A clôture */
  "network.executor_unavailable": { network: true; execution_id: Uuid | null; cause: NetworkWatchCause; status: RideStatus };
}

/**
 * public.reassign_ride (« Retirer ») sur une course tenue par un chauffeur partenaire : réponse de même forme que pour un
 * chauffeur propre, sans l'identifiant du partenaire ; la recherche repart avec les chauffeurs de A (dispatch
 * automatique coupé : UNASSIGNED, course à attribuer).
 */
export interface NetworkReassignResult {
  ok: true;
  code: "RELAUNCHED" | "UNASSIGNED";
  message: string;
  ride_id: Uuid;
  previous_driver_id: null;
  type: RideType;
  status: RideStatus;
  notified: number;
  closed_alerts: number;
  network: true;
}

/**
 * Notifications du chauffeur partenaire propres au réseau (notifications.data ; lignes chez A, lisibles par lui seul),
 * jamais d'adresse précise. « COURSE RETIRÉE — {A} » (type existant ride_unassigned) : retrait avant la prise en charge
 * ou course confiée par A à l'un de ses chauffeurs (reassigned_own) ; ses autres notifications de la course (offre,
 * rappels) sont supprimées.
 */
export interface NetworkRideUnassignedNotificationData {
  type: "ride_unassigned";
  ride_id: Uuid;
  network: true;
  giver: string;
  reason: NetworkUnassignReason | "reassigned_own";
}

/** « ORGANISATION SUSPENDUE — {A} » (une fois par suspension ; private.network_watch) : courses acceptées au bout, règlements toujours dus. */
export interface NetworkGiverSuspendedNotificationData {
  type: "network_giver_suspended";
  network: true;
  giver: string;
  /** Course acceptée la plus proche, s'il y en a une */
  ride_id?: Uuid;
}

/**
 * Codes de public.accept_ride_offer (offre propre ou réseau, 20260924006800). Ajoutés par le réseau : OFFER_CHANGED
 * (termes changés depuis l'offre : elle est fermée « terms_changed » et reproposée si la course est encore disponible)
 * et DRIVER_BUSY_AT_TIME (créneau pris par une course d'une autre organisation que le chauffeur, dans les deux sens ;
 * aussi public.assign_ride). Offre réseau devenue inéligible (partage, paire, chauffeur) : OFFER_CLOSED.
 */
export const ACCEPT_OFFER_CODES = [
  "ACCEPTED", "OFFER_NOT_FOUND", "RIDE_CANCELLED", "SEARCH_ENDED", "RIDE_ALREADY_ASSIGNED", "OFFER_CHANGED", "OFFER_CLOSED",
  "OFFER_EXPIRED", "DRIVER_BLOCKED", "DRIVER_BUSY", "DRIVER_BUSY_AT_TIME",
] as const;
export type AcceptOfferCode = (typeof ACCEPT_OFFER_CODES)[number];

/**
 * Réponse de public.accept_ride_offer. DRIVER_BLOCKED d'une offre réseau : reason = NetworkBlocker (règle locale de A
 * ou de B, offre laissée ouverte) et message avec les noms des organisations (private.network_blocker_message).
 */
export interface AcceptOfferResult {
  ok: boolean;
  code: AcceptOfferCode;
  message?: string;
  reason?: OfferBlocker;
  ride_id?: Uuid;
}

/** Actions d'audit (audit_logs.action) du réseau. */
export type NetworkAuditAction =
  | "platform.shared_network_enabled" | "platform.shared_network_disabled" | "network.approved" | "network.refused" | "network.approval_lost"
  | "network.suspended" | "network.restored" | "network.settings" | "network.terms_accepted" | "network.exclusion"
  | "network.driver_excluded" | "network.driver_exclusion_lifted" | "network.driver_auto_excluded"
  | "network.payout_info_viewed" | "network.ride_contested" | "network.ride_validated" | "network.ride_closed"
  | "driver.network_consent";

// =============================================================================
// Lignes lisibles par le client (RLS : lignes de sa propre organisation)
// =============================================================================

/** public.network_memberships (policy : membres de l'organisation, super admin ; écriture par RPC). */
export interface NetworkMembership {
  organization_id: Uuid;
  share_out: boolean;
  share_in: boolean;
  terms_version: string | null;
  terms_accepted_at: Iso | null;
  terms_accepted_by: Uuid | null;
  requested_at: Iso | null;
  approved_at: Iso | null;
  approved_by: Uuid | null;
  /** Instantané validé, montré aux partenaires (un changement de nom ou de n° fait perdre la validation) */
  approved_legal_name: string | null;
  approved_siret: string | null;
  approved_vtc_registration: string | null;
  fee_waiver: boolean;
  refused_reason: string | null;
  insurance_confirmed_at: Iso | null;
  insurance_confirmed_by: Uuid | null;
  /** Plafond par chauffeur de B (centimes, 0–100 000, défaut 15 000) */
  executor_credit_limit_cents: number;
  suspended_at: Iso | null;
  suspended_reason: string | null;
  suspended_by: Uuid | null;
  created_at: Iso;
  updated_at: Iso;
  updated_by: Uuid | null;
}

/** public.network_exclusions (symétrique ; visible seulement par l'organisation qui l'a posée). */
export interface NetworkExclusion {
  organization_id: Uuid;
  excluded_org_id: Uuid;
  created_at: Iso;
  created_by: Uuid | null;
}

/** public.driver_network_settings (policy : membres de B, le chauffeur lui-même, super admin). */
export interface DriverNetworkSettings {
  driver_id: Uuid;
  organization_id: Uuid;
  enabled: boolean;
  accepted_version: string | null;
  accepted_at: Iso | null;
  org_allowed: boolean;
  org_updated_at: Iso | null;
  org_updated_by: Uuid | null;
  capable_at: Iso | null;
  excluded_until: Iso | null;
  updated_at: Iso;
}

// =============================================================================
// Instantanés figés à l'acceptation (ride_network_executions)
// =============================================================================

/** ride_network_executions.operator : instantané validé de B (carte permanente chez A, bon de réservation). */
export interface NetworkOperatorSnapshot {
  organization_id: Uuid;
  name: string;
  legal_name: string;
  siret: string;
  vtc_registration: string;
  phone: string | null;
  email: string | null;
  dispatch_model: DispatchModel;
  /** B centrale : n° d'exploitant VTC du chauffeur indépendant (drivers.vtc_operator_registration) */
  driver_operator_registration: string | null;
}

/** ride_network_executions.vehicle (rides.vehicle_id à l'acceptation). */
export interface NetworkVehicleSnapshot {
  brand: string | null;
  model: string;
  color: string | null;
  plate: string;
  category: VehicleCategory;
  seats: number;
}

/** ride_network_executions.checks : preuve de diligence montrée à A (sans les pièces). Dates AAAA-MM-JJ. */
export interface NetworkDriverChecks {
  vtc_card_number: string;
  vtc_card_expires_on: string | null;
  insurance_expires_on: string | null;
  vehicle_registration_expires_on: string | null;
  driving_license_expires_on: string | null;
  /** Dernière validation des pièces par B */
  verified_at: Iso | null;
}

/** Résumé d'une exécution vu par A (liste « Courses confiées », fiche course). */
export interface NetworkExecutionSummary {
  id: Uuid;
  accepted_at: Iso;
  ended_at: Iso | null;
  end_reason: NetworkExecutionEndReason | null;
  /** « Karim B. » (jamais le nom de famille ni le n° interne) */
  driver_label: string;
  partner: { id: Uuid; name: string };
  vehicle: NetworkVehicleSnapshot;
  terms: NetworkTerms;
  counterparty: NetworkCounterparty;
  suspect_reasons: NetworkSuspectReason[];
  /** Versement prépayé retenu (course « à vérifier ») jusqu'à hold_until, sauf validation */
  on_hold: boolean;
  hold_until: Iso | null;
  contested_at: Iso | null;
  contested_reason: string | null;
  driver_disputed_at: Iso | null;
  driver_dispute_reason: string | null;
}

// =============================================================================
// Règlements réseau (ride_settlements : network_driver_org_id non NULL, driver_id NULL)
// =============================================================================

/** Bloc « network » ajouté par private.settlement_json aux lignes réseau (vues de A). */
export interface SettlementNetworkInfo {
  execution_id: Uuid;
  counterparty: NetworkCounterparty;
  /** Nom validé de B */
  partner_name: string;
  driver_label: string;
  on_hold: boolean;
  hold_until: Iso | null;
  suspect_reasons: NetworkSuspectReason[];
  contested: boolean;
  driver_disputed: boolean;
  driver_dispute_reason: string | null;
}

/**
 * Règlement réseau vu par le chauffeur : un seul montant par sens, JAMAIS la commission ni les frais Rydar de A (U4).
 * Aussi la charge utile de « settlement.updated » sur driver:{network_driver_id} (jamais settlement_json).
 */
export interface DriverNetworkSettlementItem {
  id: Uuid;
  ride_id: Uuid;
  /** « R1783 » (numéro de course de A) */
  reference: string;
  direction: SettlementDirection;
  amount_cents: number;
  price_cents: number;
  driver_part_cents: number;
  giver_part_cents: number;
  currency: string;
  payment_method: PaymentMethod;
  status: SettlementStatus;
  overdue: boolean;
  on_hold: boolean;
  hold_until: Iso | null;
  due_at: Iso;
  declared_at: Iso | null;
  declared_method: SettlementMethod | null;
  settled_at: Iso | null;
  settled_method: SettlementMethod | "other" | null;
  /** « Pas reçu » posé par A */
  disputed_at: Iso | null;
  driver_disputed_at: Iso | null;
  driver_dispute_reason: string | null;
  /** « Je conteste » encore possible (une fois par ligne) */
  can_dispute: boolean;
  /** Communes seulement (adresse exacte non conservée dans les règlements) */
  ride: { number: number; pickup: string; dropoff: string; completed_at: Iso | null };
}

export interface DriverNetworkSettlementEvent {
  action: "created" | "updated" | "declared" | "paid" | "disputed" | "waived" | "reopened";
  network: true;
  item: DriverNetworkSettlementItem;
}

export interface NetworkSettlementTotals {
  /** À régler (dû + « Pas reçu ») */
  owed_cents: number;
  overdue_cents: number;
  /** Signalé payé, en attente de confirmation par A */
  declared_cents: number;
  /** À recevoir de A (versements payables) */
  payout_due_cents: number;
  /** À recevoir, retenu (course « à vérifier ») */
  on_hold_cents: number;
}

/** Une organisation créancière ou débitrice du chauffeur (moyens de paiement de CETTE organisation). */
export interface DriverNetworkCreditor {
  organization: { id: Uuid; name: string; phone: string | null };
  currency: string;
  /** Délai de A, au moins 48 h */
  grace_hours: number;
  summary: NetworkSettlementTotals;
  /** Tout ce qui est à régler à cette organisation (null : rien) */
  pay: {
    amount_cents: number;
    count: number;
    settlement_ids: Uuid[];
    /** « RP-{4 car.}-{JJMM} » */
    reference: string;
    link: string | null;
    /** Domaine du lien affiché (S21) */
    link_domain: string | null;
    methods: SettlementMethod[];
    bank: SettlementBank | null;
    instructions: string | null;
  } | null;
  blocked: NetworkBlocker | null;
  blocked_message: string | null;
  items: DriverNetworkSettlementItem[];
}

/** RPC driver_network_settlements() : un bloc par organisation (lignes network_driver_id = moi). */
export interface DriverNetworkSettlements {
  currency: string;
  summary: NetworkSettlementTotals;
  organizations: DriverNetworkCreditor[];
}

/** RPC driver_declare_network_payment(p_org, p_ids, p_method, p_note). */
export interface DriverDeclareNetworkPaymentResult {
  ok: boolean;
  code: "DECLARED" | "INVALID_METHOD" | "NOTHING_TO_DECLARE";
  message?: string;
  count?: number;
  amount_cents?: number;
  settlement_ids?: Uuid[];
}

/** RPC driver_payout_info() / driver_set_payout_details / driver_delete_payout_details : IBAN toujours masqué. */
export interface DriverPayoutInfo {
  configured: boolean;
  payee_name: string | null;
  /** 4 derniers caractères de l'IBAN (jamais l'IBAN complet : il se ressaisit pour être modifié) */
  iban_last4: string | null;
  bic: string | null;
  updated_at: Iso | null;
  /** Versement réseau ouvert : suppression refusée (PAYOUT_DETAILS_IN_USE), modification possible */
  in_use: boolean;
}

// =============================================================================
// Chauffeur partenaire (portée private.current_driver_id())
// =============================================================================

/** Organisation qui confie la course (instantané validé). */
export interface NetworkGiverInfo {
  name: string;
  legal_name: string | null;
  vtc_registration: string | null;
}

/** Argent d'une course partenaire vu par le chauffeur : prix, sa part, la part de A, rien d'autre. */
export interface NetworkDriverMoney {
  price_cents: number;
  currency: string;
  payment_method: PaymentMethod;
  collects: boolean;
  driver_part_cents: number;
  giver_part_cents: number;
  direction: SettlementDirection;
  amount_cents: number;
  counterparty: NetworkCounterparty;
}

/** Bloc « network » d'une offre partenaire (driver_offers_v2). */
export interface NetworkOfferInfo {
  giver: NetworkGiverInfo;
  /** « 75011 Paris » (private.address_area) ; null : NETWORK_PICKUP_HIDDEN_LABEL */
  pickup_area: string | null;
  /** Commune d'arrivée seulement */
  dropoff_area: string | null;
  money: NetworkDriverMoney;
}

/**
 * Élément de driver_offers_v2() : offres propres (network = null, comme driver_offers) et offres partenaires
 * (network ≠ null). Offre partenaire : pickup_address = pickup_area (ou NETWORK_PICKUP_HIDDEN_LABEL), dropoff_address =
 * dropoff_area, coordonnées arrondies à NETWORK_PARAMS.coordStepDegrees, distance_m = distance au départ arrondi ;
 * route_polyline, flight_number, comment, commission_cents, platform_fee_cents = null ; driver_payout_cents = part du
 * chauffeur, driver_collects = collects ; dispatch_model = null ; blocked = NetworkBlocker (private.network_blocker).
 */
export type DriverOfferV2 = Omit<DriverOffer, "blocked"> & {
  network: NetworkOfferInfo | null;
  blocked?: OfferBlocker | null;
  /** Message serveur (noms insérés) ; repli : DRIVER_BLOCKER_META / networkBlockerMessage */
  blocked_message?: string | null;
};

/** Argent d'une course dans driver_ride (propre ou partenaire). Flotte propre : parts et sens NULL (S20). */
export interface DriverRideMoney {
  price_cents: number | null;
  currency: string;
  payment_method: PaymentMethod;
  collects: boolean;
  /** « Vous gagnez » : centrale propre ou course partenaire ; null en flotte */
  driver_part_cents: number | null;
  /** « Part de {organisation} » ; null en flotte (jamais les frais Rydar d'une flotte) */
  giver_part_cents: number | null;
  direction: SettlementDirection | null;
  amount_cents: number | null;
  counterparty: NetworkCounterparty | null;
  /** Organisation à régler / qui verse (A pour une course partenaire) */
  creditor_name: string | null;
}

/** Bon de réservation (§7.5), affiché sur TOUTES les courses de l'app. */
export interface BookingVoucher {
  /** Organisation qui a pris la réservation (A) */
  booked_by: { name: string; legal_name: string | null; vtc_registration: string | null; phone: string | null };
  /** Exploitant qui exécute : B flotte (organisation) ; B centrale (chauffeur indépendant + son n° d'exploitant) */
  operator: { kind: "organization" | "driver"; name: string; vtc_registration: string | null };
  booked_at: Iso;
  pickup_at: Iso;
  pickup_address: string;
  /** null hors de la fenêtre client (§11.1) */
  customer: { name: string; phone: string | null } | null;
  /** « Reçu ou facture du client : délivré par {A} » */
  receipt_by: string;
}

/**
 * RPC driver_ride(p_ride) et driver_rides_upcoming() : liste blanche des champs de l'app pour SES courses (propres et
 * partenaires) ; course non tenue par le chauffeur → RIDE_NOT_FOUND. Course partenaire : adresse exacte, coordonnées,
 * tracé et commentaire après acceptation ; client dans la fenêtre seulement (chaque réponse qui le contient est
 * comptée pour A).
 */
export interface DriverRide extends Partial<Omit<RideFlightFields, "flight_checked_at">> {
  id: Uuid;
  number: number;
  type: RideType;
  status: RideStatus;
  pickup_address: string;
  pickup_lat: number;
  pickup_lng: number;
  dropoff_address: string;
  dropoff_lat: number | null;
  dropoff_lng: number | null;
  pickup_at: Iso;
  /** Date de la réservation (bon de réservation) */
  created_at: Iso;
  accepted_at: Iso | null;
  completed_at: Iso | null;
  cancelled_at: Iso | null;
  cancel_reason: string | null;
  passengers: number;
  luggage: number;
  vehicle_category: VehicleCategory;
  estimated_distance_m: number | null;
  estimated_duration_s: number | null;
  route_polyline: string | null;
  flight_number: string | null;
  comment: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  /** Course partenaire : fenêtre de visibilité du client ; null pour une course propre */
  customer_visible_from: Iso | null;
  customer_visible_until: Iso | null;
  price_cents: number | null;
  currency: string;
  payment_method: PaymentMethod;
  money: DriverRideMoney;
  /** Course partenaire (null : course de sa propre organisation) */
  network: {
    execution_id: Uuid;
    giver: NetworkGiverInfo & { phone: string | null; phone_until: Iso | null };
  } | null;
  voucher: BookingVoucher;
}

/** RPC driver_network_state() / driver_set_network(p_enabled, p_version). */
export interface DriverNetworkState {
  enabled: boolean;
  org_allowed: boolean;
  accepted_version: string | null;
  accepted_at: Iso | null;
  terms: NetworkTermsState;
  /** consent : « J'accepte » (indépendant) ; notice : « J'ai compris » (salarié de flotte, information) */
  mode: "consent" | "notice";
  organization: { id: Uuid; name: string; dispatch_model: DispatchModel; receiving: boolean };
  capable_at: Iso | null;
  excluded_until: Iso | null;
  readiness: NetworkDriverReadiness;
  payout: DriverPayoutInfo;
}

/** driver_home().network (lot argent, 20260924006900). */
export interface DriverHomeNetwork {
  owed_cents: number;
  overdue_cents: number;
  payout_due_cents: number;
  creditors: { id: Uuid; name: string; owed_cents: number; overdue_cents: number; blocked: NetworkBlocker | null }[];
  readiness: NetworkDriverReadiness;
}

/** driver_deletion_debt().network : dettes partenaires rappelées avant la suppression du compte. */
export interface DriverDeletionNetworkDebt {
  organization: string;
  owed_cents: number;
  declared_cents: number;
}

// =============================================================================
// Organisation A (donneuse) — lecture : tout membre ; argent : owner / admin
// =============================================================================

export const NETWORK_GIVEN_FILTERS = [
  { key: "all", label: "Toutes" },
  { key: "in_progress", label: "En cours" },
  { key: "to_check", label: "À vérifier" },
  { key: "to_confirm", label: "À confirmer" },
  { key: "overdue", label: "En retard" },
  { key: "disputed", label: "Contestées" },
  { key: "to_pay", label: "À verser" },
  { key: "settled", label: "Réglées" },
] as const;
export type NetworkGivenFilter = (typeof NETWORK_GIVEN_FILTERS)[number]["key"];

/** RPC org_network_summary(p_org) : bande d'indicateurs (+ pastille de navigation). */
export interface OrgNetworkSummary {
  currency: string;
  readiness: OrgNetworkReadiness;
  given: {
    /** Proposées au réseau en ce moment */
    searching: number;
    /** Tenues par un partenaire en ce moment */
    in_progress: number;
    to_collect_cents: number;
    to_confirm_count: number;
    to_pay_cents: number;
    to_check_count: number;
    overdue_cents: number;
    overdue_count: number;
    disputed_count: number;
  };
  received: { in_progress: number; month_rides: number };
  /** Pastille : à confirmer + en retard + à vérifier */
  badge: number;
}

export interface NetworkGivenItem {
  ride: {
    id: Uuid;
    number: number;
    type: RideType;
    status: RideStatus;
    pickup_at: Iso;
    completed_at: Iso | null;
    pickup_address: string;
    dropoff_address: string;
    customer_name: string;
    currency: string;
  };
  execution: NetworkExecutionSummary;
  /** settlement_json (bloc network compris) ; null tant que la course n'est pas terminée */
  settlement: (Settlement & { network: SettlementNetworkInfo }) | null;
}

/** RPC org_network_given(p_org, p_filter, p_partner, p_month, p_limit, p_before) : « Courses confiées ». */
export interface OrgNetworkGiven {
  filter: NetworkGivenFilter;
  items: NetworkGivenItem[];
  /** Curseur de la page suivante (accepted_at du dernier élément), null en fin de liste */
  next_before: Iso | null;
}

/** RPC org_network_ride(p_ride) : bloc « Réseau partagé » de la fiche course (jamais d'id de partenaire non retenu). */
export interface OrgNetworkRide {
  ride_id: Uuid;
  share: {
    status: NetworkShareStatus;
    cycle: number;
    stage: NetworkShareStage;
    opened_at: Iso;
    /** Compteur seulement */
    partners_offered: number;
    closed_at: Iso | null;
    closed_reason: NetworkShareClosedReason | null;
  } | null;
  execution: (NetworkExecutionSummary & {
    checks: NetworkDriverChecks;
    /** Fenêtre §11.1 (de l'acceptation à fin + 48 h, prolongée tant qu'un règlement est ouvert) */
    driver_phone: string | null;
    driver_phone_until: Iso | null;
    client_data: { reads: number; first_read_at: Iso | null; last_read_at: Iso | null };
  }) | null;
  /** Carte permanente de B (instantané validé + téléphone, e-mail) */
  operator: NetworkOperatorSnapshot | null;
  /** Exécutants précédents (retraits), du plus récent au plus ancien */
  previous: NetworkExecutionSummary[];
  settlement: (Settlement & { network: SettlementNetworkInfo }) | null;
  /** Actions permises à l'appelant (rôle, statut, délais) */
  can: { remove: boolean; close: boolean; validate: boolean; contest: boolean; exclude_driver: boolean; exclude_partner: boolean };
}

export type NetworkPayoutWarning = "iban_changed" | "recent_change";

/** RPC org_network_payout_info(p_settlement) (owner / admin ; consultation journalisée et notifiée au chauffeur). */
export interface OrgNetworkPayoutInfo {
  settlement_id: Uuid;
  amount_cents: number;
  currency: string;
  reference: string;
  payee_name: string;
  iban: string;
  bic: string | null;
  /** Dernière modification du RIB par le chauffeur */
  updated_at: Iso;
  warnings: NetworkPayoutWarning[];
}

/** RPC validate_network_ride(p_ride) : lève la retenue du versement. */
export interface ValidateNetworkRideResult {
  ok: true;
  ride_id: Uuid;
  settlement: Settlement | null;
}

/** RPC contest_network_ride(p_ride, p_reason) (≤ 7 jours après la fin, NETWORK_CONTEST_EXPIRED sinon). */
export interface ContestNetworkRideResult {
  ok: true;
  ride_id: Uuid;
  /** Versement (centrale_owes) annulé ; un reversement (driver_owes) reste inchangé */
  settlement: Settlement | null;
  /** Demande de baisse des frais Rydar (écriture « correction » en attente du super admin) */
  fee_reduction: { entry_id: Uuid; amount_cents: number } | null;
}

/** RPC close_network_ride(p_ride) (NETWORK_CLOSE_NOT_ALLOWED sinon). */
export interface CloseNetworkRideResult {
  ok: true;
  ride_id: Uuid;
  status: "COMPLETED";
}

/** RPC remind_network_driver(p_org, p_settlement) : application seulement, 1 par 30 min. */
export interface RemindNetworkDriverResult {
  ok: boolean;
  code: "REMINDED" | "TOO_SOON" | "NOTHING_DUE";
  message?: string;
  next_allowed_at?: Iso | null;
}

/** private.network_driver_exclusions vu par A (org_network_driver_exclusions). */
export interface NetworkDriverExclusion {
  id: Uuid;
  /** « Karim B. · Flotte B » */
  label: string;
  reason: string | null;
  created_at: Iso;
  created_by_name: string | null;
  lifted_at: Iso | null;
}

/** RPC exclude_network_driver(p_execution, p_reason). */
export interface ExcludeNetworkDriverResult {
  ok: true;
  exclusion: NetworkDriverExclusion;
  closed_offers: number;
}

/** RPC network_partner_names(p_org) : { id de l'organisation : nom validé } des organisations déjà rencontrées. */
export type NetworkPartnerNames = Record<Uuid, string>;

/** RPC set_network_settings(…) : réglages de l'organisation (owner / admin). */
export interface OrgNetworkSettingsResult {
  ok: true;
  membership: NetworkMembership;
  readiness: OrgNetworkReadiness;
  /** Offres réseau fermées par une coupure de partage ou de réception */
  closed_offers: number;
}

// =============================================================================
// Organisation B (exécutante) — jamais le client, l'adresse exacte ni le détail de la part de A
// =============================================================================

export const NETWORK_RECEIVED_FILTERS = [
  { key: "all", label: "Toutes" },
  { key: "in_progress", label: "En cours" },
  { key: "open", label: "Règlement en cours" },
  { key: "overdue", label: "En retard" },
  { key: "to_check", label: "À vérifier" },
  { key: "settled", label: "Réglées" },
] as const;
export type NetworkReceivedFilter = (typeof NETWORK_RECEIVED_FILTERS)[number]["key"];

export interface NetworkReceivedItem {
  execution_id: Uuid;
  /** « R1783 » */
  reference: string;
  accepted_at: Iso;
  ended_at: Iso | null;
  end_reason: NetworkExecutionEndReason | null;
  ride: { type: RideType; status: RideStatus; pickup_at: Iso; completed_at: Iso | null; pickup_area: string | null; dropoff_area: string | null };
  /** Fiche de B (null : supprimée) */
  driver: { id: Uuid; number: number; first_name: string; last_name: string } | null;
  vehicle: NetworkVehicleSnapshot;
  giver: { id: Uuid; name: string; phone: string | null };
  money: { price_cents: number; currency: string; payment_method: PaymentMethod; driver_part_cents: number; direction: SettlementDirection; amount_cents: number };
  settlement: { status: SettlementStatus; overdue: boolean; due_at: Iso; on_hold: boolean; driver_disputed: boolean } | null;
  to_check: boolean;
  contested: boolean;
}

/** RPC org_network_received(p_org, p_filter, p_partner, p_month, p_limit, p_before) : « Courses reçues ». */
export interface OrgNetworkReceived {
  filter: NetworkReceivedFilter;
  items: NetworkReceivedItem[];
  next_before: Iso | null;
}

/** RPC org_network_activity(p_org) : ses chauffeurs en course partenaire (sans position, Q5) et créneaux pris. */
export interface OrgNetworkActivity {
  on_ride: { driver: { id: Uuid; number: number; first_name: string; last_name: string }; giver: { id: Uuid; name: string }; phase: RideStatus; since: Iso }[];
  scheduled: { driver: { id: Uuid; number: number; first_name: string; last_name: string }; giver: { id: Uuid; name: string }; pickup_at: Iso; until: Iso }[];
}

/** RPC org_network_drivers(p_org) (owner / admin de B) : liste « Prêt » / « Manque : … » des Réglages. */
export interface OrgNetworkDriver {
  driver: { id: Uuid; number: number; first_name: string; last_name: string; status: DriverStatus };
  settings: Pick<DriverNetworkSettings, "enabled" | "org_allowed" | "accepted_version" | "capable_at" | "excluded_until"> | null;
  vtc_operator_registration: string | null;
  readiness: NetworkDriverReadiness;
}

/** RPC set_driver_network_allowed(p_driver, p_allowed) (owner / admin de B). */
export interface SetDriverNetworkAllowedResult {
  ok: true;
  driver_id: Uuid;
  allowed: boolean;
  closed_offers: number;
}

/** driver_stats(p_driver) / org_stats(p_org) : chiffres de B + nombre de courses partenaires (sans montants de A). */
export interface NetworkStatsFields {
  network_rides: number;
}

// =============================================================================
// Super admin (/admin/reseau)
// =============================================================================

/** RPC svc_set_shared_network_enabled(p_actor, p_enabled) (modèle svc_set_booking_sites_enabled). */
export interface SvcSharedNetworkResult {
  ok: boolean;
  code?: "INVALID";
  message?: string;
  enabled?: boolean;
  changed?: boolean;
  /** Coupure : offres réseau en attente fermées */
  closed_offers?: number;
}

/** RPC svc_network_approve(p_actor, p_org, p_approved, p_fee_waiver, p_reason). */
export interface SvcNetworkApproveResult {
  ok: boolean;
  code: "APPROVED" | "REFUSED" | "NOT_FOUND" | "IDENTITY_INCOMPLETE" | "REASON_REQUIRED";
  message?: string;
  /**
   * IDENTITY_INCOMPLETE : champs de l'organisation vides OU invalides pour l'instantané (raison sociale 2 à 160
   * caractères, SIRET 14 chiffres une fois espaces et séparateurs retirés, n° VTC 3 à 120 caractères) : la saisie des
   * réglages est libre, svc_network_approve normalise puis contrôle chaque champ (jamais d'erreur 23514).
   */
  missing?: ("legal_name" | "siret" | "vtc_registration")[];
  membership?: NetworkMembership;
}

/** RPC svc_network_suspend(p_actor, p_org, p_suspended, p_reason). */
export interface SvcNetworkSuspendResult {
  ok: boolean;
  code: "SUSPENDED" | "RESTORED" | "NOT_FOUND" | "REASON_REQUIRED";
  message?: string;
  closed_offers?: number;
  /** Courses non commencées remises en recherche chez A */
  released_rides?: number;
}

/** Seuils signalés dans /admin/reseau (30 jours). */
export const NETWORK_ADMIN_THRESHOLDS = {
  minAcceptanceRatio: 0.2,
  minOffersForRatio: 20,
  releases: 3,
  contests: 2,
  payoutOverdueDays: 7,
} as const;
export type NetworkAdminFlag = "low_acceptance" | "releases" | "contests" | "payout_overdue";

export interface AdminNetworkOrgRow {
  id: Uuid;
  name: string;
  legal_name: string | null;
  siret: string | null;
  vtc_registration: string | null;
  dispatch_model: DispatchModel;
  status: OrgStatus;
  share_out: boolean;
  share_in: boolean;
  approval: NetworkApprovalStatus;
  requested_at: Iso | null;
  approved_at: Iso | null;
  refused_reason: string | null;
  terms_version: string | null;
  terms_ok: boolean;
  fee_waiver: boolean;
  platform_fee_percent: number;
  platform_fee_fixed_cents: number;
  suspended_at: Iso | null;
  suspended_reason: string | null;
  stats_30d: {
    rides_given: number;
    rides_received: number;
    offers_received: number;
    offers_accepted: number;
    offers_declined: number;
    offers_expired: number;
    releases_after_accept: number;
    giver_cancellations_after_accept: number;
    contested_rides: number;
    driver_disputes: number;
    overdue_payouts: number;
  };
  flags: NetworkAdminFlag[];
}

/** RPC admin_network_overview() (super admin). */
export interface AdminNetworkOverview {
  enabled: boolean;
  terms: NetworkTermsState;
  /** Demandes (requested_at) et validations perdues (nom / n° modifié) */
  to_review: AdminNetworkOrgRow[];
  organizations: AdminNetworkOrgRow[];
  auto_excluded_drivers: { driver_label: string; organization: { id: Uuid; name: string }; excluded_until: Iso; releases_30d: number }[];
  recent_rides: { execution_id: Uuid; accepted_at: Iso; giver: { id: Uuid; name: string }; executor: { id: Uuid; name: string }; status: RideStatus; price_cents: number; currency: string }[];
  totals: { members: number; sharing: number; receiving: number; to_review: number; suspended: number; rides_30d: number };
}

// =============================================================================
// Temps réel (aucun nouveau topic ; ids seulement)
// =============================================================================

/** « network.updated » : org:{A} → { ride_id } ; org:{B} → { execution_id } seulement (S14). */
export type NetworkUpdatedEvent = { ride_id: Uuid } | { execution_id: Uuid };

/** « offer.updated » sur org:{A} pour une offre réseau : driver_id, distance_m et wave à null. */
export interface NetworkOfferBroadcastFields {
  network?: boolean;
}

/** « ride.updated » sur org:{A} quand le chauffeur est d'une autre organisation : driver_id à null. */
export interface NetworkRideBroadcastFields {
  network?: boolean;
  network_execution_id?: Uuid | null;
}

/** « driver.updated » sur org:{B} pendant une course partenaire : current_ride_id à null, aucune position (Q5). */
export interface NetworkDriverBroadcastFields {
  network?: boolean;
  /** « En course partenaire ({A}) » */
  network_giver?: string | null;
}

// =============================================================================
// Catalogue des RPC réseau : noms, paramètres, réponses, droits
// =============================================================================

type Month = string; // « AAAA-MM »

export interface NetworkRpcs {
  // Plateforme et super admin
  shared_network_enabled: { args: Record<string, never>; returns: boolean };
  svc_set_shared_network_enabled: { args: { p_actor: Uuid; p_enabled: boolean }; returns: SvcSharedNetworkResult };
  svc_network_approve: {
    args: { p_actor: Uuid; p_org: Uuid; p_approved: boolean; p_fee_waiver: boolean; p_reason: string | null };
    returns: SvcNetworkApproveResult;
  };
  svc_network_suspend: { args: { p_actor: Uuid; p_org: Uuid; p_suspended: boolean; p_reason: string | null }; returns: SvcNetworkSuspendResult };
  admin_network_overview: { args: Record<string, never>; returns: AdminNetworkOverview };
  // Organisation (A et B)
  org_network_readiness: { args: { p_org: Uuid }; returns: OrgNetworkReadiness };
  network_driver_readiness: { args: { p_driver?: Uuid | null }; returns: NetworkDriverReadiness };
  /** Paramètres NULL = inchangés ; p_terms_version = acceptation de la convention affichée (pose requested_at) */
  set_network_settings: {
    args: {
      p_org: Uuid;
      p_share_out?: boolean | null;
      p_share_in?: boolean | null;
      p_terms_version?: string | null;
      p_insurance_confirmed?: boolean | null;
      p_executor_credit_limit_cents?: number | null;
    };
    returns: OrgNetworkSettingsResult;
  };
  /** Même réponse dans tous les cas (partenaire jamais rencontré, déjà exclu…) : { ok: true } */
  set_network_exclusion: { args: { p_org: Uuid; p_partner: Uuid; p_excluded: boolean }; returns: { ok: true } };
  network_partner_names: { args: { p_org: Uuid }; returns: NetworkPartnerNames };
  // A : courses confiées
  org_network_summary: { args: { p_org: Uuid }; returns: OrgNetworkSummary };
  org_network_given: {
    args: { p_org: Uuid; p_filter?: NetworkGivenFilter; p_partner?: Uuid | null; p_month?: Month | null; p_limit?: number; p_before?: Iso | null };
    returns: OrgNetworkGiven;
  };
  org_network_ride: { args: { p_ride: Uuid }; returns: OrgNetworkRide | null };
  org_network_payout_info: { args: { p_settlement: Uuid }; returns: OrgNetworkPayoutInfo };
  validate_network_ride: { args: { p_ride: Uuid }; returns: ValidateNetworkRideResult };
  contest_network_ride: { args: { p_ride: Uuid; p_reason: string }; returns: ContestNetworkRideResult };
  close_network_ride: { args: { p_ride: Uuid }; returns: CloseNetworkRideResult };
  remind_network_driver: { args: { p_org: Uuid; p_settlement: Uuid }; returns: RemindNetworkDriverResult };
  exclude_network_driver: { args: { p_execution: Uuid; p_reason: string | null }; returns: ExcludeNetworkDriverResult };
  org_network_driver_exclusions: { args: { p_org: Uuid }; returns: NetworkDriverExclusion[] };
  lift_network_driver_exclusion: { args: { p_org: Uuid; p_id: Uuid }; returns: { ok: true } };
  // B : courses reçues
  org_network_received: {
    args: { p_org: Uuid; p_filter?: NetworkReceivedFilter; p_partner?: Uuid | null; p_month?: Month | null; p_limit?: number; p_before?: Iso | null };
    returns: OrgNetworkReceived;
  };
  org_network_activity: { args: { p_org: Uuid }; returns: OrgNetworkActivity };
  org_network_drivers: { args: { p_org: Uuid }; returns: OrgNetworkDriver[] };
  set_driver_network_allowed: { args: { p_driver: Uuid; p_allowed: boolean }; returns: SetDriverNetworkAllowedResult };
  // Chauffeur
  driver_offers_v2: { args: Record<string, never>; returns: DriverOfferV2[] };
  driver_ride: { args: { p_ride: Uuid }; returns: DriverRide };
  driver_rides_upcoming: { args: Record<string, never>; returns: DriverRide[] };
  driver_network_state: { args: Record<string, never>; returns: DriverNetworkState };
  driver_network_ping: { args: Record<string, never>; returns: { capable_at: Iso } };
  driver_set_network: { args: { p_enabled: boolean; p_version: string | null }; returns: DriverNetworkState };
  driver_payout_info: { args: Record<string, never>; returns: DriverPayoutInfo };
  driver_set_payout_details: { args: { p_payee: string; p_iban: string; p_bic: string | null }; returns: DriverPayoutInfo };
  driver_delete_payout_details: { args: Record<string, never>; returns: DriverPayoutInfo };
  driver_network_settlements: { args: Record<string, never>; returns: DriverNetworkSettlements };
  driver_declare_network_payment: {
    args: { p_org: Uuid; p_ids: Uuid[]; p_method: SettlementMethod; p_note?: string | null };
    returns: DriverDeclareNetworkPaymentResult;
  };
  driver_dispute_network_settlement: { args: { p_id: Uuid; p_reason: string }; returns: { ok: true; item: DriverNetworkSettlementItem } };
}
export type NetworkRpcName = keyof NetworkRpcs;
export type NetworkRpcArgs<K extends NetworkRpcName> = NetworkRpcs[K]["args"];
export type NetworkRpcResult<K extends NetworkRpcName> = NetworkRpcs[K]["returns"];

/**
 * Qui peut appeler (contrôlé DANS la fonction, security definer) : authenticated (lecture de l'interrupteur),
 * service_role (svc_*, p_actor revérifié), super_admin, member (tout rôle, dispatcher compris), owner_admin (+
 * jwt_issued_after ; actions d'argent réseau), owner_admin_or_driver, driver (private.current_driver_id()).
 */
export type NetworkRpcAccess = "authenticated" | "service_role" | "super_admin" | "member" | "owner_admin" | "owner_admin_or_driver" | "driver";

export const NETWORK_RPC_ACCESS: Record<NetworkRpcName, NetworkRpcAccess> = {
  shared_network_enabled: "authenticated",
  svc_set_shared_network_enabled: "service_role",
  svc_network_approve: "service_role",
  svc_network_suspend: "service_role",
  admin_network_overview: "super_admin",
  org_network_readiness: "member",
  network_driver_readiness: "owner_admin_or_driver",
  set_network_settings: "owner_admin",
  set_network_exclusion: "owner_admin",
  network_partner_names: "member",
  org_network_summary: "member",
  org_network_given: "member",
  org_network_ride: "member",
  org_network_payout_info: "owner_admin",
  validate_network_ride: "owner_admin",
  contest_network_ride: "owner_admin",
  close_network_ride: "owner_admin",
  remind_network_driver: "member",
  exclude_network_driver: "owner_admin",
  org_network_driver_exclusions: "owner_admin",
  lift_network_driver_exclusion: "owner_admin",
  org_network_received: "member",
  org_network_activity: "member",
  org_network_drivers: "owner_admin",
  set_driver_network_allowed: "owner_admin",
  driver_offers_v2: "driver",
  driver_ride: "driver",
  driver_rides_upcoming: "driver",
  driver_network_state: "driver",
  driver_network_ping: "driver",
  driver_set_network: "driver",
  driver_payout_info: "driver",
  driver_set_payout_details: "driver",
  driver_delete_payout_details: "driver",
  driver_network_settlements: "driver",
  driver_declare_network_payment: "driver",
  driver_dispute_network_settlement: "driver",
};

export const NETWORK_RPC_NAMES = Object.keys(NETWORK_RPC_ACCESS) as NetworkRpcName[];

// =============================================================================
// Codes d'erreur SQL du réseau (libellés : ERROR_MESSAGES de domain.ts)
// =============================================================================

export const NETWORK_ERROR_CODES = [
  "NETWORK_DISABLED", "NETWORK_SUSPENDED", "NETWORK_TERMS_REQUIRED", "NETWORK_TERMS_OUTDATED",
  "NETWORK_VTC_REGISTRATION_REQUIRED", "NETWORK_PAYMENT_METHODS_REQUIRED", "NETWORK_INSURANCE_REQUIRED",
  "NETWORK_RIDE_LOCKED", "NETWORK_CLOSE_NOT_ALLOWED", "NETWORK_CONTEST_EXPIRED", "NETWORK_SETTLEMENT_ACTION_FORBIDDEN",
  "NETWORK_CONSENT_REQUIRED", "NETWORK_PAYOUT_ON_HOLD", "NETWORK_DISPUTE_NOT_ALLOWED", "OFFER_CHANGED",
  "DRIVER_BUSY_AT_TIME", "DRIVER_HAS_NETWORK_OBLIGATIONS", "PAYOUT_DETAILS_INVALID", "PAYOUT_DETAILS_IN_USE",
] as const;
export type NetworkErrorCode = (typeof NETWORK_ERROR_CODES)[number];

/** Tonalités d'affichage (jetons du design) : « violet » = réseau. */
export const NETWORK_TONE: Tone = "violet";
