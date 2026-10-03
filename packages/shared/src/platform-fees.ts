// Frais plateforme (« Frais Rydar ») : reversement des centrales ET des flottes à Rydar (super admin).
// Les règles d'argent sont appliquées en base (migrations 20260924003000_platform_fees, 20260924006400_fleet_platform_fees) :
// frais dus dès la fin de la course, registre immuable, baisses validées par le super admin,
// solde = frais comptabilisés − paiements CONFIRMÉS par le super admin. Ce module les présente.
// Centrale : frais calculés sur le prix et déduits dans la répartition (plafonnés au prix, rien sans prix). Flotte : % du
// prix (0 sans prix) + fixe, facturés à la flotte, taux figés à la fin de chaque course (fleetPlatformFee).
import { z } from "zod";
import { isValidIban } from "./format";
import type { Iso, Uuid } from "./types";
import type { OrgStatus, PaymentMethod } from "./domain";

type Tone = "green" | "amber" | "red" | "blue" | "violet" | "neutral";

export type PlatformPaymentStatus = "declared" | "confirmed" | "rejected" | "cancelled";
export type PlatformPaymentMethod = "transfer" | "link" | "cash" | "card" | "other";
export type PlatformEntryKind = "ride" | "correction" | "adjustment";
export type PlatformEntryStatus = "posted" | "pending" | "rejected";
export type PlatformBillingCycle = "weekly" | "monthly";

/** private.platform_account : compte d'une centrale ou d'une flotte envers Rydar (montants en centimes). */
export interface PlatformAccount {
  organization_id: Uuid;
  /** Modèle actuel de l'organisation (20260924006400) */
  dispatch_model?: "fleet" | "centrale";
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
  /** Frais déjà encaissés par l'organisation (course de flotte, course payée à la centrale ou règlement chauffeur confirmé) */
  collected_by_centrale_cents: number;
  /** Frais encore chez les chauffeurs (règlement à régler, déclaré ou contesté) */
  with_drivers_cents: number;
  /** Frais de courses dont la centrale a annulé la dette du chauffeur (toujours dus à Rydar) */
  waived_by_centrale_cents: number;
  /** Encaissé par la centrale et pas encore réglé à Rydar */
  held_by_centrale_cents: number;
  /** Création de courses refusée (retard au-delà du seuil choisi par le super admin) */
  blocked: boolean;
  /** Retard au-delà du seuil, mais blocage suspendu par un paiement « J'ai payé » récent (7 jours au plus,
   *  jamais dans les 7 jours qui suivent un « Pas reçu ») */
  block_suspended?: boolean;
  reminded_at: Iso | null;
  reminder_note: string | null;
  /** Hausse des frais par course annoncée, pas encore appliquée (20260924006600) ; null : aucune */
  scheduled_change?: PlatformScheduledFeeChange | null;
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
    /** Course terminée en mode flotte : taux figés à la fin de la course (null : règle centrale) */
    fleet_fee?: { percent: number; fixed_cents: number } | null;
  } | null;
  /**
   * Réseau partagé (20260924006900) : baisse demandée par la contestation d'une course partagée (« Contester la
   * course ») — jamais acceptée d'office, contrairement à une correction du prix (30 jours) ; clé absente sinon.
   */
  network_contest?: { contested_at: Iso } | null;
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

/** RPC org_platform_account(p_org) : carte « Frais plateforme » (Encaissements d'une centrale, « Frais Rydar » d'une flotte). */
export type OrgPlatformAccount =
  | { enabled: false }
  | {
      enabled: true;
      organization: { id: Uuid; name: string; status: OrgStatus; timezone: string; dispatch_model?: "fleet" | "centrale" };
      account: PlatformAccount;
      pay: PlatformPayInfo;
      payments: PlatformPayment[];
      entries: PlatformEntry[];
      /** 6 derniers mois, le plus récent d'abord (« YYYY-MM ») */
      months: { month: string; fees_cents: number; rides: number; received_cents: number }[];
    };

