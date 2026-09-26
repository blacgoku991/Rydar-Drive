// Frais plateforme : reversement des centrales à Rydar (super admin).
// Les règles d'argent sont appliquées en base (migration 20260924003000_platform_fees) :
// frais dus dès la fin de la course, registre immuable, baisses validées par le super admin,
// solde = frais comptabilisés − paiements CONFIRMÉS par le super admin. Ce module les présente.
import { z } from "zod";
import type { Iso, Uuid } from "./types";
import type { OrgStatus, PaymentMethod } from "./domain";

type Tone = "green" | "amber" | "red" | "blue" | "violet" | "neutral";

export type PlatformPaymentStatus = "declared" | "confirmed" | "rejected" | "cancelled";
export type PlatformPaymentMethod = "transfer" | "link" | "cash" | "card" | "other";
export type PlatformEntryKind = "ride" | "correction" | "adjustment";
export type PlatformEntryStatus = "posted" | "pending" | "rejected";
export type PlatformBillingCycle = "weekly" | "monthly";

/** private.platform_account : compte d'une centrale envers Rydar (montants en centimes). */
export interface PlatformAccount {
  organization_id: Uuid;
  currency: string;
  /** Référence à indiquer sur le virement (RYD-…) */
  reference: string;
  cycle: PlatformBillingCycle;
  payment_days: number;
  block_after_days: number | null;
  fee_percent: number;
  fee_fixed_cents: number;
  /** Frais comptabilisés − paiements reçus (négatif : avance / avoir en faveur de la centrale) */
  balance_cents: number;
  /** Part du solde dont l'échéance est passée */
  due_cents: number;
  /** Échéance la plus ancienne non réglée, si elle est passée */
  overdue_since: Iso | null;
  days_overdue: number;
  /** Prochaine échéance à venir et montant à régler d'ici là */
  next_due_at: Iso | null;
  next_due_cents: number;
  /** Paiements « J'ai payé » en attente de confirmation par Rydar */
  declared_cents: number;
  declared_count: number;
  /** Baisses de frais (prix corrigé après la course) en attente de l'accord du super admin (montant négatif) */
  pending_reductions_cents: number;
  pending_reductions_count: number;
  posted_cents: number;
  received_cents: number;
  last_payment_at: Iso | null;
  /** Frais déjà encaissés par la centrale (course payée à la centrale ou règlement chauffeur confirmé) */
  collected_by_centrale_cents: number;
  /** Frais encore chez les chauffeurs (règlement à régler, déclaré ou contesté) */
  with_drivers_cents: number;
  /** Frais de courses dont la centrale a annulé la dette du chauffeur (toujours dus à Rydar) */
  waived_by_centrale_cents: number;
  /** Encaissé par la centrale et pas encore reversé */
  held_by_centrale_cents: number;
  /** Création de courses refusée (retard au-delà du seuil choisi par le super admin) */
  blocked: boolean;
  /** Retard au-delà du seuil, mais blocage suspendu par un paiement « J'ai payé » récent (7 jours au plus,
   *  jamais dans les 7 jours qui suivent un « Pas reçu ») */
  block_suspended?: boolean;
  reminded_at: Iso | null;
  reminder_note: string | null;
  month: {
    start: Iso;
    fees_cents: number;
    rides: number;
    received_cents: number;
    /** Signaux : courses terminées à 0 € / sans prix, courses annulées après attribution */
    zero_price_rides: number;
    cancelled_assigned_rides: number;
  };
}

export interface PlatformPayment {
  id: Uuid;
  organization_id: Uuid;
  amount_cents: number;
  received_cents: number | null;
  method: PlatformPaymentMethod;
  reference: string | null;
  note: string | null;
  paid_on: string | null;
  status: PlatformPaymentStatus;
  source: "centrale" | "admin";
  declared_at: Iso;
  declared_by: Uuid | null;
  declared_by_name: string | null;
  reviewed_at: Iso | null;
  reviewed_by_name: string | null;
  review_note: string | null;
  /** Vue super admin uniquement */
  organization_name?: string;
}

