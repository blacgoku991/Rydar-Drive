// Frais plateforme (côté centrale) : textes et formats purs (utilisables côté serveur comme côté client).
import { PLATFORM_PAYMENT_METHOD_META, formatPrice, type PlatformAccount, type PlatformPaymentMethod } from "@rydar/shared";

export const platformMethodLabel = (m: string | null | undefined) => PLATFORM_PAYMENT_METHOD_META[(m ?? "other") as PlatformPaymentMethod]?.label ?? "Autre";

/** Montant signé lisible : « +5 € », « −2 € » (signe moins typographique). */
export function signedPrice(cents: number, currency = "EUR") {
  if (cents === 0) return formatPrice(0, currency);
  return `${cents < 0 ? "\u2212" : "+"}${formatPrice(Math.abs(cents), currency)}`;
}

/** « −2 € », « 5 € » (signe moins typographique seulement). */
export function price(cents: number, currency = "EUR") {
  return cents < 0 ? `\u2212${formatPrice(-cents, currency)}` : formatPrice(cents, currency);
}

/** « 5 € par course terminée », « 2 % du prix + 0,50 € par course ». */
export function feeTermsText(a: Pick<PlatformAccount, "fee_percent" | "fee_fixed_cents" | "currency">) {
  const pct = Number(a.fee_percent) || 0;
  const fixed = a.fee_fixed_cents || 0;
  const pctText = `${String(pct).replace(".", ",")} % du prix`;
  if (pct > 0 && fixed > 0) return `${pctText} + ${formatPrice(fixed, a.currency)} par course terminée`;
  if (pct > 0) return `${pctText} de chaque course terminée`;
  if (fixed > 0) return `${formatPrice(fixed, a.currency)} par course terminée`;
  return "aucuns frais par course pour l'instant";
}

/** « Facturation mensuelle · à régler au plus tard le 5 du mois suivant ». */
export function cycleText(a: Pick<PlatformAccount, "cycle" | "payment_days">) {
  const n = a.payment_days;
  if (a.cycle === "weekly") {
    return n > 0
      ? `Facturation hebdomadaire · à régler sous ${n} jour${n > 1 ? "s" : ""} après la fin de la semaine`
      : "Facturation hebdomadaire · à régler avant la fin de la semaine";
  }
  return n > 0
    ? `Facturation mensuelle · à régler au plus tard le ${n === 1 ? "1er" : n} du mois suivant`
    : "Facturation mensuelle · à régler avant la fin du mois";
}

/** « 26 sept. », « 26 sept. 2025 » (autre année). */
export function shortDay(iso: string | null | undefined, timeZone: string, now = Date.now()) {
  if (!iso) return "—";
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso);
  const sameYear =
    new Intl.DateTimeFormat("fr-FR", { year: "numeric", timeZone }).format(d) ===
    new Intl.DateTimeFormat("fr-FR", { year: "numeric", timeZone }).format(new Date(now));
  return new Intl.DateTimeFormat("fr-FR", {
    day: "numeric",
    month: "short",
    year: sameYear ? undefined : "numeric",
    timeZone: iso.length === 10 ? "UTC" : timeZone,
  }).format(d);
}

/** « 26 sept. 14:32 » */
export function dayTime(iso: string | null | undefined, timeZone: string) {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone }).format(new Date(iso));
}

/** « il y a 3 h », « il y a 2 j » */
export function ago(iso: string | null | undefined, now: number) {
  if (!iso) return "";
  const min = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (min < 1) return "à l'instant";
  if (min < 60) return `il y a ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `il y a ${h} h`;
  return `il y a ${Math.round(h / 24)} j`;
}

/** Date du jour (« YYYY-MM-DD ») dans le fuseau de la centrale. */
export function todayIn(timeZone: string, now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone }).format(now);
}

/** Relance récente de Rydar (7 jours). */
export const RECENT_REMINDER_MS = 7 * 24 * 3600_000;
export const isRecentReminder = (a: Pick<PlatformAccount, "reminded_at">, now: number) =>
  !!a.reminded_at && now - Date.parse(a.reminded_at) < RECENT_REMINDER_MS;

/** Montant saisi en euros (« 120 », « 120,50 ») → centimes ; null si vide ; NaN si invalide. */
export function eurosInputToCents(v: string): number | null {
  const t = v
    .trim()
    .replace(/[\s  ]/g, "")
    .replace("€", "")
    .replace(",", ".");
  if (!t) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return Number.NaN;
  return Math.round(Number(t) * 100);
}

export const centsToEurosInput = (cents: number) => (cents <= 0 ? "" : cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2).replace(".", ","));

// Règlement chauffeur de la course liée à une écriture (commission due par le chauffeur, ou part à lui verser).
const COMMISSION_STATUS: Record<string, { text: string; tone: "green" | "amber" | "red" | "blue" | "neutral" }> = {
  due: { text: "Commission à régler", tone: "amber" },
  declared: { text: "Commission payée, à confirmer", tone: "blue" },
  paid: { text: "Commission encaissée", tone: "green" },
  waived: { text: "Commission annulée · frais dus", tone: "red" },
  disputed: { text: "Commission non reçue", tone: "red" },
};
const PAYOUT_STATUS: Record<string, { text: string; tone: "green" | "amber" | "red" | "blue" | "neutral" }> = {
  due: { text: "Payée à la centrale · part à verser", tone: "green" },
  declared: { text: "Payée à la centrale · versement déclaré", tone: "green" },
  paid: { text: "Payée à la centrale · part versée", tone: "green" },
  waived: { text: "Payée à la centrale · versement annulé", tone: "green" },
  disputed: { text: "Payée à la centrale · versement contesté", tone: "green" },
};

/** « Commission encaissée », « Commission annulée · frais dus », « Payée à la centrale · part à verser »… */
export function rideSettlementText(ride: { payment_method: string; settlement_status: string | null } | null) {
  if (!ride) return null;
  const s = ride.settlement_status ?? "";
  if (ride.payment_method === "cash" || ride.payment_method === "card") {
    return COMMISSION_STATUS[s] ?? { text: "Commission : aucun règlement", tone: "neutral" as const };
  }
  return PAYOUT_STATUS[s] ?? { text: "Payée à la centrale", tone: "green" as const };
}
