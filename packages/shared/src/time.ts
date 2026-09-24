// Conversions de fuseau horaire sans dépendance (Intl).

function offsetMs(ts: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(ts));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - ts;
}

/** « 2026-09-25 » + « 06:30 » dans Europe/Paris → instant UTC. */
export function zonedTimeToUtc(date: string, time: string, timeZone = "Europe/Paris"): Date {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const guess = Date.UTC(y!, m! - 1, d!, hh!, mm!);
  const first = offsetMs(guess, timeZone);
  let ts = guess - first;
  const second = offsetMs(ts, timeZone);
  if (second !== first) ts = guess - second;
  return new Date(ts);
}
