// Agenda du chauffeur (route /planning : Liste, Jour, Semaine, Mois ; docs/FLOTTE-PRIVEE.md § 10.5) : modèle de vue pur
// — vues, périodes, cases du mois, lignes de la semaine, frise du jour, réservations « À traiter », couleurs (tons),
// libellés (typographie française) et textes du lecteur d'écran. Comme network.ts, aucune dépendance native ni alias
// « @/ » (agenda-view.test.ts sous Node) : @rydar/shared et chemins relatifs seulement. Jours civils et heures locales
// par la logique commune de @rydar/shared (agenda.ts) : ni formatToParts, ni zonedTimeToUtc (Hermes), formateurs
// mémorisés (dateTimeFormat), jamais « new Intl » au rendu.
import {
  AGENDA_KIND_META, AGENDA_VIEWS, AGENDA_VIEW_LABELS, PRIVATE_FLEET_BOOKING_STATE_META, VEHICLE_CATEGORY_META,
  addDays, agendaKind, dateTimeFormat, dayHeading, dayLayout, daySummary, dayTitle, formatPrice, formatRideDate, formatTime,
  groupByDay, isCategoryCompatible, localIsoDay, minutesOfDay, monthGrid, monthTitle, overlaps, privateFleetTakeable,
  shortAddress, weekStart, weekTitle,
  type AgendaBooking, type AgendaKind, type AgendaView, type DriverOfferV2, type PrivateFleetBookingState, type RideStatus,
  type RideType, type Tone, type VehicleCategory,
} from "@rydar/shared";
import { frTypo, NBSP } from "./settlement-text";

// =============================================================================
// Éléments de l'agenda
// =============================================================================

/**
 * Élément de l'agenda : course du chauffeur (driver_agenda.rides, driver_rides_upcoming) ou réservation de son
 * organisation encore sans chauffeur (driver_agenda.unassigned : `state`, `offer_id`).
 */
export type AgendaEntry = {
  id: string;
  number: number;
  type: RideType;
  status: RideStatus;
  pickup_at: string;
  pickup_address: string;
  dropoff_address: string;
  estimated_duration_s?: number | null;
  price_cents: number | null;
  currency?: string | null;
  state?: PrivateFleetBookingState | null;
  offer_id?: string | null;
};

/** Courses en cours ou à venir du chauffeur (confirmées) : chevauchements d'une réservation à confirmer. */
const ACTIVE: readonly RideStatus[] = ["ACCEPTED", "DRIVER_EN_ROUTE", "DRIVER_ARRIVED", "PASSENGER_ONBOARD", "IN_PROGRESS"];

/** « 3 passagers », « 1 bagage » (espace insécable). */
export const plural = (n: number, one: string, many: string) => `${n}${NBSP}${n > 1 ? many : one}`;

const capitalize = (s: string) => (s ? `${s.charAt(0).toUpperCase()}${s.slice(1)}` : s);

/** « Orly → Paris 8e » */
export const routeText = (from: string | null | undefined, to: string | null | undefined) => `${shortAddress(from)} → ${shortAddress(to)}`;

/** Catégorie d'affichage (couleur = information) : AGENDA_KIND_META de @rydar/shared. */
export function entryKind(e: Pick<AgendaEntry, "status" | "type" | "pickup_at" | "state">, now = Date.now()): AgendaKind {
  return agendaKind(e, now);
}

/** Annulée ou refusée : affichée en retrait (muted), jamais comptée dans les résumés. */
export const isClosedKind = (k: AgendaKind) => k === "cancelled" || k === "declined";

/** Courses de la période et réservations à traiter, sans doublon (une réservation prise devient une course). */
export function calendarEntries<T extends AgendaEntry>(rides: readonly T[], unassigned: readonly T[] | null | undefined): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const e of [...rides, ...(unassigned ?? [])]) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
  }
  return out;
}

/** Où mène un élément touché : sa course, l'offre en attente, ou la carte du bloc « À traiter » (sans offre). */
export type EntryTarget = { kind: "ride" | "offer" | "todo"; id: string };

export function entryTarget(e: Pick<AgendaEntry, "id" | "state" | "offer_id">): EntryTarget {
  if (!e.state) return { kind: "ride", id: e.id };
  return e.offer_id ? { kind: "offer", id: e.offer_id } : { kind: "todo", id: e.id };
}

