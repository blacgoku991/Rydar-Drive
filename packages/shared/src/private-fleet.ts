// Flotte Privée (migrations 20260924007600 et 20260924007700, spécification docs/FLOTTE-PRIVEE.md) : constantes et
// règles partagées par le SQL (private-fleet-sql.test.ts les compare), le web (super admin, espace du client) et
// l'application. Une Flotte Privée est une organisation FLOTTE marquée organizations.private_fleet : le propriétaire
// est aussi l'unique fiche chauffeur, sur le même compte ; chaque réservation de son site lui est proposée « à
// confirmer », en ligne ou non, quelle que soit la distance.
import { z } from "./zod";
import {
  DEFAULT_DISPATCH_RADII_M, DEFAULT_RETRY_RADII_M, UNSTARTED_RIDE_EXPIRY_HOURS, type OfferStatus, type PaymentMethod,
  type RideStatus, type Tone,
} from "./domain";
import type { SetPlatformFeesResult } from "./platform-fees";
import {
  BROWSER_KEY_SCOPES, emailSchema, paymentMethodSchema, phoneSchema, slugSchema, vehicleSchema, type ApiScope,
} from "./schemas";
import type { Uuid } from "./types";

const nbsp = " ";

// -----------------------------------------------------------------------------
// Profils de dispatch (private.dispatch_profile)
// -----------------------------------------------------------------------------
/** Réglages de dispatch posés par les RPC de création et de bascule (organization_settings). */
export interface DispatchProfile {
  auto_dispatch: boolean;
  instant_threshold_minutes: number;
  scheduled_dispatch_lead_minutes: number;
  offer_timeout_seconds: number;
  dispatch_radii_m: readonly number[];
  dispatch_retry_radii_m: readonly number[];
  allow_category_upgrade: boolean;
}

/**
 * Flotte Privée : seule une course « maintenant » est immédiate (seuil 0), confirmation au plus tard 60 min avant la
 * prise en charge, 5 min pour répondre à une immédiate, puis un dernier appel GPS (100 km) sans relance. Le chauffeur
 * règle lui-même le délai de confirmation, le délai de réponse, ses rappels et le paiement par défaut
 * (privateBookingSettingsSchema).
 */
export const PRIVATE_FLEET_DISPATCH_PROFILE: Readonly<DispatchProfile> = {
  auto_dispatch: true,
  instant_threshold_minutes: 0,
  scheduled_dispatch_lead_minutes: 60,
  offer_timeout_seconds: 300,
  dispatch_radii_m: [100_000],
  dispatch_retry_radii_m: [],
  allow_category_upgrade: true,
};

/** Flotte standard (posé à la sortie de la Flotte Privée) : réglages par défaut d'une flotte (4 → 16 km, relance 4 → 8 km). */
export const STANDARD_DISPATCH_PROFILE: Readonly<DispatchProfile> = {
  auto_dispatch: true,
  instant_threshold_minutes: 45,
  scheduled_dispatch_lead_minutes: 60,
  offer_timeout_seconds: 30,
  dispatch_radii_m: [...DEFAULT_DISPATCH_RADII_M],
  dispatch_retry_radii_m: [...DEFAULT_RETRY_RADII_M],
  allow_category_upgrade: true,
};

/** Limites imposées par private.org_limits APRÈS l'offre et la surcharge du super admin. */
export const PRIVATE_FLEET_LIMITS = { max_drivers: 1, max_admins: 1 } as const;

// -----------------------------------------------------------------------------
// Délais et notifications
// -----------------------------------------------------------------------------
/** Réponse attendue dans 15 min au plus : la réservation sonne (ride_offer, plein écran possible dans l'app). */
export const PRIVATE_FLEET_RING_WINDOW_S = 900;

