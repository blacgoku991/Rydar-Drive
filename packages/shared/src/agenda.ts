// Agenda des courses (Liste, Jour, Semaine, Mois) : logique pure commune au web (page Agenda du tableau de bord) et à
// l'application (route /planning, RPC driver_agenda). Jours civils « AAAA-MM-JJ » calculés à midi UTC (jamais d'effet
// d'heure d'été) ; heures locales lues dans le fuseau de l'organisation par les formateurs mémorisés de format.ts. Ni
// formatToParts ni zonedTimeToUtc (Hermes), jamais de « new Intl » au rendu.
import { dateTimeFormat, localIsoDay } from "./format";
import type { RideStatus, RideType, Tone } from "./domain";
import { PRIVATE_FLEET_BOOKING_STATE_META, type PrivateFleetBookingState } from "./private-fleet";

export const AGENDA_VIEWS = ["list", "day", "week", "month"] as const;
export type AgendaView = (typeof AGENDA_VIEWS)[number];

export const AGENDA_VIEW_LABELS: Record<AgendaView, string> = { list: "Liste", day: "Jour", week: "Semaine", month: "Mois" };

/** Paramètre d'URL de la page Agenda du web (?vue=mois|semaine|jour|liste). */
export const AGENDA_VIEW_PARAMS: Record<AgendaView, string> = { list: "liste", day: "jour", week: "semaine", month: "mois" };

export function agendaViewFromParam(param: string | null | undefined, fallback: AgendaView): AgendaView {
  const found = AGENDA_VIEWS.find((v) => AGENDA_VIEW_PARAMS[v] === param);
  return found ?? fallback;
}

/** Vue « Liste » : courses de ce nombre de jours à partir du jour choisi. */
export const AGENDA_LIST_DAYS = 30;
/** Marge de la fenêtre de lecture, de chaque côté : couvre tout fuseau (± 14 h) autour des jours affichés. */
export const AGENDA_FETCH_MARGIN_DAYS = 1;
/** Hauteur minimale d'une course dans la frise d'une journée (et durée retenue sans estimation). */
export const AGENDA_MIN_BLOCK_MINUTES = 30;

const DAY_MS = 86_400_000;
const MINUTES_PER_DAY = 1440;
const noon = (day: string) => Date.parse(`${day}T12:00:00Z`);
const fromDay = (day: string) => new Date(noon(day));
const isoOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Jour civil décalé de n jours. */
export function addDays(day: string, n: number): string {
  return isoOf(noon(day) + n * DAY_MS);
}

/** Jour de la semaine ISO : 1 = lundi … 7 = dimanche. */
export function isoWeekday(day: string): number {
  const d = fromDay(day).getUTCDay();
  return d === 0 ? 7 : d;
}

/** Lundi de la semaine du jour. */
export function weekStart(day: string): string {
  return addDays(day, 1 - isoWeekday(day));
}

/** Grille du mois du jour : 42 jours (6 semaines), à partir du lundi qui précède (ou qui est) le 1er du mois. */
export function monthGrid(day: string): string[] {
  const start = weekStart(`${day.slice(0, 7)}-01`);
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}

/** Jours affichés par une vue : [from, to[ (jours civils). */
export function viewRange(view: AgendaView, day: string): { from: string; to: string } {
  switch (view) {
    case "day":
      return { from: day, to: addDays(day, 1) };
    case "week": {
      const from = weekStart(day);
      return { from, to: addDays(from, 7) };
    }
    case "month": {
      const grid = monthGrid(day);
      return { from: grid[0]!, to: addDays(grid[41]!, 1) };
    }
    case "list":
      return { from: day, to: addDays(day, AGENDA_LIST_DAYS) };
  }
}

/**
 * Fenêtre de lecture (instants ISO, driver_agenda ou requête du web) : jours de la vue ± 1 jour, en UTC — les
 * courses sont ensuite regroupées par jour dans le fuseau de l'organisation (groupByDay). 44 jours au plus (mois),
 * sous la borne SQL de 62 jours (PRIVATE_FLEET_AGENDA_MAX_DAYS).
 */
export function fetchWindow(view: AgendaView, day: string): { from: string; to: string } {
  const range = viewRange(view, day);
  return {
    from: `${addDays(range.from, -AGENDA_FETCH_MARGIN_DAYS)}T00:00:00.000Z`,
    to: `${addDays(range.to, AGENDA_FETCH_MARGIN_DAYS)}T00:00:00.000Z`,
  };
}

