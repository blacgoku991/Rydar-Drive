import { zonedTimeToUtc } from "@rydar/shared";

/** Jour civil « AAAA-MM-JJ » d'un instant dans un fuseau. */
export function zonedDay(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

/**
 * Début d'une période de statistiques : minuit, dans le fuseau de la centrale (comme org_stats, qui regroupe les jours
 * dans organizations.timezone), et non dans celui du serveur (UTC en production).
 * - `days` = N : les N derniers jours, aujourd'hui compris ;
 * - `"mtd"` : depuis le 1er du mois en cours.
 */
export function statsPeriodStart(now: Date, days: number | "mtd", timeZone: string): Date {
  const today = zonedDay(now, timeZone);
  let day: string;
  if (days === "mtd") {
    day = `${today.slice(0, 7)}-01`;
  } else {
    const [y, m, d] = today.split("-").map(Number);
    day = new Date(Date.UTC(y!, m! - 1, d! - (Math.max(1, days) - 1))).toISOString().slice(0, 10);
  }
  return zonedTimeToUtc(day, "00:00", timeZone);
}