/**
 * Rappels « à confirmer » (private.ride_offers_private_fleet_reminders) : heures candidates = prise en charge − chaque
 * délai des rappels de course de l'organisation, plus l'échéance − 30 min (dernier rappel) ; gardées de maintenant +
 * 20 min à l'échéance − 5 min ; une heure à moins de 15 min de la précédente retenue est écartée ; 4 au plus.
 */
export const PRIVATE_FLEET_REMINDER_RULES = {
  minAheadMinutes: 20,
  lastCallMinutes: 30,
  endMarginMinutes: 5,
  minGapMinutes: 15,
  max: 4,
} as const;

/** « La prendre » reste possible jusqu'à 6 h après l'heure prévue (RIDE_TOO_LATE au-delà), comme la clôture « Non effectuée ». */
export const PRIVATE_FLEET_TAKE_MAX_AGE_HOURS = UNSTARTED_RIDE_EXPIRY_HOURS;

/** Période maximale d'un appel à driver_agenda (AGENDA_RANGE_INVALID au-delà). */
export const PRIVATE_FLEET_AGENDA_MAX_DAYS = 62;

/** Titres des notifications de la Flotte Privée (écrits en SQL). */
export const PRIVATE_FLEET_TITLES = {
  /** Réservation proposée (ride_offer si la réponse est attendue dans 15 min au plus, sinon ride_offer_scheduled) */
  newBooking: "NOUVELLE RÉSERVATION",
  /** Rappels (ride_offer_scheduled, kind private_reminder) */
  reminder: "RÉSERVATION À CONFIRMER",
  /** Sans réponse à l'échéance (ride_unconfirmed, reason not_confirmed) */
  unconfirmed: "RÉSERVATION NON CONFIRMÉE",
  /** Véhicule incompatible : aucune offre (ride_unconfirmed, reason to_check) */
  toCheck: "RÉSERVATION À VÉRIFIER",
} as const;

/** data.kind des notifications d'offre de la Flotte Privée (mêmes chemins que les offres dans l'app). */
export const PRIVATE_FLEET_NOTIFICATION_KINDS = ["private_new", "private_reminder"] as const;
export type PrivateFleetNotificationKind = (typeof PRIVATE_FLEET_NOTIFICATION_KINDS)[number];

/** data.reason d'une notification « ride_unconfirmed ». */
export const PRIVATE_FLEET_UNCONFIRMED_REASONS = ["not_confirmed", "to_check"] as const;
export type PrivateFleetUnconfirmedReason = (typeof PRIVATE_FLEET_UNCONFIRMED_REASONS)[number];

/**
 * Données d'une notification « ride_unconfirmed » (canal ride-updates). Jamais de ride_id : l'app 1.1.0 ouvrirait
 * /ride/[id], qui répond RIDE_NOT_FOUND pour une réservation non attribuée ; la nouvelle app ouvre l'agenda.
 */
export interface RideUnconfirmedData {
  type: "ride_unconfirmed";
  reason: PrivateFleetUnconfirmedReason;
  /** Identifiant de la réservation (course sans chauffeur) */
  booking_id: Uuid;
  number: number;
  /** Ajouté par le worker */
  notification_id?: Uuid;
}

// -----------------------------------------------------------------------------
// Réservations à traiter (private.private_fleet_unassigned)
// -----------------------------------------------------------------------------
/** États d'une réservation sans chauffeur, dans l'ordre de traitement. */
export const PRIVATE_FLEET_BOOKING_STATES = ["to_confirm", "to_check", "declined", "not_confirmed"] as const;
export type PrivateFleetBookingState = (typeof PRIVATE_FLEET_BOOKING_STATES)[number];

export const PRIVATE_FLEET_BOOKING_STATE_META: Record<PrivateFleetBookingState, { label: string; tone: Tone }> = {
  to_confirm: { label: "À confirmer", tone: "amber" },
  to_check: { label: "À vérifier", tone: "amber" },
  declined: { label: "Refusée", tone: "neutral" },
  not_confirmed: { label: "Non confirmée", tone: "red" },
};

