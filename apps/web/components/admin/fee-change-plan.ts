// Super admin : ce que fera l'enregistrement d'un réglage des frais par course (miroir de svc_platform_set_fees, qui
// reste seul juge), pour l'aperçu, la date d'effet proposée et la confirmation. Module neutre (testé).
import {
  PLATFORM_FEE_MIN_REASON_LABEL, isoDayLabel, platformFeeChangeKind, platformFeeNoticeDates, type AdminPlatformFeeSchedule,
  type PlatformFeeMinReason,
} from "@rydar/shared";

export type FeeRatesInput = { percent: number; fixedCents: number };

export type FeePlanInput = {
  /** Taux en vigueur */
  current: FeeRatesInput;
  /** Taux saisis (null : saisie illisible) */
  next: FeeRatesInput | null;
  /** admin_platform_fee_schedule (null : lecture impossible, la base calcule seule la date) */
  schedule: (Pick<AdminPlatformFeeSchedule, "min_effective_on" | "min_reason"> & {
    scheduled: { percent: number; fixed_cents: number; effective_on: string } | null;
  }) | null;
  /** Hausse : annoncée (préavis) ou appliquée sur accord écrit */
  mode: "notice" | "consent";
  /** Date d'effet choisie (« AAAA-MM-JJ » ; vide : date proposée) */
  effectiveOn: string;
  /** Date d'effet la plus lointaine (aujourd'hui + 366 jours) */
  maxEffectiveOn: string;
};

export type FeePlan = {
  kind: "increase" | "decrease" | "unchanged";
  /** Taux envoyés ; sinon changement de modèle seul (taux et hausse annoncée inchangés) */
  sendRates: boolean;
  /** Hausse annoncée : date au plus tôt, ce qui la fixe, date proposée (null : inconnues, calculées par la base) */
  min: string | null;
  reason: PlatformFeeMinReason | null;
  defaultOn: string | null;
  /** Date d'effet affichée (choisie, sinon proposée) */
  displayOn: string | null;
  /** Date d'effet ENVOYÉE : la date choisie ; null = la base prend la date proposée (toujours à jour) */
  sendOn: string | null;
  dateError: string | null;
  /** Même hausse et même date que l'annonce en cours : rien ne change (aucun nouvel e-mail) */
  sameAsScheduled: boolean;
  /** L'annonce en cours est remplacée : nouvelle annonce, baisse ou accord écrit (e-mail au propriétaire) */
  replacesScheduled: boolean;
};

const hundredths = (p: number) => Math.round(Number((p * 100).toFixed(6)));

export function feeChangePlan(i: FeePlanInput): FeePlan {
  const kind = i.next
    ? platformFeeChangeKind({ percent: i.current.percent, fixed_cents: i.current.fixedCents }, { percent: i.next.percent, fixed_cents: i.next.fixedCents })
    : "unchanged";
  const sendRates = kind !== "unchanged";
  const s = i.schedule?.scheduled ?? null;
  const none = { min: null, reason: null, defaultOn: null, displayOn: null, sendOn: null, dateError: null, sameAsScheduled: false };
  if (kind !== "increase" || !i.next) return { kind, sendRates, ...none, replacesScheduled: sendRates && !!s };

  const dates = i.schedule ? platformFeeNoticeDates(i.schedule, { percent: i.next.percent, fixed_cents: i.next.fixedCents }) : null;
  const base = { kind, sendRates, min: dates?.min ?? null, reason: dates?.reason ?? null, defaultOn: dates?.defaultOn ?? null };
  if (i.mode === "consent") return { ...base, displayOn: null, sendOn: null, dateError: null, sameAsScheduled: false, replacesScheduled: !!s };

  const chosen = /^\d{4}-\d{2}-\d{2}$/.test(i.effectiveOn) ? i.effectiveOn : "";
  const displayOn = chosen || dates?.defaultOn || null;
  let dateError: string | null = null;
  if (i.effectiveOn && !chosen) dateError = "Date invalide.";
  else if (displayOn && dates && displayOn < dates.min) {
    dateError = `Au plus tôt le ${isoDayLabel(dates.min)} (${PLATFORM_FEE_MIN_REASON_LABEL[dates.reason]}), sauf accord écrit de l'organisation.`;
  } else if (displayOn && displayOn > i.maxEffectiveOn) dateError = `Un an au plus : le ${isoDayLabel(i.maxEffectiveOn)} au plus tard.`;
  const same = !!s && hundredths(i.next.percent) === hundredths(Number(s.percent)) && i.next.fixedCents === Number(s.fixed_cents) && displayOn === s.effective_on;
  return { ...base, displayOn, sendOn: chosen || null, dateError, sameAsScheduled: same, replacesScheduled: !!s && !same };
}