/** RPC org_platform_statement(p_org, p_month) / admin_platform_account(…).statement : relevé mensuel. */
export interface PlatformStatement {
  organization: { id: Uuid; name: string; currency: string; timezone: string; reference: string; dispatch_model?: "fleet" | "centrale" };
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

// -----------------------------------------------------------------------------
// Changements des frais par course (20260924006600) : hausse annoncée au moins 30 jours à l'avance, ou appliquée tout
// de suite (création, baisse, accord écrit de l'organisation)
// -----------------------------------------------------------------------------
export type PlatformFeeChangeMode = "initial" | "decrease" | "notice" | "consent";
export type PlatformFeeChangeStatus = "scheduled" | "applied" | "cancelled" | "replaced";
/** Date au plus tôt d'une hausse : 30 jours après l'annonce, entrée en vigueur des CGV non acceptées, ou date déjà annoncée. */
export type PlatformFeeMinReason = "notice_30_days" | "terms_effective" | "already_announced";

/** private.platform_account.scheduled_change : encart « À partir du JJ/MM/AAAA » (owner / admin). */
export interface PlatformScheduledFeeChange {
  id: Uuid;
  /** Taux à partir de la date d'effet */
  percent: number;
  fixed_cents: number;
  /** Taux au moment de l'annonce */
  from_percent: number;
  from_fixed_cents: number;
  /** Minuit (fuseau de l'organisation) du jour d'effet ; appliqué par le ménage dans les 5 min */
  effective_at: Iso;
  /** Jour d'effet « AAAA-MM-JJ » (fuseau de l'organisation) */
  effective_on: string;
  announced_at: Iso;
}

/** Ligne d'historique (super admin, admin_platform_fee_schedule). */
export interface PlatformFeeChangeRow {
  id: Uuid;
  mode: PlatformFeeChangeMode;
  status: PlatformFeeChangeStatus;
  from_percent: number;
  from_fixed_cents: number;
  percent: number;
  fixed_cents: number;
  effective_at: Iso;
  effective_on: string;
  consent_note: string | null;
  terms_version: string | null;
  terms_accepted: boolean | null;
  emails_queued: number;
  created_at: Iso;
  created_by_name: string | null;
  applied_at: Iso | null;
  closed_at: Iso | null;
  closed_by_name: string | null;
  close_reason: string | null;
  emails: { to_email: string; status: "pending" | "sending" | "sent" | "failed"; sent_at: Iso | null; subject: string; created_at: Iso }[];
  /** Hausse qui garde la date d'une hausse déjà annoncée : changement dont l'e-mail ouvre le préavis (null : le sien) */
  notice_change_id?: Uuid | null;
  /**
   * Hausse annoncée : premier envoi réussi de l'e-mail qui ouvre le préavis (null : pas encore parti). La hausse n'est
   * appliquée que s'il est parti au moins 30 jours avant `effective_at` ; sinon le ménage l'annule.
   */
  notice_sent_at?: Iso | null;
}

/** RPC admin_platform_fee_schedule(p_org, p_org_legal_version, p_org_legal_effective_on, p_percent?, p_fixed_cents?). */
export interface AdminPlatformFeeSchedule {
  organization_id: Uuid;
  dispatch_model: "fleet" | "centrale";
  timezone: string;
  currency: string;
  current: { percent: number; fixed_cents: number; terms_text: string };
  scheduled: PlatformFeeChangeRow | null;
  /**
   * null : version des CGV non fournie ou invalide. `notified_at` : annonce par e-mail de cette version
   * (svc_org_terms_notify ; sans elle ni acceptation, aucune hausse annoncée : TERMS_NOT_NOTIFIED), `notified_effective_on` :
   * entrée en vigueur annoncée à l'organisation (jamais de hausse annoncée avant).
   */
  terms: {
    version: string;
    accepted: boolean;
    accepted_at: Iso | null;
    effective_on: string;
    notified_at?: Iso | null;
    notified_effective_on?: string | null;
  } | null;
  /** Adresses qui recevraient l'annonce d'une hausse (propriétaires actifs, sinon l'organisation) : 0 = NO_EMAIL */
  email_recipients?: number;
  /** Date au plus tôt d'une hausse annoncée maintenant (sans tenir compte du changement déjà annoncé) */
  min_effective_on: string;
  min_reason: PlatformFeeMinReason;
  /** Aperçu d'un réglage (p_percent + p_fixed_cents fournis) */
  preview: {
    kind: "increase" | "decrease" | "unchanged";
    same_as_scheduled: boolean;
    min_effective_on: string | null;
    min_reason: PlatformFeeMinReason | null;
    default_effective_on: string | null;
    terms_text: string;
  } | null;
  history: PlatformFeeChangeRow[];
}

/** RPC svc_platform_set_fees (service role, actions serveur du super admin). */
export type SetPlatformFeesResult =
  | {
      ok: true;
      code: "SCHEDULED" | "APPLIED" | "CANCELLED" | "UNCHANGED";
      message: string;
      dispatch_model: "fleet" | "centrale";
      fee_percent: number;
      fee_fixed_cents: number;
      scheduled_change: PlatformScheduledFeeChange | null;
      applied_change_id: Uuid | null;
      replaced_change_id: Uuid | null;
      emails_queued: number;
      terms_accepted: boolean | null;
      min_effective_on: string | null;
      min_reason: PlatformFeeMinReason | null;
    }
  | {
      ok: false;
      code:
        | "INVALID" | "NOT_FOUND" | "ORG_NOT_NEW" | "SETTLEMENTS_OPEN" | "CONSENT_REQUIRED" | "NOTICE_TOO_SHORT"
        | "TERMS_VERSION_INVALID" | "TERMS_NOT_NOTIFIED" | "NO_EMAIL";
      message: string;
      field?: "platformFeePercent" | "platformFeeFixedCents" | "dispatchModel" | "effectiveOn" | "consentNote" | "mode";
      min_effective_on?: string;
      min_reason?: PlatformFeeMinReason;
      terms_accepted?: boolean | null;
      count?: number;
    };

/** RPC svc_platform_cancel_fee_change (service role, action serveur du super admin). */
export type CancelPlatformFeeChangeResult =
  | { ok: true; code: "CANCELLED"; message: string; emails_queued: number }
  | { ok: false; code: "NOT_FOUND" | "FEE_CHANGE_NOT_PENDING"; message: string };

/** RPC svc_org_terms_notify : annonce par e-mail des CGV aux organisations qui ne les ont pas acceptées. */
export type OrgTermsNotifyResult =
  | {
      ok: true;
      code: "NOTIFIED" | "NOTHING_TO_NOTIFY";
      message: string;
      /** Organisations prévenues par cet envoi, e-mails mis en file */
      organizations: number;
      emails: number;
      /** Déjà prévenues pour cette version (une seule annonce par organisation et par version) */
      already_notified: number;
      /** Sans adresse valide (propriétaire ni organisation) : pas notées, nouvel essai possible */
      without_email: number;
      /** Organisations actives ou suspendues qui n'ont pas accepté la version */
      not_accepted: number;
    }
  | { ok: false; code: "TERMS_VERSION_INVALID" | "TERMS_EFFECTIVE_PASSED" | "TERMS_NOTICE_TOO_SHORT"; message: string; min_effective_on?: string };

/**
 * RPC admin_platform_invoice_lines(p_org, p_from, p_to) (super admin) : frais à facturer d'un cycle — écritures comptées
 * prises en compte du jour `from` (inclus) au jour `to` (exclu), jours locaux de l'organisation (enregistrement, ou
 * acceptation d'une baisse : `counted_at`). Facture récapitulative de chaque cycle (CGV art. 5).
 */
export type AdminPlatformInvoiceLines =
  | {
      ok: true;
      organization: {
        id: Uuid; name: string; slug: string; currency: string; timezone: string; reference: string;
        dispatch_model: "fleet" | "centrale"; cycle: PlatformBillingCycle; payment_days: number;
      };
      from: string;
      to: string;
      /** Échéance des frais enregistrés pendant la période (fin de leur cycle + délai de paiement) */
      due_at: Iso;
      total_cents: number;
      entries: (PlatformEntry & { counted_at: Iso })[];
    }
  | { ok: false; code: "INVALID"; message: string };

/** Taux de frais par course : % du prix et montant fixe (centimes). */
export type PlatformFeeRates = { percent: number | string; fixed_cents: number };

/** Centièmes de pour cent (numeric(5,2)) : comparaison exacte de deux taux. */
const feeHundredths = (percent: number | string) => Math.round(Number(((Number(percent) || 0) * 100).toFixed(6)));

/**
 * Nature d'un nouveau réglage des frais par course (miroir de svc_platform_set_fees) : HAUSSE dès que l'un des deux
 * taux augmente (y compris 0 → plus de 0, ou % en baisse avec un fixe en hausse), inchangé si les deux sont égaux,
 * sinon baisse.
 */
export function platformFeeChangeKind(current: PlatformFeeRates, next: PlatformFeeRates): "increase" | "decrease" | "unchanged" {
  const [cp, np] = [feeHundredths(current.percent), feeHundredths(next.percent)];
  const [cf, nf] = [Math.trunc(Number(current.fixed_cents) || 0), Math.trunc(Number(next.fixed_cents) || 0)];
  if (np > cp || nf > cf) return "increase";
  return np === cp && nf === cf ? "unchanged" : "decrease";
}

/**
 * Dates d'une hausse annoncée maintenant (miroir de svc_platform_set_fees) : `min` = date d'effet au plus tôt, `reason`
 * = ce qui la fixe, `defaultOn` = date proposée. Une hausse égale ou moindre que celle déjà annoncée (les deux taux ≤
 * ceux annoncés) peut garder la date annoncée ; un remplacement garde par défaut la date annoncée quand elle est permise.
 * Dates « AAAA-MM-JJ » (jour d'effet, minuit dans le fuseau de l'organisation).
 */
export function platformFeeNoticeDates(
  schedule: Pick<AdminPlatformFeeSchedule, "min_effective_on" | "min_reason"> & {
    scheduled: Pick<PlatformFeeChangeRow, "percent" | "fixed_cents" | "effective_on"> | null;
  },
  next: PlatformFeeRates,
): { min: string; reason: PlatformFeeMinReason; defaultOn: string } {
  let min = schedule.min_effective_on;
  let reason = schedule.min_reason;
  const s = schedule.scheduled;
  if (s && feeHundredths(next.percent) <= feeHundredths(s.percent) && Number(next.fixed_cents) <= Number(s.fixed_cents) && s.effective_on < min) {
    min = s.effective_on;
    reason = "already_announced";
  }
  return { min, reason, defaultOn: s && s.effective_on > min ? s.effective_on : min };
}

/** Ce qui fixe la date d'effet au plus tôt d'une hausse. */
export const PLATFORM_FEE_MIN_REASON_LABEL: Record<PlatformFeeMinReason, string> = {
  notice_30_days: "30 jours après l'annonce",
  terms_effective: "entrée en vigueur des CGV, pas encore acceptées par l'organisation",
  already_announced: "date déjà annoncée",
};

export const PLATFORM_FEE_CHANGE_MODE_META: Record<PlatformFeeChangeMode, { label: string }> = {
  initial: { label: "Création" },
  decrease: { label: "Baisse" },
  notice: { label: "Hausse annoncée" },
  consent: { label: "Hausse sur accord écrit" },
};

export const PLATFORM_FEE_CHANGE_STATUS_META: Record<PlatformFeeChangeStatus, { label: string; tone: Tone }> = {
  scheduled: { label: "Programmé", tone: "amber" },
  applied: { label: "Appliqué", tone: "green" },
  cancelled: { label: "Annulé", tone: "neutral" },
  replaced: { label: "Remplacé", tone: "neutral" },
};

/** « 05/11/2026 » d'une date « AAAA-MM-JJ » (sans fuseau : c'est déjà un jour local). */
export function isoDayLabel(iso: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? "");
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "—";
}