export interface PlatformEntry {
  id: Uuid;
  organization_id: Uuid;
  kind: PlatformEntryKind;
  amount_cents: number;
  status: PlatformEntryStatus;
  label: string;
  reason: string | null;
  occurred_at: Iso;
  due_at: Iso;
  created_at: Iso;
  created_by_name: string | null;
  reviewed_at: Iso | null;
  review_note: string | null;
  /** Statut « rejected » sans décision de Rydar : baisse remplacée par une correction plus récente du prix */
  superseded?: boolean;
  ride: {
    id: Uuid;
    number: number;
    price_cents: number | null;
    payment_method: PaymentMethod;
    completed_at: Iso | null;
    pickup: string | null;
    dropoff: string | null;
    settlement_status: string | null;
  } | null;
  /** Vue super admin uniquement */
  organization_name?: string;
}

/** Coordonnées de paiement de Rydar + montant suggéré (échu, sinon solde) et lien prérempli. */
export interface PlatformPayInfo {
  amount_cents: number;
  reference: string;
  payee_name: string | null;
  iban: string | null;
  bic: string | null;
  instructions: string | null;
  link: string | null;
  configured: boolean;
}

/** RPC org_platform_status(p_org) : bandeau du tableau de bord (owner / admin). */
export type OrgPlatformStatus = { enabled: false } | { enabled: true; account: PlatformAccount };

/** RPC org_platform_account(p_org) : carte « Frais plateforme » de la page Encaissements. */
export type OrgPlatformAccount =
  | { enabled: false }
  | {
      enabled: true;
      organization: { id: Uuid; name: string; status: OrgStatus; timezone: string };
      account: PlatformAccount;
      pay: PlatformPayInfo;
      payments: PlatformPayment[];
      entries: PlatformEntry[];
      /** 6 derniers mois, le plus récent d'abord (« YYYY-MM ») */
      months: { month: string; fees_cents: number; rides: number; received_cents: number }[];
    };

/** RPC org_platform_statement(p_org, p_month) / admin_platform_account(…).statement : relevé mensuel. */
export interface PlatformStatement {
  organization: { id: Uuid; name: string; currency: string; timezone: string; reference: string };
  month: string;
  from: Iso;
  to: Iso;
  opening_cents: number;
  fees_cents: number;
  received_cents: number;
  closing_cents: number;
  entries: PlatformEntry[];
  payments: PlatformPayment[];
}

export type AdminPlatformRow = PlatformAccount & {
  id: Uuid;
  name: string;
  slug: string;
  status: OrgStatus;
  dispatch_model: "fleet" | "centrale";
};

/** RPC admin_platform_overview() (super admin). */
export interface AdminPlatformOverview {
  organizations: AdminPlatformRow[];
  payments_to_confirm: PlatformPayment[];
  pending_reductions: PlatformEntry[];
  billing: {
    payee_name: string | null;
    iban: string | null;
    bic: string | null;
    payment_link: string | null;
    instructions: string | null;
    updated_at: Iso;
  };
  totals: {
    balance_cents: number;
    due_cents: number;
    overdue_count: number;
    held_by_centrales_cents: number;
    with_drivers_cents: number;
    declared_cents: number;
    declared_count: number;
    pending_reductions_count: number;
    fees_month_cents: number;
    received_month_cents: number;
    blocked_count: number;
  };
}

/** RPC admin_platform_account(p_org, p_month) (super admin). */
export interface AdminPlatformAccount {
  organization: { id: Uuid; name: string; slug: string; status: OrgStatus; dispatch_model: "fleet" | "centrale"; timezone: string; currency: string };
  account: PlatformAccount;
  payments: PlatformPayment[];
  statement: PlatformStatement;
}

