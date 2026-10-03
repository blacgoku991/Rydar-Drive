// Frais plateforme (super admin) : formats, libellés et calculs d'affichage.
// Module neutre (ni « use client » ni « server-only ») : pages serveur, composants client et export CSV.
import {
  PAYMENT_METHOD_LABELS,
  PLATFORM_ENTRY_KIND_META,
  platformEntryStatusMeta,
  PLATFORM_PAYMENT_METHOD_META,
  PLATFORM_PAYMENT_STATUS_META,
  addIsoDays,
  formatPrice,
  localIsoDay,
  settlementStatusLabel,
  type PaymentMethod,
  type PlatformAccount,
  type PlatformBillingCycle,
  type PlatformEntry,
  type PlatformPayment,
  type PlatformPaymentMethod,
  type SettlementStatus,
  type Tone,
} from "@rydar/shared";
import { ArrowLeftRight, Banknote, CreditCard, Ellipsis, Link2, type LucideIcon } from "lucide-react";

export const PLATFORM_METHOD_ICON: Record<PlatformPaymentMethod, LucideIcon> = {
  transfer: ArrowLeftRight,
  link: Link2,
  cash: Banknote,
  card: CreditCard,
  other: Ellipsis,
};

export const platformMethodLabel = (m: string | null | undefined) => (m ? (PLATFORM_PAYMENT_METHOD_META[m as PlatformPaymentMethod]?.label ?? "Autre") : "—");

/** « 5 oct. 2026 » dans le fuseau de la centrale. */
export function formatDay(iso: string | Date | null | undefined, timeZone = "Europe/Paris", withYear = true) {
  if (!iso) return "—";
  const d = typeof iso === "string" && /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T12:00:00Z`) : new Date(iso);
  return new Intl.DateTimeFormat("fr-FR", {
    day: "numeric",
    month: "short",
    year: withYear ? "numeric" : undefined,
    timeZone: typeof iso === "string" && /^\d{4}-\d{2}-\d{2}$/.test(iso) ? "UTC" : timeZone,
  }).format(d);
}

/** « 25/09 14:32 » dans le fuseau donné. */
export function formatDayTime(iso: string | null | undefined, timeZone = "Europe/Paris") {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone }).format(new Date(iso));
}

/** « il y a 3 h », « il y a 2 j », « à l'instant ». */
export function ago(iso: string | null | undefined, now = Date.now()) {
  if (!iso) return "";
  const min = Math.round((now - Date.parse(iso)) / 60_000);
  if (min < 1) return "à l'instant";
  if (min < 60) return `il y a ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `il y a ${h} h`;
  const d = Math.round(h / 24);
  return `il y a ${d} j`;
}

/** Montant signé : « +5 € », « −2 € ». */
export function signedPrice(cents: number, currency = "EUR") {
  if (cents === 0) return formatPrice(0, currency);
  return `${cents > 0 ? "+" : "−"}${formatPrice(Math.abs(cents), currency)}`;
}

// ---------------------------------------------------------------------------- mois
/** « 2026-09 » (mois courant dans le fuseau donné). */
export function monthKey(d: Date, timeZone = "Europe/Paris") {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit" }).format(d).slice(0, 7);
}

/** « septembre 2026 » */
export function monthLabel(key: string) {
  return new Intl.DateTimeFormat("fr-FR", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${key}-15T12:00:00Z`));
}

export const capitalize = (v: string) => v.charAt(0).toUpperCase() + v.slice(1);

/** N mois, le plus récent d'abord. */
export function lastMonths(current: string, n: number) {
  const [y, m] = current.split("-").map(Number);
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(y!, m! - 1 - i, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  });
}

export const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Jour « AAAA-MM-JJ » réel (export des frais à facturer). */
export const ISO_DAY_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export type InvoiceCycle = { from: string; to: string; label: string; current: boolean };

/**
 * Cycles de facturation d'une organisation, le plus récent (en cours) d'abord : mois civils ou semaines du lundi au
 * dimanche, dans son fuseau ; `from` inclus, `to` exclu (admin_platform_invoice_lines). Facture récapitulative de chaque
 * cycle : frais pris en compte pendant le cycle (CGV art. 5).
 */
export function invoiceCycles(cycle: PlatformBillingCycle, now: Date, timeZone: string, n: number): InvoiceCycle[] {
  if (cycle === "weekly") {
    const today = localIsoDay(now, timeZone);
    const monday = addIsoDays(today, -((new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7));
    return Array.from({ length: n }, (_, i) => {
      const from = addIsoDays(monday, -7 * i);
      const to = addIsoDays(from, 7);
      return { from, to, label: `Semaine du ${formatDay(from, timeZone)} au ${formatDay(addIsoDays(to, -1), timeZone)}`, current: i === 0 };
    });
  }
  return lastMonths(monthKey(now, timeZone), n).map((m, i) => {
    const [y, mo] = m.split("-").map(Number);
    const next = new Date(Date.UTC(y!, mo!, 1));
    const to = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-01`;
    return { from: `${m}-01`, to, label: capitalize(monthLabel(m)), current: i === 0 };
  });
}