// =============================================================================
// Vues et périodes
// =============================================================================

/** Liste pour un chauffeur standard (Planning inchangé, compte de démonstration App Review compris), Mois en Flotte Privée. */
export function defaultAgendaView(privateFleet: boolean): AgendaView {
  return privateFleet ? "month" : "list";
}

/** Titre de l'écran. */
export const agendaTitle = (privateFleet: boolean) => (privateFleet ? "Agenda" : "Planning");

/** Sélecteur Liste · Jour · Semaine · Mois (libellés complets pour le lecteur d'écran). */
export function agendaViewOptions(): { value: AgendaView; label: string; accessibilityLabel: string }[] {
  return AGENDA_VIEWS.map((v) => ({ value: v, label: AGENDA_VIEW_LABELS[v], accessibilityLabel: `Vue ${AGENDA_VIEW_LABELS[v].toLowerCase()}` }));
}

/** Jour civil décalé d'une période (jour, semaine, mois : même quantième, borné à la fin du mois). */
export function shiftDay(view: AgendaView, day: string, dir: 1 | -1): string {
  if (view === "day") return addDays(day, dir);
  if (view === "week") return addDays(day, 7 * dir);
  if (view === "list") return day;
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y, m - 1 + dir, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  return `${target.toISOString().slice(0, 8)}${String(Math.min(d, last)).padStart(2, "0")}`;
}

/** Libellé de la barre de période : « Mardi 14 octobre », « 12 – 18 oct. », « Octobre 2026 ». */
export function periodLabel(view: AgendaView, day: string): string {
  if (view === "day") return capitalize(dayTitle(day));
  if (view === "week") return weekTitle(day);
  return capitalize(monthTitle(day));
}

/** Boutons ‹ › de la barre de période (lecteur d'écran). */
export function periodNavLabels(view: AgendaView): { prev: string; next: string } {
  if (view === "day") return { prev: "Jour précédent", next: "Jour suivant" };
  if (view === "week") return { prev: "Semaine précédente", next: "Semaine suivante" };
  return { prev: "Mois précédent", next: "Mois suivant" };
}

// =============================================================================
// Résumés d'un jour
// =============================================================================

/** « 3 courses · 245 € » ; sans prix connu : « 2 courses » ; rien : « Aucune course ». */
export function daySummaryText(items: readonly AgendaEntry[], now = Date.now()): string {
  const s = daySummary(items, now);
  if (s.count === 0) return "Aucune course";
  const currency = items.find((i) => i.currency)?.currency ?? "EUR";
  return s.totalCents > 0 ? `${plural(s.count, "course", "courses")} · ${formatPrice(s.totalCents, currency)}` : plural(s.count, "course", "courses");
}

/** Lecteur d'écran : « mardi 14 octobre, 3 courses dont 1 à confirmer », « …, aujourd'hui, aucune course ». */
export function dayA11y(day: string, items: readonly AgendaEntry[], o: { today: string; now: number }): string {
  const s = daySummary(items, o.now);
  const parts = [dayTitle(day)];
  if (day === o.today) parts.push("aujourd'hui");
  if (s.count === 0) parts.push("aucune course");
  else {
    parts.push(`${plural(s.count, "course", "courses")}${s.toConfirm > 0 ? ` dont ${s.toConfirm} à confirmer` : ""}`);
    if (s.unconfirmed > 0) parts.push(plural(s.unconfirmed, "non confirmée", "non confirmées"));
  }
  const closed = items.filter((i) => isClosedKind(entryKind(i, o.now))).length;
  if (closed > 0) parts.push(plural(closed, "annulée ou refusée", "annulées ou refusées"));
  return parts.join(", ");
}

// =============================================================================
// Mois : grille 7 × 6 commençant le lundi
// =============================================================================

/** En-tête de la grille (lundi en premier). */
export const WEEKDAY_INITIALS = ["L", "M", "M", "J", "V", "S", "D"] as const;
/** Points de couleur d'une case, puis « +n ». */
export const MONTH_MAX_DOTS = 3;