/** Diffusion temps réel « platform.updated » (topic org:{id}). */
export interface PlatformEvent {
  action:
    | "fee" | "reduction_pending" | "reduction_approved" | "reduction_rejected" | "adjusted"
    | "declared" | "cancelled" | "confirmed" | "rejected" | "reopened" | "reminded" | "terms";
  organization_id: Uuid;
  /** Identifiants seulement : le canal org:{id} est lisible par tous les membres (dispatchers compris) */
  payment_id?: Uuid;
  entry_id?: Uuid;
  /** Détails complétés côté écran par une lecture qui contrôle le rôle (jamais transmis par le temps réel) */
  payment?: PlatformPayment;
  entry?: PlatformEntry;
  note?: string | null;
}

// -----------------------------------------------------------------------------
// Libellés
// -----------------------------------------------------------------------------
export const PLATFORM_PAYMENT_STATUS_META: Record<PlatformPaymentStatus, { label: string; adminLabel: string; tone: Tone }> = {
  declared: { label: "En attente de confirmation", adminLabel: "À confirmer", tone: "blue" },
  confirmed: { label: "Reçu par Rydar", adminLabel: "Reçu", tone: "green" },
  rejected: { label: "Non reçu par Rydar", adminLabel: "Pas reçu", tone: "red" },
  cancelled: { label: "Déclaration retirée", adminLabel: "Retiré", tone: "neutral" },
};

export const PLATFORM_PAYMENT_METHOD_META: Record<PlatformPaymentMethod, { label: string; lucide: string }> = {
  transfer: { label: "Virement", lucide: "ArrowLeftRight" },
  link: { label: "Lien de paiement", lucide: "Link" },
  cash: { label: "Espèces", lucide: "Banknote" },
  card: { label: "Carte", lucide: "CreditCard" },
  other: { label: "Autre", lucide: "Ellipsis" },
};

export const PLATFORM_ENTRY_KIND_META: Record<PlatformEntryKind, { label: string }> = {
  ride: { label: "Course" },
  correction: { label: "Correction" },
  adjustment: { label: "Ajustement" },
};

export const PLATFORM_ENTRY_STATUS_META: Record<PlatformEntryStatus, { label: string; tone: Tone }> = {
  posted: { label: "Comptabilisé", tone: "neutral" },
  pending: { label: "Baisse à valider", tone: "amber" },
  rejected: { label: "Baisse refusée", tone: "red" },
};

export const PLATFORM_CYCLE_META: Record<PlatformBillingCycle, { label: string; hint: string }> = {
  monthly: { label: "Mensuel", hint: "Frais du mois à régler au début du mois suivant" },
  weekly: { label: "Hebdomadaire", hint: "Frais de la semaine à régler au début de la semaine suivante" },
};

/** Statut affiché d'une écriture : une baisse remplacée par une nouvelle correction de prix n'a pas été refusée par Rydar. */
export function platformEntryStatusMeta(e: Pick<PlatformEntry, "status" | "superseded">): { label: string; tone: Tone } {
  if (e.status === "rejected" && e.superseded) return { label: "Baisse remplacée", tone: "neutral" };
  return PLATFORM_ENTRY_STATUS_META[e.status];
}

/** « Échéance : 5 octobre » / « En retard depuis 12 jours » / « Rien à régler ». */
export function platformDueSummary(a: Pick<PlatformAccount, "balance_cents" | "due_cents" | "days_overdue" | "overdue_since" | "next_due_at">,
  timeZone = "Europe/Paris"): { text: string; tone: Tone } {
  const day = (iso: string) => new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long", timeZone }).format(new Date(iso));
  if (a.due_cents > 0 && a.overdue_since) {
    const n = a.days_overdue;
    return { text: n <= 0 ? "Échéance dépassée aujourd'hui" : `En retard depuis ${n} jour${n > 1 ? "s" : ""}`, tone: "red" };
  }
  if (a.balance_cents > 0 && a.next_due_at) return { text: `À régler au plus tard le ${day(a.next_due_at)}`, tone: "amber" };
  if (a.balance_cents < 0) return { text: "Avance en votre faveur", tone: "green" };
  return { text: "Rien à régler", tone: "green" };
}

