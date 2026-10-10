// Agenda du tableau de bord (/dashboard/agenda, docs/FLOTTE-PRIVEE.md § 7.3) : modèle de vue pur (Mois, Semaine, Jour,
// Liste), testé (agenda-model.test.ts). Logique commune avec l'application dans @rydar/shared (agenda.ts) : jours civils
// dans le fuseau de l'ORGANISATION, frise placée à l'heure murale (passage à l'heure d'hiver compris : la journée de
// 25 h garde ses deux « 02:30 » côte à côte). Couleur = information (AGENDA_KIND_META). Aucun « new Intl » ici.
import {
  AGENDA_KIND_META, AGENDA_LIST_DAYS, AGENDA_VIEW_PARAMS, addDays, agendaKind, agendaViewFromParam, daySummary, dayHeading, dayLayout,
  dayTitle, formatPrice, formatTime, groupByDay, monthGrid, monthTitle, shortAddress, viewRange, weekStart, weekTitle,
  type AgendaDaySummary, type AgendaKind, type AgendaView, type PrivateFleetBookingState, type RideStatus, type RideType, type Tone,
} from "@rydar/shared";

const NB = "\u00a0";

/** Course lue pour l'agenda (organisation, fenêtre fetchWindow). */
export type AgendaRide = {
  id: string;
  number: number;
  type: RideType;
  status: RideStatus;
  pickup_at: string;
  pickup_address: string;
  dropoff_address: string;
  customer_name: string | null;
  price_cents: number | null;
  currency?: string | null;
  estimated_duration_s: number | null;
  /** État d'une réservation sans chauffeur (Flotte Privée) ; absent : déduit du statut */
  state?: PrivateFleetBookingState | null;
};

export type AgendaEntry = AgendaRide & { kind: AgendaKind; label: string; tone: Tone; time: string; route: string };

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** « AAAA-MM-JJ » existant (2026-02-30 refusé), sinon null. */
export function validDay(value: string | null | undefined): string | null {
  if (!value || !DAY_RE.test(value)) return null;
  const at = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(at.getTime()) && at.toISOString().slice(0, 10) === value ? value : null;
}

/** Paramètres d'URL : ?vue=mois|semaine|jour|liste (défaut `fallback`) &date=AAAA-MM-JJ (défaut : aujourd'hui). */
export function agendaParams(sp: { vue?: string; date?: string }, today: string, fallback: AgendaView = "month"): { view: AgendaView; day: string } {
  return { view: agendaViewFromParam(sp.vue, fallback), day: validDay(sp.date) ?? today };
}

export function agendaHref(view: AgendaView, day: string): string {
  return `/dashboard/agenda?vue=${AGENDA_VIEW_PARAMS[view]}&date=${day}`;
}