export type MonthCell = {
  day: string;
  /** Quantième (« 14 ») */
  label: string;
  inMonth: boolean;
  today: boolean;
  selected: boolean;
  /** Tons des premières courses du jour (ordre de prise en charge) */
  dots: Tone[];
  more: number;
  a11y: string;
};

export function monthCells(
  anchor: string,
  byDay: Readonly<Record<string, readonly AgendaEntry[]>>,
  o: { today: string; selected: string; now: number },
): MonthCell[] {
  const month = anchor.slice(0, 7);
  return monthGrid(anchor).map((day) => {
    const items = byDay[day] ?? [];
    const tones = items.map((i) => AGENDA_KIND_META[entryKind(i, o.now)].tone);
    return {
      day,
      label: String(Number(day.slice(8))),
      inMonth: day.startsWith(month),
      today: day === o.today,
      selected: day === o.selected,
      dots: tones.slice(0, MONTH_MAX_DOTS),
      more: Math.max(0, tones.length - MONTH_MAX_DOTS),
      a11y: dayA11y(day, items, o),
    };
  });
}

// =============================================================================
// Semaine : 7 lignes (lundi en premier)
// =============================================================================

/** Éléments compacts d'une ligne de la semaine, puis « +n ». */
export const WEEK_MAX_LINES = 3;

export type CompactLine = { id: string; text: string; tone: Tone; muted: boolean };

export type WeekRow = {
  day: string;
  /** « Lundi 12 » */
  title: string;
  today: boolean;
  count: number;
  /** Total du jour (null : aucune course ou aucun prix) */
  total: string | null;
  lines: CompactLine[];
  more: number;
  a11y: string;
};

/** « 08:30 Orly → Paris 8e » */
export const compactText = (e: Pick<AgendaEntry, "pickup_at" | "pickup_address" | "dropoff_address">, tz: string) =>
  `${formatTime(e.pickup_at, tz)} ${routeText(e.pickup_address, e.dropoff_address)}`;

export function weekRows(
  anchor: string,
  byDay: Readonly<Record<string, readonly AgendaEntry[]>>,
  o: { today: string; now: number; tz: string },
): WeekRow[] {
  const start = weekStart(anchor);
  return Array.from({ length: 7 }, (_, i) => {
    const day = addDays(start, i);
    const items = byDay[day] ?? [];
    const s = daySummary(items, o.now);
    const currency = items.find((x) => x.currency)?.currency ?? "EUR";
    const lines = items.slice(0, WEEK_MAX_LINES).map((e) => {
      const kind = entryKind(e, o.now);
      return { id: e.id, text: compactText(e, o.tz), tone: AGENDA_KIND_META[kind].tone, muted: isClosedKind(kind) };
    });
    const title = dateTimeFormat("fr-FR", { weekday: "long", day: "numeric", timeZone: "UTC" }).format(new Date(`${day}T12:00:00Z`));
    const total = s.count > 0 && s.totalCents > 0 ? formatPrice(s.totalCents, currency) : null;
    return {
      day,
      title: capitalize(title),
      today: day === o.today,
      count: s.count,
      total,
      lines,
      more: Math.max(0, items.length - WEEK_MAX_LINES),
      a11y: `${dayA11y(day, items, o)}${total ? `, ${total}` : ""}`,
    };
  });
}

// =============================================================================
// Jour : frise 0-24 h
// =============================================================================

/** 64 px par heure ; bloc de 48 px au moins (30 min au moins pour la durée, dayLayout). */
export const HOUR_PX = 64;
export const MIN_BLOCK_PX = 48;
export const DAY_PX = 24 * HOUR_PX;

export type TimelineBlock<T> = {
  item: T;
  /** Position et hauteur (px) dans la frise */
  top: number;
  height: number;
  /** Colonne parmi `columns` (blocs côte à côte : jamais l'un sur l'autre à l'écran) */
  column: number;
  columns: number;
  /** Chevauche réellement une autre course (durée estimée, 30 min au moins) : mention « Chevauchement » */
  overlap: boolean;
};

/**
 * Blocs de la frise : heure locale de prise en charge, hauteur selon la durée estimée (30 min et 48 px au moins).
 * Chevauchement réel : dayLayout de @rydar/shared ; colonnes calculées sur l'occupation à l'écran (un bloc de 48 px
 * déborde une course de 30 min) pour que deux blocs ne se recouvrent jamais.
 */
