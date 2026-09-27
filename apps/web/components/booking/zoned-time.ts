import { zonedTimeToUtc } from "@rydar/shared";

// Date et heure saisies dans un formulaire (mini-site, « Nouvelle course ») : lues dans le fuseau de la
// centrale, jamais dans celui du navigateur (voyageur à l'étranger, dispatcher en déplacement).

/** « 2026-10-01 » + « 08:00 » dans le fuseau de la centrale → instant ; null si la saisie est incomplète. */
export function zonedInstant(date: string, time: string, timeZone: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}(:\d{2})?$/.test(time)) return null;
  try {
    const at = zonedTimeToUtc(date, time, timeZone);
    return Number.isNaN(at.getTime()) ? null : at;
  } catch {
    return null;
  }
}

/** Jour (AAAA-MM-JJ) d'un instant dans le fuseau de la centrale. */
export function dayInZone(at: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}

/** Nom du fuseau de la centrale (« heure normale d'Europe centrale ») si le navigateur est dans un autre, sinon null. */
export function foreignZoneName(timeZone: string, browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone): string | null {
  try {
    if (browserZone === timeZone) return null;
    return new Intl.DateTimeFormat("fr-FR", { timeZone, timeZoneName: "long" }).formatToParts(new Date()).find((p) => p.type === "timeZoneName")?.value ?? timeZone;
  } catch {
    return null;
  }
}