/** « AAAA-MM-JJ » + n jours (calendrier, sans fuseau). */
export function addIsoDays(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Règle des taux APPLIQUÉS aux courses, selon le modèle (inchangée par 20260924006600) : flotte = taux en vigueur à
 * la fin de la course ; centrale = taux en vigueur au calcul de la répartition (création, puis chaque changement de
 * prix, de commission ou de mode de paiement, y compris après la course, par correction). `from` : « maintenant » ou
 * « cette date » (annonce).
 */
export function platformFeeScopeText(model: "fleet" | "centrale" | null | undefined, from: "now" | "date"): string {
  const at = from === "now" ? "à partir de maintenant" : "à partir de cette date";
  return model === "centrale"
    ? `Ils s'appliquent aux répartitions du prix calculées ${at}\u00a0: nouvelles courses, et courses dont le prix, la commission ou le mode de paiement est modifié (y compris une course déjà terminée, par une écriture de correction).`
    : `Ils s'appliquent aux courses terminées ${at}\u00a0; une course déjà terminée garde ses frais.`;
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
    | "declared" | "cancelled" | "confirmed" | "rejected" | "reopened" | "reminded" | "terms"
    /** Frais par course changés par le super admin (20260924006400) */
    | "rates"
    /** Modèle d'exploitation changé par le super admin (20260924006400) : le tableau de bord se relit */
    | "model"
    /** Hausse des frais par course annoncée (date d'effet à venir), ou annonce annulée (20260924006600) */
    | "rates_scheduled"
    | "rates_cancelled";
  organization_id: Uuid;
  /** Identifiants seulement : le canal org:{id} est lisible par tous les membres (dispatchers compris) */
  payment_id?: Uuid;
  entry_id?: Uuid;
  /** Détails complétés côté écran par une lecture qui contrôle le rôle (jamais transmis par le temps réel) */
  payment?: PlatformPayment;
  entry?: PlatformEntry;
  note?: string | null;
  /** « rates » : nouveaux frais par course (relus par org_platform_account) */
  terms?: Pick<PlatformAccount, "fee_percent" | "fee_fixed_cents" | "currency">;
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

/**
 * `round(cents * percent / 100)` de PostgreSQL (type numeric : calcul exact, arrondi « demi loin de zéro »), en
 * entiers : le pourcentage a deux décimales au plus (colonnes numeric(5,2), arrondi au centième comme la base), jamais
 * de virgule flottante dans le produit (30 € à 1,15 % = 34,5 c → 35 c comme la base ; 3000 × 1,15 / 100 en virgule
 * flottante donnait 34,499… → 34 c).
 */
export function percentOfCents(cents: number, percent: number | string | null | undefined): number {
  const amount = Math.trunc(Number(cents) || 0);
  // Centièmes de pour cent : 1,15 % → 115 (toFixed absorbe l'erreur de représentation, ex. 2,675 × 100 = 267,4999…)
  const hundredths = Math.round(Number(((Number(percent) || 0) * 100).toFixed(6)));
  const product = amount * hundredths; // entier exact (|produit| < 2^53 pour les montants et taux admis)
  const abs = Math.abs(product);
  const rest = abs % 10_000;
  const rounded = (abs - rest) / 10_000 + (rest >= 5_000 ? 1 : 0);
  return product < 0 ? -rounded : rounded;
}

/**
 * Frais Rydar d'une course de FLOTTE (miroir de private.fleet_platform_fee) : % du prix (0 sans prix) + fixe, sans
 * plafond au prix (facturés à la flotte, pas déduits du prix comme en centrale). Arrondi identique à la base.
 */
export function fleetPlatformFee(priceCents: number | null | undefined, percent: number, fixedCents: number): number {
  const price = Math.max(0, Math.trunc(Number(priceCents) || 0));
  return Math.min(10_000_000, percentOfCents(price, percent) + (Math.trunc(Number(fixedCents)) || 0));
}

/**
 * Frais Rydar d'une course de CENTRALE (miroir de private.compute_ride_split) : % du prix + fixe, jamais plus que le
 * prix. Arrondi identique à la base.
 */
export function centralePlatformFee(priceCents: number, percent: number, fixedCents: number): number {
  const price = Math.max(0, Math.trunc(Number(priceCents) || 0));
  return Math.min(price, percentOfCents(price, percent) + (Math.trunc(Number(fixedCents)) || 0));
}

/** Écriture d'une course terminée en mode flotte (pas de règlement chauffeur ni de répartition). */
export const isFleetFeeRide = (ride: PlatformEntry["ride"] | null | undefined) => !!ride?.fleet_fee && !ride.settlement_status;

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

/** Super admin : avoir (négatif) ou frais ajoutés (positif), motif obligatoire. */
export const platformAdjustSchema = z.object({
  amountCents: z.coerce.number().int("Montant invalide").refine((v) => v !== 0, "Montant requis")
    .refine((v) => Math.abs(v) <= 10_000_000, "Montant trop élevé"),
  reason: z.string().trim().min(3, "Motif requis").max(500),
});

/**
 * Délai de paiement des frais au plus : 45 jours après la fin du cycle (la facture récapitulative, émise à la fin du
 * cycle, est une facture périodique : article L441-10 du Code de commerce ; garde SQL de 20260924006600).
 */
export const PLATFORM_PAYMENT_DAYS_MAX = 45;

/** Super admin : cycle, délai et blocage d'une centrale. */
export const platformTermsSchema = z.object({
  cycle: z.enum(["weekly", "monthly"]),
  paymentDays: z.coerce.number().int().min(0, "Entre 0 et 45 jours").max(PLATFORM_PAYMENT_DAYS_MAX, "Entre 0 et 45 jours"),
  blockAfterDays: z.union([z.literal(""), z.null(), z.undefined(), z.coerce.number().int().min(1, "Entre 1 et 90 jours").max(90, "Entre 1 et 90 jours")])
    .transform((v) => (v === "" || v == null ? null : v)),
});

/**
 * Super admin : modèle d'exploitation + frais par course d'une organisation existante (svc_platform_set_fees).
 *  - taux : les deux, ou aucun (changement de modèle seul : taux et changement annoncé inchangés) ;
 *  - hausse : « notice » (annoncée, date d'effet facultative : par défaut la plus proche permise) ou « consent » (accord
 *    écrit de l'organisation reçu : appliquée tout de suite, note obligatoire). Baisse : appliquée tout de suite.
 */
export const platformFeeSettingSchema = z
  .object({
    dispatchModel: z.enum(["fleet", "centrale"], { message: "Modèle d'exploitation inconnu" }),
    platformFeePercent: z
      .union([z.null(), z.undefined(), z.coerce.number().min(0, "Entre 0 et 50 %").max(50, "Entre 0 et 50 %")])
      .transform((v) => (v == null ? null : feeHundredths(v) / 100))
      .default(null),
    platformFeeFixedCents: z
      .union([z.null(), z.undefined(), z.coerce.number().int("Montant invalide").min(0, "Entre 0 et 1 000 €").max(100_000, "Entre 0 et 1 000 €")])
      .transform((v) => v ?? null)
      .default(null),
    mode: z.enum(["notice", "consent"]).default("notice"),
    // Clés absentes acceptées (zod 4 : une union avec undefined ne rend pas la clé facultative)
    effectiveOn: isoDay.default(null),
    consentNote: optionalText(500).default(null),
  })
  .superRefine((v, ctx) => {
    if ((v.platformFeePercent == null) !== (v.platformFeeFixedCents == null)) {
      ctx.addIssue({ code: "custom", path: [v.platformFeePercent == null ? "platformFeePercent" : "platformFeeFixedCents"], message: "Indiquez les deux taux (0 si aucun)" });
    }
    if (v.mode === "consent" && (v.consentNote ?? "").length < 3) {
      ctx.addIssue({ code: "custom", path: ["consentNote"], message: "Précisez la date et la forme de l'accord écrit (e-mail, courrier…)" });
    }
  });
export type PlatformFeeSettingInput = z.output<typeof platformFeeSettingSchema>;

/** Super admin : coordonnées de paiement de Rydar (IBAN normalisé : majuscules, sans espaces). */
export const platformBillingSchema = z.object({
  payeeName: optionalText(120),
  iban: z.union([z.null(), z.undefined(), z.string()]).transform((v) => (v ?? "").replace(/\s+/g, "").toUpperCase() || null)
    .refine((v) => v == null || isValidIban(v), "IBAN invalide (vérifiez les chiffres)"),
  bic: z.union([z.null(), z.undefined(), z.string()]).transform((v) => (v ?? "").replace(/\s+/g, "").toUpperCase() || null)
    .refine((v) => v == null || /^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(v), "BIC invalide"),
  paymentLink: z.union([z.null(), z.undefined(), z.string()]).transform((v) => (v ?? "").trim() || null)
    .refine((v) => v == null || (/^https:\/\/\S+$/.test(v) && v.length <= 500), "Lien https:// requis"),
  instructions: optionalText(500),
});

/** IBAN lisible : « FR76 3000 6000 0112 3456 7890 189 ». */
export function formatIban(iban: string | null | undefined): string {
  return (iban ?? "").replace(/\s+/g, "").replace(/(.{4})/g, "$1 ").trim();
}