/** Statuts d'une réservation encore sans chauffeur (« La prendre » possible). */
export const PRIVATE_FLEET_OPEN_STATUSES = ["CREATED", "SEARCHING_DRIVER", "OFFERED", "NO_DRIVER_FOUND"] as const satisfies readonly RideStatus[];

const isOpen = (status: RideStatus) => (PRIVATE_FLEET_OPEN_STATUSES as readonly RideStatus[]).includes(status);

/**
 * État d'une réservation sans chauffeur (même règle que private.private_fleet_unassigned) : offre en attente →
 * à confirmer ; dernière offre refusée → refusée ; aucun chauffeur, ou fenêtre de réponse passée → non confirmée ; en
 * recherche sans aucune offre (véhicule incompatible) → à vérifier. Course attribuée ou close : null.
 */
export function privateFleetBookingState(b: {
  status: RideStatus;
  driver_id?: string | null;
  /** Offre en attente pour le chauffeur */
  pending_offer?: boolean;
  /** Statut de sa dernière offre pour cette course (null : jamais proposée) */
  last_offer_status?: OfferStatus | null;
}): PrivateFleetBookingState | null {
  if (b.driver_id || !isOpen(b.status)) return null;
  if (b.pending_offer) return "to_confirm";
  if (b.last_offer_status === "declined") return "declined";
  if (b.status === "NO_DRIVER_FOUND" || b.last_offer_status) return "not_confirmed";
  return "to_check";
}

/** « La prendre » possible : réservation sans chauffeur, prise en charge il y a moins de 6 h (mêmes contrôles que driver_take_ride). */
export function privateFleetTakeable(b: { status: RideStatus; driver_id?: string | null; pickup_at: string }, now = Date.now()): boolean {
  return !b.driver_id && isOpen(b.status) && Date.parse(b.pickup_at) >= now - PRIVATE_FLEET_TAKE_MAX_AGE_HOURS * 3_600_000;
}

// -----------------------------------------------------------------------------
// Passage en Flotte Privée (private.private_fleet_blockers)
// -----------------------------------------------------------------------------
export const PRIVATE_FLEET_BLOCKERS = ["model", "members", "drivers", "owner_driver", "applications", "network"] as const;
export type PrivateFleetBlocker = (typeof PRIVATE_FLEET_BLOCKERS)[number];

export const PRIVATE_FLEET_BLOCKER_LABELS: Record<PrivateFleetBlocker, string> = {
  model: `Modèle centrale${nbsp}: repassez d'abord l'organisation en flotte.`,
  members: `Plusieurs accès au tableau de bord${nbsp}: seul le propriétaire doit rester (adhésion active).`,
  drivers: `Plusieurs fiches chauffeur (candidatures comprises)${nbsp}: seule celle du propriétaire doit rester.`,
  owner_driver: "Aucune fiche chauffeur active sur le compte du propriétaire.",
  applications: `Candidature en attente${nbsp}: validez-la ou refusez-la.`,
  network: "Réseau partagé actif, demande d'adhésion en attente ou course partagée en cours.",
};

// -----------------------------------------------------------------------------
// Création (svc_platform_create_private_fleet) et fiche du gérant (svc_platform_attach_private_fleet_driver)
// -----------------------------------------------------------------------------
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : undefined));

const feeHundredths = (percent: number) => Math.round(Number((percent * 100).toFixed(6)));

/** Fiche du gérant et son véhicule (recréation : svc_platform_attach_private_fleet_driver). */
export const privateFleetDriverSchema = z.object({
  ownerFirstName: z.string().trim().min(1, "Prénom requis").max(80),
  ownerLastName: z.string().trim().min(1, "Nom requis").max(80),
  ownerPhone: phoneSchema,
  vtcCardNumber: optionalText(40),
  vehicle: vehicleSchema,
});
export type PrivateFleetDriverInput = z.output<typeof privateFleetDriverSchema>;