const byPickup = <T extends { pickup_at: string; id?: string }>(a: T, b: T) =>
  Date.parse(a.pickup_at) - Date.parse(b.pickup_at) || (a.id ?? "").localeCompare(b.id ?? "");

/** Courses regroupées par jour local (fuseau de l'organisation), triées par heure de prise en charge. */
export function groupByDay<T extends { pickup_at: string; id?: string }>(items: readonly T[], timeZone: string): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const item of [...items].sort(byPickup)) {
    const key = localIsoDay(item.pickup_at, timeZone);
    (out[key] ??= []).push(item);
  }
  return out;
}

/** Heure murale locale en minutes depuis minuit (0 à 1439). */
export function minutesOfDay(at: string, timeZone: string): number {
  const text = dateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone }).format(new Date(at));
  const m = /(\d{1,2})\D+(\d{1,2})/.exec(text);
  if (!m) return 0;
  return (Number(m[1]) % 24) * 60 + Number(m[2]);
}

type Timed = { pickup_at: string; estimated_duration_s?: number | null };

/** Occupation d'une course : [prise en charge, prise en charge + durée estimée (30 min au moins)[, en millisecondes. */
export function rideInterval(item: Timed): { start: number; end: number } {
  const start = Date.parse(item.pickup_at);
  const seconds = Math.max(AGENDA_MIN_BLOCK_MINUTES * 60, item.estimated_duration_s ?? 0);
  return { start, end: start + seconds * 1000 };
}

/** Deux courses se chevauchent (durée estimée, 30 min au moins). */
export function overlaps(a: Timed, b: Timed): boolean {
  const x = rideInterval(a);
  const y = rideInterval(b);
  return x.start < y.end && y.start < x.end;
}

/** Bloc de la frise d'une journée (minutes locales) ; columns > 1 : chevauchements affichés côte à côte. */
export interface AgendaDayBlock<T> {
  item: T;
  start: number;
  end: number;
  column: number;
  columns: number;
  overlap: boolean;
}

/**
 * Frise d'une journée : chaque course placée à l'heure locale de prise en charge, hauteur selon la durée estimée
 * (30 min au moins, jamais au-delà de minuit) ; les courses qui se chevauchent forment un groupe dont chacune occupe
 * une colonne (première colonne libre).
 */
export function dayLayout<T extends Timed & { id?: string }>(items: readonly T[], timeZone: string): AgendaDayBlock<T>[] {
  const blocks: AgendaDayBlock<T>[] = items
    .map((item) => {
      const start = minutesOfDay(item.pickup_at, timeZone);
      const duration = Math.max(AGENDA_MIN_BLOCK_MINUTES, Math.round((item.estimated_duration_s ?? 0) / 60));
      return { item, start, end: Math.min(MINUTES_PER_DAY, start + duration), column: 0, columns: 1, overlap: false };
    })
    .sort((a, b) => a.start - b.start || b.end - a.end || (a.item.id ?? "").localeCompare(b.item.id ?? ""));

  let group: AgendaDayBlock<T>[] = [];
  let groupEnd = -1;
  let columnEnds: number[] = [];
  const closeGroup = () => {
    for (const b of group) {
      b.columns = columnEnds.length;
      b.overlap = group.length > 1;
    }
    group = [];
    columnEnds = [];
    groupEnd = -1;
  };
  for (const block of blocks) {
    if (group.length > 0 && block.start >= groupEnd) closeGroup();
    let column = columnEnds.findIndex((end) => end <= block.start);
    if (column === -1) {
      column = columnEnds.length;
      columnEnds.push(block.end);
    } else {
      columnEnds[column] = block.end;
    }
    block.column = column;
    group.push(block);
    groupEnd = Math.max(groupEnd, block.end);
  }
  closeGroup();
  return blocks;
}

export const AGENDA_KINDS = [
  "to_confirm", "to_check", "overdue", "not_confirmed", "declined", "confirmed", "ongoing", "completed", "cancelled",
] as const;
export type AgendaKind = (typeof AGENDA_KINDS)[number];