// ---------------------------------------------------------------------------- compte
/** Retard lisible : { text: « 12 j de retard », since: « depuis le 5 oct. » } ou null. */
export function overdueInfo(a: Pick<PlatformAccount, "due_cents" | "overdue_since" | "days_overdue">, timeZone = "Europe/Paris") {
  if (!(a.due_cents > 0) || !a.overdue_since) return null;
  const n = a.days_overdue;
  return {
    text: n <= 0 ? "Échue aujourd'hui" : `${n} j de retard`,
    since: `depuis le ${formatDay(a.overdue_since, timeZone, false)}`,
  };
}

/** Blocage de la création de courses : « Bloquée », « Suspendu » (retard au-delà du seuil, paiement déclaré récent),
 *  « Après 15 j » (de retard), « Désactivé ». */
export function blockInfo(a: Pick<PlatformAccount, "blocked" | "block_after_days" | "block_suspended">): { text: string; tone: Tone } {
  if (a.blocked) return { text: "Bloquée", tone: "red" };
  if (a.block_suspended) return { text: "Suspendu", tone: "amber" };
  if (a.block_after_days) return { text: `Après ${a.block_after_days} j`, tone: "neutral" };
  return { text: "Désactivé", tone: "neutral" };
}

/** Indicateurs du mois (private.platform_account) : cancelled_onboard_rides ajouté par 20260924004400. */
export type PlatformMonthStats = PlatformAccount["month"] & { cancelled_onboard_rides?: number };

/** Courses annulées après la prise en charge du client (0 si le compte ne le fournit pas). */
export const cancelledOnboard = (a: Pick<PlatformAccount, "month">) => (a.month as PlatformMonthStats | undefined)?.cancelled_onboard_rides ?? 0;

/**
 * Courses « à surveiller » du mois (private.platform_account.month.zero_price_rides) : centrale → à 0 €, sans prix ou
 * frais plafonnés au prix (frais nuls ou réduits) ; flotte → courses sans prix (ou à 0 €) dont seule la part en % est
 * perdue, le fixe restant dû (la base ne compte que celles dont les taux figés ont une part en %).
 */
export function zeroPriceText(n: number, model: PlatformAccount["dispatch_model"] | null | undefined, short = false) {
  const s = n > 1 ? "s" : "";
  if (model === "fleet") {
    return short
      ? `${n} course${s} sans prix (part en\u00a0% non due)`
      : `${n} course${s} terminée${s} sans prix ou à 0\u00a0€\u00a0: la part en\u00a0% du prix n'est pas due (les frais fixes restent dus)`;
  }
  return short
    ? `${n} course${s} à prix nul ou symbolique`
    : `${n} course${s} terminée${s} à 0 €, sans prix ou à un prix symbolique (frais nuls ou plafonnés au prix)`;
}

/** Signaux du mois : « 2 courses à prix nul ou symbolique · 3 annulées après attribution (dont 1 client à bord) ». */
export function monthSignals(a: Pick<PlatformAccount, "month" | "dispatch_model">) {
  const parts: string[] = [];
  const z = a.month?.zero_price_rides ?? 0;
  const c = a.month?.cancelled_assigned_rides ?? 0;
  const b = cancelledOnboard(a);
  if (z) parts.push(zeroPriceText(z, a.dispatch_model, true));
  if (c) parts.push(`${c} annulée${c > 1 ? "s" : ""} après attribution${b ? ` (dont ${b} client à bord)` : ""}`);
  return parts.join(" · ");
}

/**
 * Cellule CSV (séparateur « ; ») d'un texte libre : tenu sur une ligne (retours chariot, sauts de ligne et
 * tabulations → espace, un « \r » isolé ouvrirait une nouvelle ligne dans le tableur), formule neutralisée
 * (=, +, -, @ en tête → apostrophe), entre guillemets si « ; » ou « " ».
 */
