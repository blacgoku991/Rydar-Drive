// Frais plateforme (côté centrale ou flotte) : textes et formats purs (utilisables côté serveur comme côté client).
import {
  PLATFORM_PAYMENT_METHOD_META, formatDate, formatPrice, isoDayLabel, platformFeeScopeText, type DispatchModel, type PlatformAccount, type PlatformPaymentMethod,
  type PlatformStatement,
} from "@rydar/shared";

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

/** « 5 € par course terminée », « 2 % du prix + 0,50 € par course ». `none` : texte sans frais. */
export function feeTermsText(a: Pick<PlatformAccount, "fee_percent" | "fee_fixed_cents" | "currency">, none = "aucuns frais par course pour l'instant") {
  const pct = Number(a.fee_percent) || 0;
  const fixed = a.fee_fixed_cents || 0;
  const pctText = `${String(pct).replace(".", ",")} % du prix`;
  if (pct > 0 && fixed > 0) return `${pctText} + ${formatPrice(fixed, a.currency)} par course terminée`;
  if (pct > 0) return `${pctText} de chaque course terminée`;
  if (fixed > 0) return `${formatPrice(fixed, a.currency)} par course terminée`;
  return none;
}

/** Espaces insécables avant « : ; ! ? » et à l'intérieur des guillemets (textes composés, comme private.fr_typo). */
export const frSpaces = (t: string) => t.replace(/ ([:;!?»])/g, "\u00a0$1").replace(/« /g, "«\u00a0");

/** 30 jours : préavis d'une hausse annoncée (svc_platform_set_fees, CGV art. 5). */
const NOTICE_MS = 30 * 86_400_000;

/**
 * Hausse des frais par course annoncée (account.scheduled_change, 20260924006600) : encart « À partir du JJ/MM/AAAA »
 * de « Frais Rydar » (flotte) / « Encaissements » (centrale), bandeau et alerte. Règle des taux appliqués selon le
 * modèle (flotte : fin de course ; centrale : calcul de la répartition). null : aucune hausse annoncée.
 * « au moins 30 jours à l'avance » seulement quand c'est vrai : une hausse annoncée remplacée par une hausse moindre
 * ou plus tardive garde sa date sans nouveau préavis (CGV art. 5), et sa nouvelle annonce peut être plus proche.
 */
export function scheduledFeeChangeText(
  a: Pick<PlatformAccount, "scheduled_change" | "fee_percent" | "fee_fixed_cents" | "currency">,
  model: DispatchModel | null | undefined,
  timeZone = "Europe/Paris",
): { title: string; next: string; body: string } | null {
  const c = a.scheduled_change;
  if (!c) return null;
  const on = isoDayLabel(c.effective_on);
  const target = feeTermsText({ fee_percent: c.percent, fee_fixed_cents: c.fixed_cents, currency: a.currency }, "aucuns frais par course");
  const now = feeTermsText(a, "aucuns frais par course");
  const next = frSpaces(`À partir du ${on} : ${target} (actuellement : ${now}).`);
  const fullNotice = Date.parse(c.effective_at) - Date.parse(c.announced_at) >= NOTICE_MS;
  const announced = fullNotice
    ? `Annoncé le ${formatDate(c.announced_at, timeZone)}, au moins 30 jours à l'avance`
    : `Annoncé le ${formatDate(c.announced_at, timeZone)}, en remplacement d'une annonce précédente (frais moins élevés ou date plus tardive)`;
  return {
    title: `Vos frais par course changent le ${on}`,
    next,
    body: frSpaces(
      `${next} ${platformFeeScopeText(model ?? "fleet", "date")} ${announced} : si vous ne l'acceptez pas, vous pouvez résilier sans frais avant cette date.`,
    ),
  };
}

/**
 * « Facturation mensuelle · à régler au plus tard le 5 du mois suivant ». Au-delà de 28 jours (le « 31 du mois
 * suivant » n'existe pas toujours, et un délai de 45 jours tombe le mois d'après) : « sous N jours après la fin du mois ».
 */
export function cycleText(a: Pick<PlatformAccount, "cycle" | "payment_days">) {
  const n = a.payment_days;
  if (a.cycle === "weekly") {
    return n > 0
      ? `Facturation hebdomadaire · à régler sous ${n} jour${n > 1 ? "s" : ""} après la fin de la semaine`
      : "Facturation hebdomadaire · à régler avant la fin de la semaine";
  }
  if (n > 28) return `Facturation mensuelle · à régler sous ${n} jours après la fin du mois`;
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

/** « Commission encaissée », « Commission annulée · frais dus », « Payée à la centrale · part à verser »… ; course de
 *  flotte (taux figés, aucun règlement chauffeur) : « Course de la flotte ». */
export function rideSettlementText(
  ride: { payment_method: string; settlement_status: string | null; fleet_fee?: { percent: number; fixed_cents: number } | null } | null,
) {
  if (!ride) return null;
  if (ride.fleet_fee && !ride.settlement_status) return { text: "Course de la flotte", tone: "neutral" as const };
  const s = ride.settlement_status ?? "";
  if (ride.payment_method === "cash" || ride.payment_method === "card") {
    return COMMISSION_STATUS[s] ?? { text: "Commission : aucun règlement", tone: "neutral" as const };
  }
  return PAYOUT_STATUS[s] ?? { text: "Payée à la centrale", tone: "green" as const };
}

/** Colonne « Règlement chauffeur » du relevé : centrale, ou flotte dont une course a un règlement (ancien passage en centrale). */
export const showSettlementColumn = (s: Pick<PlatformStatement, "organization" | "entries">) =>
  s.organization.dispatch_model !== "fleet" || s.entries.some((e) => !!e.ride?.settlement_status);