/** Couleur = information : ambre à traiter ou en retard, rouge non confirmée, violet confirmée, cyan en cours… */
export const AGENDA_KIND_META: Record<AgendaKind, { label: string; tone: Tone }> = {
  ...PRIVATE_FLEET_BOOKING_STATE_META,
  overdue: { label: "Heure dépassée", tone: "amber" },
  confirmed: { label: "Confirmée", tone: "violet" },
  ongoing: { label: "En cours", tone: "cyan" },
  completed: { label: "Terminée", tone: "green" },
  cancelled: { label: "Annulée", tone: "neutral" },
};

/** Course ou réservation de l'agenda ; state : état d'une réservation sans chauffeur (driver_agenda.unassigned). */
export interface AgendaItem {
  status: RideStatus;
  type?: RideType | null;
  pickup_at: string;
  state?: PrivateFleetBookingState | null;
}

const UNASSIGNED: readonly RideStatus[] = ["CREATED", "SEARCHING_DRIVER", "OFFERED", "NO_DRIVER_FOUND"];

/** Catégorie d'affichage d'une course (planifiée acceptée et prise en charge passée : heure dépassée). */
export function agendaKind(item: AgendaItem, now = Date.now()): AgendaKind {
  if (item.state && UNASSIGNED.includes(item.status)) return item.state;
  switch (item.status) {
    case "CREATED":
    case "SEARCHING_DRIVER":
    case "OFFERED":
      return "to_confirm";
    case "NO_DRIVER_FOUND":
      return "not_confirmed";
    case "ACCEPTED":
      return item.type === "scheduled" && Date.parse(item.pickup_at) <= now ? "overdue" : "confirmed";
    case "DRIVER_EN_ROUTE":
    case "DRIVER_ARRIVED":
    case "PASSENGER_ONBOARD":
    case "IN_PROGRESS":
      return "ongoing";
    case "COMPLETED":
      return "completed";
    case "CANCELLED":
      return "cancelled";
  }
}

/** Résumé d'un jour (annulées et refusées exclues) : « 3 courses · 245 € », « dont 1 à confirmer ». */
export interface AgendaDaySummary {
  count: number;
  totalCents: number;
  toConfirm: number;
  /** À vérifier ou non confirmées */
  unconfirmed: number;
}

export function daySummary(items: readonly (AgendaItem & { price_cents?: number | null })[], now = Date.now()): AgendaDaySummary {
  const summary: AgendaDaySummary = { count: 0, totalCents: 0, toConfirm: 0, unconfirmed: 0 };
  for (const item of items) {
    const kind = agendaKind(item, now);
    if (kind === "cancelled" || kind === "declined") continue;
    summary.count += 1;
    summary.totalCents += item.price_cents ?? 0;
    if (kind === "to_confirm") summary.toConfirm += 1;
    if (kind === "to_check" || kind === "not_confirmed") summary.unconfirmed += 1;
  }
  return summary;
}

/** « mardi 14 octobre » */
export function dayTitle(day: string): string {
  return dateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(fromDay(day));
}

/** En-tête d'un jour de la liste : « Aujourd'hui », « Demain », sinon « jeudi 16 octobre ». */
export function dayHeading(day: string, today: string): string {
  if (day === today) return "Aujourd'hui";
  if (day === addDays(today, 1)) return "Demain";
  return dayTitle(day);
}

/** « 12 – 18 oct. » ; « 28 sept. – 4 oct. » ; « 28 déc. 2026 – 3 janv. 2027 » */
export function weekTitle(day: string): string {
  const start = weekStart(day);
  const end = addDays(start, 6);
  const short = (d: string) => dateTimeFormat("fr-FR", { day: "numeric", month: "short", timeZone: "UTC" }).format(fromDay(d));
  if (start.slice(0, 4) !== end.slice(0, 4)) {
    const long = (d: string) =>
      dateTimeFormat("fr-FR", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(fromDay(d));
    return `${long(start)} – ${long(end)}`;
  }
  if (start.slice(0, 7) !== end.slice(0, 7)) return `${short(start)} – ${short(end)}`;
  return `${Number(start.slice(8))} – ${short(end)}`;
}

/** « octobre 2026 » */
export function monthTitle(day: string): string {
  return dateTimeFormat("fr-FR", { month: "long", year: "numeric", timeZone: "UTC" }).format(fromDay(day));
}