export function timelineBlocks<T extends AgendaEntry>(items: readonly T[], tz: string): TimelineBlock<T>[] {
  const blocks: TimelineBlock<T>[] = dayLayout(items, tz).map((b) => ({
    item: b.item,
    top: (b.start / 60) * HOUR_PX,
    height: Math.max(MIN_BLOCK_PX, ((b.end - b.start) / 60) * HOUR_PX),
    column: 0,
    columns: 1,
    overlap: b.overlap,
  }));
  let group: TimelineBlock<T>[] = [];
  let groupEnd = -1;
  let columnEnds: number[] = [];
  const close = () => {
    for (const b of group) b.columns = columnEnds.length;
    group = [];
    columnEnds = [];
    groupEnd = -1;
  };
  for (const b of blocks) {
    if (group.length > 0 && b.top >= groupEnd) close();
    let column = columnEnds.findIndex((end) => end <= b.top);
    if (column === -1) {
      column = columnEnds.length;
      columnEnds.push(b.top + b.height);
    } else columnEnds[column] = b.top + b.height;
    b.column = column;
    group.push(b);
    groupEnd = Math.max(groupEnd, b.top + b.height);
  }
  close();
  return blocks;
}

/** Hauteur de la frise : 24 h, ou plus si un bloc de fin de soirée déborde minuit. */
export function timelineHeight(blocks: readonly { top: number; height: number }[]): number {
  return Math.max(DAY_PX, ...blocks.map((b) => b.top + b.height));
}

/** Trait « maintenant » (px) dans la frise du jour local d'aujourd'hui. */
export function nowLineTop(now: number, tz: string): number {
  return (minutesOfDay(new Date(now).toISOString(), tz) / 60) * HOUR_PX;
}

/** Défilement initial : 1 h avant maintenant (aujourd'hui) ou avant la 1re course ; sinon 8 h. */
export function timelineScrollY(blocks: readonly { top: number }[], nowTop: number | null): number {
  if (nowTop != null) return Math.max(0, nowTop - HOUR_PX);
  if (blocks.length > 0) return Math.max(0, Math.min(...blocks.map((b) => b.top)) - HOUR_PX);
  return 8 * HOUR_PX;
}

// =============================================================================
// Élément affiché (bloc de la frise, ligne d'un jour)
// =============================================================================

export type EntryView = {
  id: string;
  time: string;
  /** « Course 1042 » */
  title: string;
  route: string;
  kind: AgendaKind;
  kindLabel: string;
  tone: Tone;
  muted: boolean;
  price: string;
  target: EntryTarget;
  a11y: string;
};

export function entryView(e: AgendaEntry, o: { tz: string; now: number }, overlap = false): EntryView {
  const kind = entryKind(e, o.now);
  const meta = AGENDA_KIND_META[kind];
  const time = formatTime(e.pickup_at, o.tz);
  const price = formatPrice(e.price_cents, e.currency ?? "EUR");
  // Réservation encore sans chauffeur (Flotte Privée) : « Réservation 1042 », comme sa carte du bloc « À traiter »
  const noun = e.state ? "Réservation" : "Course";
  const title = `${noun}${NBSP}${e.number}`;
  return {
    id: e.id,
    time,
    title,
    route: routeText(e.pickup_address, e.dropoff_address),
    kind,
    kindLabel: meta.label,
    tone: meta.tone,
    muted: isClosedKind(kind),
    price,
    target: entryTarget(e),
    a11y: [
      time, `${noun.toLowerCase()} ${e.number}`, `${shortAddress(e.pickup_address)} vers ${shortAddress(e.dropoff_address)}`, meta.label.toLowerCase(),
      ...(e.price_cents != null ? [price] : []), ...(overlap ? ["chevauchement"] : []),
    ].join(", "),
  };
}

/** Liste : « Mes courses » regroupées par jour local (« Aujourd'hui », « Demain », « Jeudi 16 octobre »). */
export function listSections<T extends Pick<AgendaEntry, "id" | "pickup_at">>(
  rides: readonly T[],
  tz: string,
  today: string,
): { day: string; title: string; items: T[] }[] {
  const byDay = groupByDay(rides, tz);
  return Object.keys(byDay)
    .sort()
    .map((day) => ({ day, title: capitalize(dayHeading(day, today)), items: byDay[day]! }));
}