/**
 * Nouveau client Flotte Privée (super admin) : client (nom commercial, identifiant, e-mail, téléphone et ville
 * obligatoires ; raison sociale, SIRET et n° d'inscription au registre VTC facultatifs — docs/FLOTTE-PRIVEE.md § 8.1),
 * chauffeur-propriétaire (compte NEUF : une adresse qui a déjà un compte Rydar est refusée en phase 1), véhicule, frais
 * Rydar par course du modèle flotte (0 par défaut : aucun montant proposé), offre facultative (avec l'accès à l'API),
 * référence du contrat signé (obligatoire). Invitation par e-mail par défaut ; mot de passe provisoire seulement sur
 * case cochée (accès connu de l'équipe, à changer par « Mot de passe oublié »).
 */
export const privateFleetCreateSchema = privateFleetDriverSchema
  .extend({
    name: z.string().trim().min(2).max(120),
    slug: slugSchema,
    email: emailSchema,
    phone: phoneSchema,
    city: z.string().trim().min(1, "Ville requise").max(80),
    legalName: optionalText(160),
    siret: z
      .string()
      .optional()
      .transform((v) => (v ?? "").replace(/\s+/g, "") || undefined)
      .refine((v) => v === undefined || /^\d{14}$/.test(v), "SIRET : 14 chiffres"),
    vtcRegistration: optionalText(120),
    ownerEmail: emailSchema,
    platformFeePercent: z.coerce
      .number()
      .min(0, "Entre 0 et 50 %")
      .max(50, "Entre 0 et 50 %")
      .default(0)
      .transform((v) => feeHundredths(v) / 100),
    platformFeeFixedCents: z.coerce.number().int("Montant invalide").min(0, "Entre 0 et 1 000 €").max(100_000, "Entre 0 et 1 000 €").default(0),
    planId: z.union([z.literal(""), z.null(), z.uuid("Offre invalide")]).optional().transform((v) => v || null),
    contractRef: z.string().trim().min(3, "Indiquez la référence des conditions particulières et du contrat de prestations signés").max(200),
    temporaryPassword: z.boolean().default(false),
    password: z.union([z.literal(""), z.string().min(10, "10 caractères minimum").max(72)]).optional().transform((v) => v || undefined),
  })
  .superRefine((v, ctx) => {
    if (v.temporaryPassword && !v.password) {
      ctx.addIssue({ code: "custom", path: ["password"], message: "Requis (ou décochez la case)" });
    }
  });
export type PrivateFleetCreateInput = z.output<typeof privateFleetCreateSchema>;

export const PRIVATE_FLEET_CREATE_LABELS: Record<string, string> = {
  name: "Nom commercial",
  slug: "Identifiant",
  email: "E-mail du client",
  phone: "Téléphone du client",
  city: "Ville",
  legalName: "Raison sociale",
  siret: "SIRET",
  vtcRegistration: "N° d'inscription au registre VTC",
  ownerFirstName: "Prénom du chauffeur",
  ownerLastName: "Nom du chauffeur",
  ownerEmail: "E-mail de connexion",
  ownerPhone: "Téléphone du chauffeur",
  vtcCardNumber: "N° de carte VTC",
  "vehicle.brand": "Marque",
  "vehicle.model": "Modèle",
  "vehicle.color": "Couleur",
  "vehicle.plate": "Plaque",
  "vehicle.category": "Catégorie",
  "vehicle.seats": "Places",
  "vehicle.luggageCapacity": "Bagages",
  platformFeePercent: "Frais Rydar (%)",
  platformFeeFixedCents: "Frais Rydar fixes par course",
  planId: "Offre",
  contractRef: "Référence du contrat signé",
  temporaryPassword: "Mot de passe provisoire",
  password: "Mot de passe provisoire",
};