export function csvText(v: string | null | undefined) {
  let s = (v ?? "").replace(/[\r\n\t]+/g, " ").trim();
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Ventilation des frais comptabilisés : d'où vient l'argent (courses) + ajustements / courses supprimées. Flotte : ses
 *  courses sont encaissées par elle-même (aucun règlement chauffeur). */
export function originParts(a: PlatformAccount) {
  const other = a.posted_cents - a.collected_by_centrale_cents - a.with_drivers_cents - a.waived_by_centrale_cents;
  const fleet = a.dispatch_model === "fleet";
  return [
    {
      key: "collected",
      label: fleet ? "Encaissé par la flotte" : "Encaissé par la centrale",
      hint: fleet ? "Courses de la flotte (et, en centrale, courses payées à la centrale ou commissions reçues)" : "Course payée à la centrale ou commission reçue du chauffeur",
      cents: a.collected_by_centrale_cents,
      bar: "bg-blue",
      text: "text-blue",
    },
    {
      key: "drivers",
      label: "Encore chez les chauffeurs",
      hint: "Règlement à régler, déclaré ou contesté",
      cents: a.with_drivers_cents,
      bar: "bg-amber",
      text: "text-amber",
    },
    {
      key: "waived",
      label: "Annulé par la centrale",
      hint: "Dette du chauffeur annulée : toujours dû à Rydar",
      cents: a.waived_by_centrale_cents,
      bar: "bg-red",
      text: "text-red",
    },
    { key: "other", label: "Ajustements", hint: "Avoirs, frais ajoutés, courses supprimées", cents: other, bar: "bg-fg-subtle", text: "text-fg-muted" },
  ] as const;
}

// ---------------------------------------------------------------------------- écritures et paiements
/** Statut d'une écriture ; une baisse REMPLACÉE par une correction plus récente du prix n'a pas été refusée par Rydar. */
export const entryStatusMeta = (e: Pick<PlatformEntry, "status" | "superseded">): { label: string; tone: Tone } => platformEntryStatusMeta(e);

export function entryKindLabel(e: Pick<PlatformEntry, "kind" | "amount_cents">) {
  if (e.kind === "adjustment") return e.amount_cents < 0 ? "Avoir" : "Frais ajoutés";
  return PLATFORM_ENTRY_KIND_META[e.kind].label;
}

/** Statut du règlement chauffeur d'une course (sens déduit de l'encaissement) ; course terminée en flotte : « Flotte ». */
export function rideSettlementLabel(ride: NonNullable<PlatformEntry["ride"]>) {
  if (ride.fleet_fee && !ride.settlement_status) return "Flotte";
  if (!ride.settlement_status) return null;
  const direction = ride.payment_method === "cash" || ride.payment_method === "card" ? "driver_owes" : "centrale_owes";
  return settlementStatusLabel(ride.settlement_status as SettlementStatus, direction);
}

export const ridePaymentLabel = (m: PaymentMethod | null | undefined) => (m ? (PAYMENT_METHOD_LABELS[m] ?? m) : "—");

// ---------------------------------------------------------------------------- baisses à valider
/**
 * Réseau partagé : baisse demandée en contestant une course partagée (contest_network_ride). Ce n'est pas une
 * correction du prix : jamais acceptée automatiquement au bout de 30 jours, les frais restent dus tant que Rydar ne
 * l'a pas acceptée (private.accept_stale_platform_reductions, 20260924006900).
 */
export const isNetworkContest = (e: Pick<PlatformEntry, "network_contest">) => e.network_contest != null;

/** Mention d'une baisse de contestation dans la liste (/admin/frais). */
export const NETWORK_CONTEST_NOTE = "Course partagée contestée\u00a0: jamais acceptée automatiquement, décision requise";

/**
 * En-tête de « Baisses de frais à valider » : règle des 30 jours (CGV art. 5) pour les corrections de prix seulement ;
 * une baisse de contestation d'une course partagée attend toujours la décision. Sans contestation : texte d'avant.
 */
export function pendingReductionsDescription(entries: Pick<PlatformEntry, "amount_cents" | "network_contest">[]): string {
  if (!entries.length) {
    return "Quand une centrale ou une flotte baisse le prix d'une course terminée, la baisse de frais attend votre décision ici (30 jours au plus, puis acceptée automatiquement).";
  }
  const total = formatPrice(-entries.reduce((s, e) => s + e.amount_cents, 0));
  const contests = entries.filter(isNetworkContest).length;
  const priceRule =
    "ne correspond pas à la course réellement effectuée et payée, avec un motif (affiché à l'organisation)\u00a0; sans décision dans les 30 jours, la baisse est acceptée automatiquement (CGV, article 5).";
  if (!contests) {
    return `Prix corrigé à la baisse après la course\u00a0: ${total} de frais en moins si vous acceptez tout. Refus seulement si la correction ${priceRule}`;
  }
  const contestRule =
    "Course partagée contestée\u00a0: à vous de décider, jamais acceptée automatiquement\u00a0; les frais restent dus tant que vous ne l'avez pas acceptée.";
  if (contests === entries.length) return `${total} de frais en moins si vous acceptez tout. ${contestRule}`;
  return `${total} de frais en moins si vous acceptez tout. Prix corrigé à la baisse après la course\u00a0: refus seulement si la correction ${priceRule} ${contestRule}`;
}

export function paymentStatusLabel(p: Pick<PlatformPayment, "status" | "received_cents" | "amount_cents">) {
  if (p.status === "confirmed" && p.received_cents != null && p.received_cents !== p.amount_cents) return "Reçu en partie";
  return PLATFORM_PAYMENT_STATUS_META[p.status].adminLabel;
}

export function paymentTone(p: Pick<PlatformPayment, "status" | "received_cents" | "amount_cents">): Tone {
  if (p.status === "confirmed" && p.received_cents != null && p.received_cents < p.amount_cents) return "amber";
  return PLATFORM_PAYMENT_STATUS_META[p.status].tone;
}