// -----------------------------------------------------------------------------
// Formulaires (montants saisis en euros côté écran, envoyés en centimes)
// -----------------------------------------------------------------------------
const positiveCents = z.coerce.number().int("Montant invalide").min(1, "Montant requis").max(10_000_000, "Montant trop élevé");
const isoDay = z.union([z.literal(""), z.null(), z.undefined(), z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date invalide")])
  .transform((v) => (v ? v : null));
const optionalText = (max: number) =>
  z.union([z.null(), z.undefined(), z.string()]).transform((v) => {
    const t = (v ?? "").trim();
    return t ? t.slice(0, max) : null;
  });

export const PLATFORM_PAYMENT_METHODS = ["transfer", "link", "cash", "card", "other"] as const satisfies readonly PlatformPaymentMethod[];

/** Centrale : « J'ai payé ». */
export const declarePlatformPaymentSchema = z.object({
  amountCents: positiveCents,
  method: z.enum(PLATFORM_PAYMENT_METHODS, { message: "Moyen de paiement requis" }),
  reference: optionalText(80),
  note: optionalText(500),
  paidOn: isoDay,
});
export type DeclarePlatformPaymentInput = z.output<typeof declarePlatformPaymentSchema>;

/** Super admin : paiement reçu directement. */
export const recordPlatformPaymentSchema = declarePlatformPaymentSchema;
export type RecordPlatformPaymentInput = DeclarePlatformPaymentInput;

/** Super admin : avoir (négatif) ou frais ajoutés (positif), motif obligatoire. */
export const platformAdjustSchema = z.object({
  amountCents: z.coerce.number().int("Montant invalide").refine((v) => v !== 0, "Montant requis")
    .refine((v) => Math.abs(v) <= 10_000_000, "Montant trop élevé"),
  reason: z.string().trim().min(3, "Motif requis").max(500),
});
export type PlatformAdjustInput = z.output<typeof platformAdjustSchema>;

/** Super admin : cycle, délai et blocage d'une centrale. */
export const platformTermsSchema = z.object({
  cycle: z.enum(["weekly", "monthly"]),
  paymentDays: z.coerce.number().int().min(0, "Entre 0 et 60 jours").max(60, "Entre 0 et 60 jours"),
  blockAfterDays: z.union([z.literal(""), z.null(), z.undefined(), z.coerce.number().int().min(1, "Entre 1 et 90 jours").max(90, "Entre 1 et 90 jours")])
    .transform((v) => (v === "" || v == null ? null : v)),
});
export type PlatformTermsInput = z.output<typeof platformTermsSchema>;

/** Super admin : coordonnées de paiement de Rydar (IBAN normalisé : majuscules, sans espaces). */
export const platformBillingSchema = z.object({
  payeeName: optionalText(120),
  iban: z.union([z.null(), z.undefined(), z.string()]).transform((v) => (v ?? "").replace(/\s+/g, "").toUpperCase() || null)
    .refine((v) => v == null || /^[A-Z]{2}[0-9]{2}[A-Z0-9]{10,30}$/.test(v), "IBAN invalide"),
  bic: z.union([z.null(), z.undefined(), z.string()]).transform((v) => (v ?? "").replace(/\s+/g, "").toUpperCase() || null)
    .refine((v) => v == null || /^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(v), "BIC invalide"),
  paymentLink: z.union([z.null(), z.undefined(), z.string()]).transform((v) => (v ?? "").trim() || null)
    .refine((v) => v == null || (/^https:\/\/\S+$/.test(v) && v.length <= 500), "Lien https:// requis"),
  instructions: optionalText(500),
});
export type PlatformBillingInput = z.output<typeof platformBillingSchema>;

/** IBAN lisible : « FR76 3000 6000 0112 3456 7890 189 ». */
export function formatIban(iban: string | null | undefined): string {
  return (iban ?? "").replace(/\s+/g, "").replace(/(.{4})/g, "$1 ").trim();
}