/** Période précédente (-1) ou suivante (+1) : jour, semaine, mois (le 1er), ou 30 jours (liste). */
export function shiftPeriod(view: AgendaView, day: string, dir: -1 | 1): string {
  switch (view) {
    case "day":
      return addDays(day, dir);
    case "week":
      return addDays(weekStart(day), 7 * dir);
    case "list":
      return addDays(day, AGENDA_LIST_DAYS * dir);
    case "month": {
      const y = Number(day.slice(0, 4));
      const m = Number(day.slice(5, 7)) - 1 + dir;
      const year = y + Math.floor(m / 12);
      const month = ((m % 12) + 12) % 12;
      return `${String(year).padStart(4, "0")}-${String(month + 1).padStart(2, "0")}-01`;
    }
  }
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Titre de la période : « Mardi 14 octobre », « 12 – 18 oct. », « Octobre 2026 », « Du mardi 14 octobre au … ». */
export function periodLabel(view: AgendaView, day: string): string {
  switch (view) {
    case "day":
      return capitalize(dayTitle(day));
    case "week":
      return weekTitle(day);
    case "month":
      return capitalize(monthTitle(day));
    case "list": {
      const range = viewRange("list", day);
      return `Du ${dayTitle(range.from)} au ${dayTitle(addDays(range.to, -1))}`;
    }
  }
}

/** Courses → éléments affichables (catégorie, couleur, heure locale, trajet abrégé). */
export function toEntries(rides: readonly AgendaRide[], timeZone: string, now = Date.now()): AgendaEntry[] {
  return rides.map((r) => {
    const kind = agendaKind(r, now);
    const meta = AGENDA_KIND_META[kind];
    return {
      ...r,
      kind,
      label: meta.label,
      tone: meta.tone,
      time: formatTime(r.pickup_at, timeZone),
      route: `${shortAddress(r.pickup_address)} → ${shortAddress(r.dropoff_address)}`,
    };
  });
}

/** Éléments regroupés par jour local de l'organisation, triés par heure. */
export function entriesByDay(entries: readonly AgendaEntry[], timeZone: string): Record<string, AgendaEntry[]> {
  return groupByDay(entries, timeZone);
}

const count = (n: number, one: string, many: string) => `${n}${NB}${n > 1 ? many : one}`;

/** « 3 courses · 245 € » (annulées et refusées exclues) ; null pour un jour vide. */
export function summaryLabel(s: AgendaDaySummary, currency = "EUR"): string | null {
  if (!s.count) return null;
  return [count(s.count, "course", "courses"), s.totalCents ? formatPrice(s.totalCents, currency) : null].filter(Boolean).join(" · ");
}

/** Texte du lecteur d'écran d'un jour : « mardi 14 octobre, 3 courses dont 1 à confirmer ». */
export function dayAriaLabel(day: string, s: AgendaDaySummary): string {
  const parts = [s.count ? count(s.count, "course", "courses") : "aucune course"];
  const extra = [
    s.toConfirm ? `${s.toConfirm} à confirmer` : null,
    s.unconfirmed ? `${s.unconfirmed} non confirmée${s.unconfirmed > 1 ? "s" : ""} ou à vérifier` : null,
  ].filter(Boolean);
  return `${dayTitle(day)}, ${parts[0]}${extra.length ? ` dont ${extra.join(" et ")}` : ""}`;
}

/**
 * Nom accessible d'une course dans une case du mois ou une colonne de la semaine : le texte visible (« 08:30 Orly →
 * Paris 8e ») d'abord, puis le jour et l'état — rien d'autre ne situe le lien (ni cellule de tableau, ni titre avant lui).
 */
export function entryAriaLabel(entry: Pick<AgendaEntry, "time" | "route" | "label">, title: string): string {
  return `${entry.time} ${entry.route}, ${title}, ${entry.label}`;
}

/** Courses affichées par case du mois avant « +N ». */
export const MONTH_CELL_ITEMS = 3;

export type MonthCell = {
  day: string;
  dayNumber: number;
  inMonth: boolean;
  today: boolean;
  /** « mercredi 14 octobre » : situe les liens de la case pour le lecteur d'écran */
  title: string;
  /** Courses affichées (3 au plus) et nombre d'autres */
  entries: AgendaEntry[];
  more: number;
  /** Nom accessible du lien « +N » vers la vue Jour (« +2 autres courses, mercredi 14 octobre ») ; null sans « +N » */
  moreLabel: string | null;
  summary: AgendaDaySummary;
  ariaLabel: string;
};

/** Grille de 6 semaines (42 jours, lundi en premier) du mois du jour. */
export function monthCells(day: string, byDay: Record<string, AgendaEntry[]>, today: string, now = Date.now()): MonthCell[] {
  const month = day.slice(0, 7);
  return monthGrid(day).map((d) => {
    const all = byDay[d] ?? [];
    const summary = daySummary(all, now);
    const title = dayTitle(d);
    const more = Math.max(0, all.length - MONTH_CELL_ITEMS);
    return {
      day: d,
      dayNumber: Number(d.slice(8)),
      inMonth: d.slice(0, 7) === month,
      today: d === today,
      title,
      entries: all.slice(0, MONTH_CELL_ITEMS),
      more,
      // Commence par le texte visible « +N » (étiquette dans le nom), puis ce qu'il désigne
      moreLabel: more > 0 ? `+${count(more, "autre course", "autres courses")}, ${title}` : null,
      summary,
      ariaLabel: dayAriaLabel(d, summary),
    };
  });
}

/** En-têtes de la grille du mois (lundi en premier) : abréviation affichée et nom complet (lecteur d'écran). */
export const WEEKDAY_HEADERS: readonly { short: string; long: string }[] = [
  { short: "L", long: "lundi" },
  { short: "M", long: "mardi" },
  { short: "M", long: "mercredi" },
  { short: "J", long: "jeudi" },
  { short: "V", long: "vendredi" },
  { short: "S", long: "samedi" },
  { short: "D", long: "dimanche" },
];

export type WeekColumn = {
  day: string;
  /** « mercredi 14 octobre » (liens de la colonne, lecteur d'écran) ; `heading` : même date, capitale initiale */
  title: string;
  heading: string;
  today: boolean;
  entries: AgendaEntry[];
  summary: AgendaDaySummary;
  ariaLabel: string;
};

/** Semaine du jour (lundi → dimanche). */
export function weekColumns(day: string, byDay: Record<string, AgendaEntry[]>, today: string, now = Date.now()): WeekColumn[] {
  const start = weekStart(day);
  return Array.from({ length: 7 }, (_, i) => {
    const d = addDays(start, i);
    const entries = byDay[d] ?? [];
    const summary = daySummary(entries, now);
    const title = dayTitle(d);
    return { day: d, title, heading: capitalize(title), today: d === today, entries, summary, ariaLabel: dayAriaLabel(d, summary) };
  });
}

/** Hauteur d'une heure dans la frise d'une journée (px) et hauteur minimale d'un bloc. */
export const TIMELINE_HOUR_PX = 56;
const MIN_BLOCK_PX = 28;
/** La frise commence à 6 h, plus tôt si une course commence avant. */
export const TIMELINE_START_HOUR = 6;

export type TimelineBlock = { entry: AgendaEntry; top: number; height: number; column: number; columns: number; overlap: boolean };

export type DayTimeline = { startHour: number; hours: number[]; height: number; blocks: TimelineBlock[] };

/**
 * Frise d'une journée (de 6 h, ou de la première course si elle est plus tôt, à 24 h) : blocs placés à l'heure murale
 * de prise en charge, hauteur selon la durée estimée (30 min au moins), chevauchements côte à côte (dayLayout).
 */
export function dayTimeline(entries: readonly AgendaEntry[], timeZone: string): DayTimeline {
  const layout = dayLayout(entries, timeZone);
  const earliest = layout.reduce((m, b) => Math.min(m, b.start), TIMELINE_START_HOUR * 60);
  const startHour = Math.min(TIMELINE_START_HOUR, Math.floor(earliest / 60));
  const hours = Array.from({ length: 24 - startHour }, (_, i) => startHour + i);
  const px = (minutes: number) => (minutes / 60) * TIMELINE_HOUR_PX;
  return {
    startHour,
    hours,
    height: hours.length * TIMELINE_HOUR_PX,
    blocks: layout.map((b) => ({
      entry: b.item,
      top: px(b.start - startHour * 60),
      height: Math.max(MIN_BLOCK_PX, px(b.end - b.start)),
      column: b.column,
      columns: b.columns,
      overlap: b.overlap,
    })),
  };
}

export type ListDay = { day: string; heading: string; entries: AgendaEntry[]; summary: AgendaDaySummary };

/** Liste : jours de la période (30 jours) qui ont au moins une course, « Aujourd'hui », « Demain », puis la date. */
export function listDays(day: string, byDay: Record<string, AgendaEntry[]>, today: string, now = Date.now()): ListDay[] {
  const range = viewRange("list", day);
  const out: ListDay[] = [];
  for (let d = range.from; d < range.to; d = addDays(d, 1)) {
    const entries = byDay[d];
    if (!entries?.length) continue;
    out.push({ day: d, heading: capitalize(dayHeading(d, today)), entries, summary: daySummary(entries, now) });
  }
  return out;
}
