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

// ---------------------------------------------------------------------------
// Forfaits (« Paris ↔ CDG ») : reconnus automatiquement à partir des adresses.
// ---------------------------------------------------------------------------
const PLACE_ALIASES: Record<string, RegExp> = {
  cdg: /charles[\s-]*de[\s-]*gaulle|\bcdg\b|roissy/i,
  "roissy-cdg": /charles[\s-]*de[\s-]*gaulle|\bcdg\b|roissy/i,
  orly: /\borly\b/i,
  disneyland: /disney|marne[\s-]*la[\s-]*vall|chessy/i,
  disney: /disney|marne[\s-]*la[\s-]*vall|chessy/i,
  "le bourget": /bourget/i,
  beauvais: /beauvais|till[ée]/i,
  paris: /\bparis\b|\b75\d{3}\b/i,
  nice: /\bnice\b|\b06[0-9]00\b/i,
  "aéroport de nice": /a[ée]roport.*nice|nice.*a[ée]roport|c[ôo]te d'azur/i,
  monaco: /monaco|\b98000\b/i,
};

const AIRPORT = /a[ée]roport|terminal|\bcdg\b|charles[\s-]*de[\s-]*gaulle|\borly\b|roissy|bourget|beauvais/i;
const CITIES = new Set(["paris", "nice", "monaco"]);

function matchesPlace(token: string, address: string): boolean {
  const key = token.trim().toLowerCase();
  const re = PLACE_ALIASES[key];
  const hit = re ? re.test(address) : address.toLowerCase().includes(key);
  // « Paris » désigne la ville, pas un aéroport « Paris-Orly » / « Paris-CDG »
  return CITIES.has(key) ? hit && !AIRPORT.test(address) : hit;
}

/** Forfait applicable au trajet (dans un sens ou dans l'autre), sinon null. */
export function matchFixedFare(
  rule: Pick<PricingRule, "fixed_fares">,
  pickupAddress: string,
  dropoffAddress: string,
): { label: string; price_cents: number } | null {
  for (const fare of rule.fixed_fares ?? []) {
    const parts = fare.label.split(/\s*(?:↔|<->|->|→|-|—|\/)\s*/).filter(Boolean);
    if (parts.length !== 2) continue;
    const [a, b] = parts as [string, string];
    const direct = matchesPlace(a, pickupAddress) && matchesPlace(b, dropoffAddress);
    const reverse = matchesPlace(b, pickupAddress) && matchesPlace(a, dropoffAddress);
    if (direct || reverse) return fare;
  }
  return null;
}
