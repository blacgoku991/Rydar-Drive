// Formatage FR (prix, distances, durées, dates, téléphones).

const nbsp = " ";

export function formatPrice(cents: number | null | undefined, currency = "EUR", opts: { empty?: string } = {}): string {
  if (cents === null || cents === undefined || Number.isNaN(cents)) return opts.empty ?? "—";
  const value = cents / 100;
  const formatted = new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency,
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(value);
  return formatted.replace(/ /g, nbsp);
}

export function formatCompactPrice(cents: number | null | undefined, currency = "EUR"): string {
  if (cents === null || cents === undefined) return "—";
  if (Math.abs(cents) < 1_000_000) return formatPrice(Math.round(cents / 100) * 100, currency);
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency, notation: "compact", maximumFractionDigits: 1 })
    .format(cents / 100)
    .replace(/ /g, nbsp);
}

export function formatDistance(meters: number | null | undefined): string {
  if (meters === null || meters === undefined || Number.isNaN(meters)) return "—";
  if (meters < 1000) return `${Math.round(meters)}${nbsp}m`;
  const km = meters / 1000;
  const digits = km < 10 && Math.round(meters) % 1000 !== 0 ? 1 : 0;
  return `${km.toLocaleString("fr-FR", { minimumFractionDigits: digits, maximumFractionDigits: digits })}${nbsp}km`;
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || Number.isNaN(seconds)) return "—";
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))}${nbsp}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}${nbsp}min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h}${nbsp}h${nbsp}${String(m).padStart(2, "0")}` : `${h}${nbsp}h`;
}

export function formatNumber(n: number | null | undefined, digits = 0): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return n.toLocaleString("fr-FR", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function formatPercent(ratio: number | null | undefined, digits = 0): string {
  if (ratio === null || ratio === undefined || Number.isNaN(ratio)) return "—";
  return `${(ratio * 100).toLocaleString("fr-FR", { minimumFractionDigits: digits, maximumFractionDigits: digits })}${nbsp}%`;
}

const TZ = "Europe/Paris";

export function formatTime(date: Date | string | null | undefined, timeZone = TZ, withSeconds = false): string {
  if (!date) return "—";
  return new Intl.DateTimeFormat("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
    second: withSeconds ? "2-digit" : undefined,
    timeZone,
  }).format(new Date(date));
}

export function formatDate(date: Date | string | null | undefined, timeZone = TZ): string {
  if (!date) return "—";
  return new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", timeZone }).format(new Date(date));
}

function dayKey(d: Date, timeZone: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/** « Aujourd'hui 14:32 », « Demain 06:30 », « Hier 22:10 », « jeu. 25/09 06:30 ». */
export function formatRideDate(date: Date | string | null | undefined, timeZone = TZ, now = new Date()): string {
  if (!date) return "—";
  const d = new Date(date);
  const time = formatTime(d, timeZone);
  const key = dayKey(d, timeZone);
  const day = 86_400_000;
  if (key === dayKey(now, timeZone)) return `Aujourd'hui ${time}`;
  if (key === dayKey(new Date(now.getTime() + day), timeZone)) return `Demain ${time}`;
  if (key === dayKey(new Date(now.getTime() - day), timeZone)) return `Hier ${time}`;
  const label = new Intl.DateTimeFormat("fr-FR", { weekday: "short", day: "2-digit", month: "2-digit", timeZone }).format(d);
  return `${label} ${time}`;
}

/** « il y a 12 s », « il y a 3 min », « dans 2 h ». */
export function formatRelative(date: Date | string | null | undefined, now = new Date()): string {
  if (!date) return "—";
  const diff = new Date(date).getTime() - now.getTime();
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat("fr", { numeric: "auto", style: "short" });
  if (abs < 60_000) return rtf.format(Math.round(diff / 1000), "second");
  if (abs < 3_600_000) return rtf.format(Math.round(diff / 60_000), "minute");
  if (abs < 86_400_000) return rtf.format(Math.round(diff / 3_600_000), "hour");
  return rtf.format(Math.round(diff / 86_400_000), "day");
}

/** Normalise un numéro FR/international en E.164 (+33612345678). Retourne null si invalide. */
export function normalizePhone(input: string | null | undefined, defaultCountry = "33"): string | null {
  if (!input) return null;
  let v = input.replace(/[^\d+]/g, "");
  if (v.startsWith("00")) v = `+${v.slice(2)}`;
  if (!v.startsWith("+")) {
    if (v.startsWith("0") && v.length === 10) v = `+${defaultCountry}${v.slice(1)}`;
    else if (v.length >= 9) v = `+${v}`;
  }
  return /^\+[1-9]\d{7,14}$/.test(v) ? v : null;
}

/** +33612345678 → « +33 6 12 34 56 78 ». */
export function formatPhone(e164: string | null | undefined): string {
  if (!e164) return "—";
  const m = /^\+33(\d)(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(e164.replace(/\s/g, ""));
  if (m) return `+33 ${m[1]} ${m[2]} ${m[3]} ${m[4]} ${m[5]}`;
  return e164;
}

export function initials(first?: string | null, last?: string | null): string {
  return `${(first ?? "").trim().charAt(0)}${(last ?? "").trim().charAt(0)}`.toUpperCase() || "?";
}

/** « 12 Avenue des Champs-Élysées, 75008 Paris » → « 12 Avenue des Champs-Élysées ». */
export function shortAddress(address: string | null | undefined): string {
  if (!address) return "—";
  return address.split(",")[0]?.trim() || address;
}

export function slugify(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}