/** p_driver et p_vehicle des RPC (fiche du gérant ; e-mail de la fiche : celui du compte si absent). */
export function privateFleetDriverPayload(v: PrivateFleetDriverInput, email?: string) {
  return {
    p_driver: {
      first_name: v.ownerFirstName,
      last_name: v.ownerLastName,
      phone: v.ownerPhone,
      email: email ?? null,
      vtc_card_number: v.vtcCardNumber ?? null,
    },
    p_vehicle: {
      brand: v.vehicle.brand ?? null,
      model: v.vehicle.model,
      color: v.vehicle.color ?? null,
      plate: v.vehicle.plate,
      category: v.vehicle.category,
      seats: v.vehicle.seats,
      luggage_capacity: v.vehicle.luggageCapacity,
    },
  };
}

/** Paramètres de svc_platform_create_private_fleet tirés du formulaire (p_actor, p_owner et termes des CGV en plus). */
export function privateFleetCreatePayload(v: PrivateFleetCreateInput) {
  return {
    p_org: {
      name: v.name,
      slug: v.slug,
      email: v.email,
      phone: v.phone,
      city: v.city,
      legal_name: v.legalName ?? null,
      siret: v.siret ?? null,
      vtc_registration: v.vtcRegistration ?? null,
    },
    ...privateFleetDriverPayload(v, v.ownerEmail),
    p_plan_id: v.planId,
    p_percent: v.platformFeePercent,
    p_fixed_cents: v.platformFeeFixedCents,
    p_contract_ref: v.contractRef,
  };
}

/** RPC svc_platform_create_private_fleet (service role). Refus des frais initiaux : réponse de svc_platform_set_fees. */
export type PrivateFleetCreateResult =
  | { ok: true; code: "CREATED"; organization_id: Uuid; driver_id: Uuid; fees: Extract<SetPlatformFeesResult, { ok: true }> }
  | {
      ok: false;
      code:
        | "CONSENT_REQUIRED" | "NOT_FOUND" | "SELF_NOT_ALLOWED" | "ALREADY_REGISTERED" | "OWNER_NOT_NEW"
        | "PRIVATE_FLEET_PLAN_INVALID" | "INVALID" | "SUBDOMAIN_RESERVED" | "SLUG_TAKEN";
      field?: string;
      message: string;
    }
  | Extract<SetPlatformFeesResult, { ok: false }>;

/** RPC svc_platform_attach_private_fleet_driver (service role). */
export type PrivateFleetAttachResult =
  | { ok: true; code: "CREATED"; driver_id: Uuid }
  | {
      ok: false;
      code: "NOT_FOUND" | "PRIVATE_FLEET_ONLY" | "INVITATION_PENDING" | "PRIVATE_FLEET_HAS_DRIVER" | "ALREADY_REGISTERED" | "INVALID";
      field?: string;
      message: string;
    };

// -----------------------------------------------------------------------------
// Bascule (svc_platform_set_private_fleet)
// -----------------------------------------------------------------------------
export const PRIVATE_FLEET_SWITCH_TARGETS = ["private_fleet", "fleet", "centrale"] as const;
export type PrivateFleetSwitchTarget = (typeof PRIVATE_FLEET_SWITCH_TARGETS)[number];

const optionalFeePercent = z
  .union([z.literal(""), z.null(), z.coerce.number().min(0, "Entre 0 et 50 %").max(50, "Entre 0 et 50 %")])
  .optional()
  .transform((v) => (v === "" || v == null ? null : feeHundredths(v) / 100));
const optionalFeeFixed = z
  .union([z.literal(""), z.null(), z.coerce.number().int("Montant invalide").min(0, "Entre 0 et 1 000 €").max(100_000, "Entre 0 et 1 000 €")])
  .optional()
  .transform((v) => (v === "" || v == null ? null : v));
