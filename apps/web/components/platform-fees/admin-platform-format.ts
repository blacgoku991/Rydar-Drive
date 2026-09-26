// Frais plateforme (super admin) : formats, libellés et calculs d'affichage.
// Module neutre (ni « use client » ni « server-only ») : pages serveur, composants client et export CSV.
import {
  PAYMENT_METHOD_LABELS,
  PLATFORM_ENTRY_KIND_META,
  platformEntryStatusMeta,
  PLATFORM_PAYMENT_METHOD_META,
  PLATFORM_PAYMENT_STATUS_META,
  formatPrice,
  settlementStatusLabel,
  type PaymentMethod,
  type PlatformAccount,
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

/** Signaux du mois : « 2 courses à 0 € · 1 annulée après attribution ». */
export function monthSignals(a: Pick<PlatformAccount, "month">) {
  const parts: string[] = [];
  const z = a.month?.zero_price_rides ?? 0;
  const c = a.month?.cancelled_assigned_rides ?? 0;
  if (z) parts.push(`${z} course${z > 1 ? "s" : ""} à 0 €`);
  if (c) parts.push(`${c} annulée${c > 1 ? "s" : ""} après attribution`);
  return parts.join(" · ");
}

/** Ventilation des frais comptabilisés : d'où vient l'argent (courses) + ajustements / courses supprimées. */
export function originParts(a: PlatformAccount) {
  const other = a.posted_cents - a.collected_by_centrale_cents - a.with_drivers_cents - a.waived_by_centrale_cents;
  return [
    {
      key: "collected",
      label: "Encaissé par la centrale",
      hint: "Course payée à la centrale ou commission reçue du chauffeur",
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

/** Statut du règlement chauffeur d'une course (sens déduit de l'encaissement). */
export function rideSettlementLabel(ride: NonNullable<PlatformEntry["ride"]>) {
  if (!ride.settlement_status) return null;
  const direction = ride.payment_method === "cash" || ride.payment_method === "card" ? "driver_owes" : "centrale_owes";
  return settlementStatusLabel(ride.settlement_status as SettlementStatus, direction);
}

export const ridePaymentLabel = (m: PaymentMethod | null | undefined) => (m ? (PAYMENT_METHOD_LABELS[m] ?? m) : "—");

export function paymentStatusLabel(p: Pick<PlatformPayment, "status" | "received_cents" | "amount_cents">) {
  if (p.status === "confirmed" && p.received_cents != null && p.received_cents !== p.amount_cents) return "Reçu en partie";
  return PLATFORM_PAYMENT_STATUS_META[p.status].adminLabel;
}

export function paymentTone(p: Pick<PlatformPayment, "status" | "received_cents" | "amount_cents">): Tone {
  if (p.status === "confirmed" && p.received_cents != null && p.received_cents < p.amount_cents) return "amber";
  return PLATFORM_PAYMENT_STATUS_META[p.status].tone;
}