/** Courses regroupées par jour local (frise, semaine, mois). */
export function entriesByDay<T extends AgendaEntry>(items: readonly T[], tz: string): Record<string, T[]> {
  return groupByDay(items, tz);
}

/** Jour local d'aujourd'hui (fuseau de l'organisation). */
export const todayIn = (tz: string, now = Date.now()) => localIsoDay(new Date(now), tz);

// =============================================================================
// « À traiter » (Flotte Privée) : à confirmer, non confirmées
// =============================================================================

/** Réservation à traiter : driver_agenda.unassigned, jointe aux offres en attente lues par l'app. */
export type TodoCard = {
  rideId: string;
  offerId: string | null;
  state: PrivateFleetBookingState;
  number: number;
  type: RideType;
  status: RideStatus;
  pickupAt: string;
  pickupAddress: string;
  dropoffAddress: string;
  priceCents: number | null;
  currency: string;
  passengers: number;
  luggage: number;
  category: VehicleCategory;
  estimatedDurationS: number | null;
  customerName: string | null;
  customerPhone: string | null;
  /** Échéance de la réponse (offre en attente) */
  expiresAt: string | null;
};

const fromBooking = (b: AgendaBooking, offer: DriverOfferV2 | undefined): TodoCard => ({
  rideId: b.id,
  offerId: b.offer_id ?? offer?.offer_id ?? null,
  state: b.state,
  number: b.number,
  type: b.type,
  status: b.status,
  pickupAt: b.pickup_at,
  pickupAddress: b.pickup_address,
  dropoffAddress: b.dropoff_address,
  priceCents: b.price_cents,
  currency: b.currency || "EUR",
  passengers: b.passengers,
  luggage: b.luggage,
  category: b.vehicle_category,
  estimatedDurationS: b.estimated_duration_s,
  customerName: b.customer_name,
  customerPhone: b.customer_phone,
  expiresAt: offer?.expires_at ?? b.offer_expires_at ?? null,
});

const fromOffer = (o: DriverOfferV2): TodoCard => ({
  rideId: o.ride_id,
  offerId: o.offer_id,
  state: "to_confirm",
  number: o.number,
  type: o.ride_type,
  status: "OFFERED",
  pickupAt: o.pickup_at,
  pickupAddress: o.pickup_address,
  dropoffAddress: o.dropoff_address,
  priceCents: o.price_cents,
  currency: o.currency || "EUR",
  passengers: o.passengers,
  luggage: o.luggage,
  category: o.vehicle_category,
  estimatedDurationS: o.estimated_duration_s,
  customerName: null,
  customerPhone: null,
  expiresAt: o.expires_at,
});

const byPickup = (a: TodoCard, b: TodoCard) => Date.parse(a.pickupAt) - Date.parse(b.pickupAt) || a.rideId.localeCompare(b.rideId);

/**
 * Bloc « À traiter » : « À confirmer » (offre en attente : driver_agenda.unassigned jointe aux offres de l'app, plus
 * une offre arrivée après la lecture de l'agenda, ou agenda illisible) et « Non confirmées » (à vérifier, non
 * confirmées, puis refusées) ; ordre de prise en charge.
 */
export function todoCards(
  unassigned: readonly AgendaBooking[] | null | undefined,
  offers: readonly DriverOfferV2[],
): { toConfirm: TodoCard[]; unconfirmed: TodoCard[] } {
  const own = offers.filter((o) => !o.network);
  const byOffer = new Map(own.map((o) => [o.offer_id, o]));
  const byRide = new Map(own.map((o) => [o.ride_id, o]));
  const cards: TodoCard[] = [];
  const seen = new Set<string>();
  for (const b of unassigned ?? []) {
    seen.add(b.id);
    const offer = (b.offer_id ? byOffer.get(b.offer_id) : undefined) ?? (b.state === "to_confirm" ? byRide.get(b.id) : undefined);
    cards.push(fromBooking(b, offer));
  }
  for (const o of own) {
    if (o.mode === "fleet" && !seen.has(o.ride_id)) {
      seen.add(o.ride_id);
      cards.push(fromOffer(o));
    }
  }
  const toConfirm = cards.filter((c) => c.state === "to_confirm").sort(byPickup);
  const open = cards.filter((c) => c.state === "to_check" || c.state === "not_confirmed").sort(byPickup);
  const declined = cards.filter((c) => c.state === "declined").sort(byPickup);
  return { toConfirm, unconfirmed: [...open, ...declined] };
}