const isoDay = z
  .union([z.literal(""), z.null(), z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date invalide")])
  .optional()
  .transform((v) => v || null);

/**
 * « Changer d'offre de service » (super admin) : vers la Flotte Privée, ou vers une flotte standard ou une centrale.
 * Note d'accord obligatoire (demande ou accord écrit du client, date et forme : CGV art. 3). Sortie : offre à
 * appliquer (planId) ou absence d'offre assumée (acceptNoPlan : sans offre, aucune limite) ; taux facultatifs (les
 * deux ou aucun), hausse annoncée (notice, date d'effet facultative) ou sur accord écrit (consent). Entrée : ni taux ni
 * offre (réglés ensuite depuis la fiche).
 */
export const privateFleetSwitchSchema = z
  .object({
    target: z.enum(PRIVATE_FLEET_SWITCH_TARGETS, { message: "Offre de service inconnue" }),
    planId: z.union([z.literal(""), z.null(), z.uuid("Offre invalide")]).optional().transform((v) => v || null),
    acceptNoPlan: z.boolean().default(false),
    platformFeePercent: optionalFeePercent,
    platformFeeFixedCents: optionalFeeFixed,
    mode: z.enum(["notice", "consent"]).default("notice"),
    effectiveOn: isoDay,
    consentNote: z.string().trim().min(3, "Précisez la demande ou l'accord écrit du client (date et forme)").max(500, "500 caractères au plus"),
  })
  .superRefine((v, ctx) => {
    const rates = v.platformFeePercent != null || v.platformFeeFixedCents != null;
    if (v.target === "private_fleet") {
      if (rates) {
        ctx.addIssue({ code: "custom", path: ["platformFeePercent"], message: "Frais inchangés à l'entrée en Flotte Privée : réglez-les ensuite" });
      }
      return;
    }
    if (rates && (v.platformFeePercent == null) !== (v.platformFeeFixedCents == null)) {
      ctx.addIssue({ code: "custom", path: [v.platformFeePercent == null ? "platformFeePercent" : "platformFeeFixedCents"], message: "Indiquez les deux taux (0 si aucun)" });
    }
    if (!v.planId && !v.acceptNoPlan) {
      ctx.addIssue({ code: "custom", path: ["planId"], message: "Choisissez une offre, ou confirmez qu'aucune limite ne s'appliquera" });
    }
  });
export type PrivateFleetSwitchInput = z.output<typeof privateFleetSwitchSchema>;

export const PRIVATE_FLEET_SWITCH_LABELS: Record<string, string> = {
  target: "Offre de service",
  planId: "Offre",
  acceptNoPlan: "Sans offre",
  platformFeePercent: "Frais Rydar (%)",
  platformFeeFixedCents: "Frais Rydar fixes par course",
  mode: "Application des frais",
  effectiveOn: "Date d'effet",
  consentNote: "Note d'accord",
};

/** Paramètres de svc_platform_set_private_fleet (p_org, p_actor et termes des CGV en plus). */
export function privateFleetSwitchArgs(v: PrivateFleetSwitchInput) {
  const exit = v.target !== "private_fleet";
  return {
    p_enabled: !exit,
    p_consent_note: v.consentNote,
    p_dispatch_model: v.target === "centrale" ? "centrale" : null,
    p_percent: exit ? v.platformFeePercent : null,
    p_fixed_cents: exit ? v.platformFeeFixedCents : null,
    p_fee_mode: v.mode,
    p_effective_on: exit ? v.effectiveOn : null,
  };
}

/** RPC svc_platform_set_private_fleet (service role). Refus des frais (sortie) : réponse de svc_platform_set_fees. */
export type PrivateFleetSwitchResult =
  | { ok: true; code: "PRIVATE_FLEET_ENABLED" | "PRIVATE_FLEET_DISABLED"; fees: SetPlatformFeesResult | null; open_rides: number }
  | { ok: true; code: "UNCHANGED" }
  | { ok: false; code: "PRIVATE_FLEET_NOT_ELIGIBLE"; blockers: PrivateFleetBlocker[]; message: string }
  | { ok: false; code: "CONSENT_REQUIRED" | "NOT_FOUND" | "ORGANIZATION_INACTIVE" | "INVALID"; field?: string; message: string }
  | Extract<SetPlatformFeesResult, { ok: false }>;

// -----------------------------------------------------------------------------
// Clé du site du client (super admin)
// -----------------------------------------------------------------------------
export const PRIVATE_FLEET_SITE_KEY_KINDS = ["server", "browser"] as const;
export type PrivateFleetSiteKeyKind = (typeof PRIVATE_FLEET_SITE_KEY_KINDS)[number];

/**
 * Portées : clé serveur (recommandée : backend du site, qui enregistre lui-même ses webhooks) ; clé navigateur
 * (lisible par tout visiteur du site : création de courses et devis seulement, depuis les origines listées).
 */
export const PRIVATE_FLEET_SITE_KEY_SCOPES: Record<PrivateFleetSiteKeyKind, readonly ApiScope[]> = {
  server: ["rides:create", "rides:read", "rides:cancel", "rides:quote", "webhooks:manage"],
  browser: BROWSER_KEY_SCOPES,
};

/** Origines saisies au plus pour une clé navigateur (chacune avec sa variante www). */
export const PRIVATE_FLEET_SITE_KEY_MAX_ORIGINS = 5;

const ORIGIN_RE = /^https:\/\/((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63})(?::(\d{1,5}))?\/?$/;

/** « https://MonSite.fr/ » → « https://monsite.fr » (en-tête Origin du navigateur) ; null si ce n'est pas une origine https sans chemin. */
export function siteOrigin(input: string): string | null {
  const m = ORIGIN_RE.exec(input.trim().toLowerCase());
  if (!m) return null;
  const port = m[2] && m[2] !== "443" ? Number(m[2]) : null;
  if (port !== null && (port < 1 || port > 65_535)) return null;
  return `https://${m[1]}${port !== null ? `:${port}` : ""}`;
}

/** Origine et sa variante www (« https://monsite.fr » ↔ « https://www.monsite.fr »). */
export function withWwwVariant(origin: string): string[] {
  const host = origin.replace(/^https:\/\//, "");
  return [origin, host.startsWith("www.") ? `https://${host.slice(4)}` : `https://www.${host}`];
}

/** Création de la clé du site : nom, type ; clé navigateur : 1 à 5 origines https (variantes www ajoutées). */
export const privateFleetSiteKeySchema = z
  .object({
    kind: z.enum(PRIVATE_FLEET_SITE_KEY_KINDS, { message: "Type de clé inconnu" }),
    name: z.string().trim().min(2).max(80),
    origins: z.array(z.string().max(200)).max(PRIVATE_FLEET_SITE_KEY_MAX_ORIGINS, `${PRIVATE_FLEET_SITE_KEY_MAX_ORIGINS} sites au plus`).default([]),
  })
  .superRefine((v, ctx) => {
    if (v.kind !== "browser") return;
    if (!v.origins.some((o) => o.trim())) {
      ctx.addIssue({ code: "custom", path: ["origins"], message: "Obligatoire pour une clé navigateur (https://…)" });
    }
    v.origins.forEach((o, i) => {
      if (o.trim() && !siteOrigin(o)) {
        ctx.addIssue({ code: "custom", path: ["origins", i], message: "https:// et nom de domaine seulement, sans chemin (ex. https://monsite.fr)" });
      }
    });
  })
  .transform((v) => ({
    kind: v.kind,
    name: v.name,
    scopes: [...PRIVATE_FLEET_SITE_KEY_SCOPES[v.kind]],
    origins:
      v.kind === "browser"
        ? [...new Set(v.origins.map(siteOrigin).filter((o): o is string => !!o).flatMap(withWwwVariant))]
        : [],
  }));
export type PrivateFleetSiteKeyInput = z.output<typeof privateFleetSiteKeySchema>;

export const PRIVATE_FLEET_SITE_KEY_LABELS: Record<string, string> = {
  kind: "Type de clé",
  name: "Nom de la clé",
  origins: "Adresse du site",
};

// -----------------------------------------------------------------------------
// Réglages « Réservations » du chauffeur (colonnes déjà ouvertes en écriture : organization_settings)
// -----------------------------------------------------------------------------
/** « Confirmer au plus tard … avant la prise en charge » (minutes). */
export const PRIVATE_BOOKING_LEAD_CHOICES = [30, 60, 120, 180, 360, 720, 1440] as const;
/** « Délai de réponse à une réservation immédiate » (secondes). */
export const PRIVATE_BOOKING_TIMEOUT_CHOICES = [60, 120, 180, 300, 600] as const;
/** Rappels avant la prise en charge (minutes), aussi les rappels « à confirmer ». */
export const PRIVATE_BOOKING_REMINDER_CHOICES = [1440, 720, 180, 120, 60, 30] as const;

const oneOf = (choices: readonly number[], message: string) =>
  z.coerce.number().int(message).refine((v) => choices.includes(v), message);

export const privateBookingSettingsSchema = z.object({
  scheduledDispatchLeadMinutes: oneOf(PRIVATE_BOOKING_LEAD_CHOICES, "Choisissez un délai proposé"),
  offerTimeoutSeconds: oneOf(PRIVATE_BOOKING_TIMEOUT_CHOICES, "Choisissez un délai proposé"),
  reminderOffsetsMinutes: z
    .array(oneOf(PRIVATE_BOOKING_REMINDER_CHOICES, "Rappel non proposé"))
    .transform((v) => [...new Set(v)].sort((a, b) => b - a)),
  defaultPaymentMethod: paymentMethodSchema,
});
export type PrivateBookingSettingsInput = z.output<typeof privateBookingSettingsSchema>;

export const PRIVATE_BOOKING_SETTINGS_LABELS: Record<string, string> = {
  scheduledDispatchLeadMinutes: "Confirmer au plus tard",
  offerTimeoutSeconds: "Délai de réponse à une réservation immédiate",
  reminderOffsetsMinutes: "Rappels",
  defaultPaymentMethod: "Paiement par défaut",
};

/** Colonnes de organization_settings écrites par l'onglet « Réservations ». */
export function privateBookingSettingsColumns(v: PrivateBookingSettingsInput): {
  scheduled_dispatch_lead_minutes: number;
  offer_timeout_seconds: number;
  reminder_offsets_minutes: number[];
  default_payment_method: PaymentMethod;
} {
  return {
    scheduled_dispatch_lead_minutes: v.scheduledDispatchLeadMinutes,
    offer_timeout_seconds: v.offerTimeoutSeconds,
    reminder_offsets_minutes: v.reminderOffsetsMinutes,
    default_payment_method: v.defaultPaymentMethod,
  };
}

// -----------------------------------------------------------------------------
// RPC du chauffeur
// -----------------------------------------------------------------------------
/**
 * RPC driver_take_ride(p_ride_id) : « La prendre » / « Confirmer quand même ». ACCEPTED (chained : immédiate enchaînée
 * à la fin de la course en cours), UNCHANGED (déjà la sienne) ; refus : PRIVATE_FLEET_ONLY, RIDE_NOT_FOUND,
 * RIDE_NOT_ASSIGNABLE, RIDE_TOO_LATE, ou ceux de accept_ride_offer / assign_ride (PLATFORM_FEES_OVERDUE,
 * PLAN_LIMIT_RIDES…).
 */
export type DriverTakeRideResult =
  | { ok: true; code: "ACCEPTED"; ride_id: Uuid; chained?: boolean; message?: string }
  | { ok: true; code: "UNCHANGED"; ride_id: Uuid }
  | { ok: false; code: string; message: string };
