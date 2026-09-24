import type { VehicleCategory } from "./domain";

export type PricingRule = {
  vehicle_category: VehicleCategory;
  base_fare_cents: number;
  per_km_cents: number;
  per_minute_cents: number;
  minimum_fare_cents: number;
  night_surcharge_percent: number;
  night_start: string; // "21:00"
  night_end: string; // "06:00"
  fixed_fares?: { label: string; price_cents: number }[];
};

function minutesOf(hhmm: string): number {
  const [h = "0", m = "0"] = hhmm.split(":");
  return Number(h) * 60 + Number(m);
}

export function isNight(date: Date, rule: Pick<PricingRule, "night_start" | "night_end">, timeZone = "Europe/Paris"): boolean {
  const parts = new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }).format(date);
  const now = minutesOf(parts);
  const start = minutesOf(rule.night_start);
  const end = minutesOf(rule.night_end);
  return start <= end ? now >= start && now < end : now >= start || now < end;
}

/**
 * Estimation de prix (arrondie à 1 €). Les forfaits (fixed_fares) sont
 * proposés séparément à l'utilisateur, ils ne sont pas devinés ici.
 */
export function estimatePrice(
  rule: PricingRule,
  distanceM: number,
  durationS: number,
  pickupAt: Date = new Date(),
  timeZone = "Europe/Paris",
): number {
  const raw = rule.base_fare_cents + (distanceM / 1000) * rule.per_km_cents + (durationS / 60) * rule.per_minute_cents;
  const withNight = isNight(pickupAt, rule, timeZone) ? raw * (1 + rule.night_surcharge_percent / 100) : raw;
  return Math.max(rule.minimum_fare_cents, Math.round(withNight / 100) * 100);
}