/** « dans 25 min », « dans 3 h », « demain », « dans 4 j », « il y a 2 h » (heure du fuseau de l'organisation). */
export function relativePickup(iso: string, tz: string, now = Date.now()): string {
  const diff = Date.parse(iso) - now;
  if (diff <= 0) {
    const m = Math.max(1, Math.round(-diff / 60_000));
    return m < 60 ? `il y a ${m}${NBSP}min` : `il y a ${Math.round(m / 60)}${NBSP}h`;
  }
  if (diff < 3_600_000) return `dans ${Math.max(1, Math.round(diff / 60_000))}${NBSP}min`;
  const today = localIsoDay(new Date(now), tz);
  const day = localIsoDay(iso, tz);
  if (day === today || diff < 12 * 3_600_000) return `dans ${Math.round(diff / 3_600_000)}${NBSP}h`;
  if (day === addDays(today, 1)) return "demain";
  const days = Math.round((Date.parse(`${day}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86_400_000);
  return `dans ${days}${NBSP}j`;
}

/** Véhicule du chauffeur (driver_home().vehicle). */
export type VehicleInfo = { category: VehicleCategory; seats: number } | null | undefined;

/**
 * Avertissements : catégorie ou places au-delà de son véhicule (même règle que private.category_compatible, montée en
 * gamme permise) — la réservation reste prenable (« La prendre » ne contrôle pas la catégorie).
 */
export function vehicleWarnings(b: { category: VehicleCategory; passengers: number }, vehicle: VehicleInfo): string[] {
  if (!vehicle) return [];
  const out: string[] = [];
  if (!isCategoryCompatible(b.category, vehicle.category, true)) {
    out.push(frTypo(`Catégorie demandée : ${VEHICLE_CATEGORY_META[b.category].label} (votre véhicule : ${VEHICLE_CATEGORY_META[vehicle.category].label})`));
  }
  if (b.passengers > vehicle.seats) out.push(`${plural(b.passengers, "passager", "passagers")} pour ${plural(vehicle.seats, "place", "places")}`);
  return out;
}

/** Chevauchement avec une de ses courses confirmées (durée estimée, 30 min au moins : overlaps de @rydar/shared). */
export function overlapWarning(
  b: { rideId: string; pickupAt: string; estimatedDurationS: number | null },
  rides: readonly AgendaEntry[],
  tz: string,
): string | null {
  const slot = { pickup_at: b.pickupAt, estimated_duration_s: b.estimatedDurationS };
  const hit = rides.find((r) => r.id !== b.rideId && !r.state && ACTIVE.includes(r.status) && overlaps(slot, r));
  return hit ? `Chevauche votre course ${hit.number} de ${formatTime(hit.pickup_at, tz)}` : null;
}

export type TodoCardView = {
  stateLabel: string;
  stateTone: Tone;
  /** Refusée : en retrait */
  muted: boolean;
  /** « Demain 08:30 », « Réservation immédiate » */
  when: string;
  /** « dans 3 h » (planifiée seulement) */
  relative: string | null;
  /** « Réservation 1042 · 3 passagers · 1 bagage » */
  meta: string;
  price: string;
  customer: string | null;
  answerBefore: string | null;
  warnings: string[];
  /** « La prendre » possible (prise en charge il y a moins de 6 h) */
  takeable: boolean;
  a11y: string;
};

export function todoCardView(
  c: TodoCard,
  o: { tz: string; now: number; vehicle: VehicleInfo; rides: readonly AgendaEntry[]; answerBefore: string | null },
): TodoCardView {
  const meta = PRIVATE_FLEET_BOOKING_STATE_META[c.state];
  const when = c.type === "instant" ? "Réservation immédiate" : formatRideDate(c.pickupAt, o.tz, new Date(o.now));
  const relative = c.type === "instant" ? null : relativePickup(c.pickupAt, o.tz, o.now);
  const people = `${plural(c.passengers, "passager", "passagers")}${c.luggage > 0 ? ` · ${plural(c.luggage, "bagage", "bagages")}` : ""}`;
  const overlap = overlapWarning(c, o.rides, o.tz);
  const warnings = [...vehicleWarnings(c, o.vehicle), ...(overlap ? [overlap] : [])];
  const price = formatPrice(c.priceCents, c.currency);
  const customer = c.customerName?.trim() || null;
  return {
    stateLabel: meta.label,
    stateTone: meta.tone,
    muted: c.state === "declined",
    when,
    relative,
    meta: `Réservation${NBSP}${c.number} · ${people}`,
    price,
    customer,
    answerBefore: c.state === "to_confirm" ? o.answerBefore : null,
    warnings,
    takeable: privateFleetTakeable({ status: c.status, driver_id: null, pickup_at: c.pickupAt }, o.now),
    a11y: [
      meta.label, `réservation ${c.number}`, relative ? `${when}, ${relative}` : when,
      `${shortAddress(c.pickupAddress)} vers ${shortAddress(c.dropoffAddress)}`, people,
      ...(c.priceCents != null ? [price] : []), ...(customer ? [`client ${customer}`] : []),
      ...(c.state === "to_confirm" && o.answerBefore ? [o.answerBefore] : []), ...warnings,
    ].join(", "),
  };
}

/** Motif d'annulation d'une réservation : 3 à 280 caractères (rpc cancel_ride). */
export const CANCEL_REASON_MIN = 3;
export const CANCEL_REASON_MAX = 280;

export function cancelReasonError(reason: string): string | null {
  const n = reason.trim().length;
  if (n < CANCEL_REASON_MIN) return `Indiquez le motif (${CANCEL_REASON_MIN}${NBSP}caractères au moins).`;
  if (n > CANCEL_REASON_MAX) return `${CANCEL_REASON_MAX}${NBSP}caractères au plus.`;
  return null;
}

/** Réservation prise (driver_take_ride, acceptation) : titre et message de la confirmation. */
export function takenText(res: { code?: string | null; chained?: boolean | null }): { title: string; message: string } {
  if (res.code === "UNCHANGED") return { title: "Déjà dans votre agenda", message: "Cette réservation vous est déjà attribuée." };
  if (res.chained) return { title: "Réservation confirmée", message: "Elle commencera après votre course en cours." };
  return { title: "Réservation confirmée", message: "Ajoutée à votre agenda. Rappels programmés." };
}

// =============================================================================
// Accueil (Flotte Privée)
// =============================================================================

/**
 * Pastille de l'agenda : réservations à confirmer (offres de la flotte en attente) + à traiter (à vérifier, non
 * confirmées : driver_home().private.unassigned) ; ambre s'il y en a à traiter.
 */
export function agendaBadge(fleetOffers: number, unassigned: number | null | undefined): { count: number; alert: boolean; a11y: string } {
  const todo = Math.max(0, unassigned ?? 0);
  const count = Math.max(0, fleetOffers) + todo;
  return { count, alert: todo > 0, a11y: count > 0 ? `Agenda, ${plural(count, "réservation à traiter", "réservations à traiter")}` : "Agenda" };
}

/**
 * Ligne du panneau d'accueil vers l'agenda : « À confirmer (n) » (et les non confirmées à traiter en dessous), ou
 * « Non confirmées (n) » seules ; null : rien à traiter.
 */
export function homeTodoLine(fleetOffers: number, unassigned: number | null | undefined): { title: string; sub: string | null; alert: boolean } | null {
  const toConfirm = Math.max(0, fleetOffers);
  const todo = Math.max(0, unassigned ?? 0);
  if (toConfirm === 0 && todo === 0) return null;
  if (toConfirm === 0) return { title: `Non confirmées (${todo})`, sub: null, alert: true };
  return {
    title: `À confirmer (${toConfirm})`,
    sub: todo > 0 ? plural(todo, "réservation non confirmée", "réservations non confirmées") : null,
    alert: todo > 0,
  };
}
