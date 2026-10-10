// Agenda de l'app (docs/FLOTTE-PRIVEE.md § 10.5) : vues par défaut, périodes, cases du mois, semaine, frise du jour,
// bloc « À traiter » (Flotte Privée), couleurs (tons), libellés en typographie française, textes du lecteur d'écran et
// montants (sa part ou le prix, comme la vue Liste).
import type { AgendaBooking, DriverOfferV2, DriverRideMoney } from "@rydar/shared";
import { describe, expect, it } from "vitest";
import { space } from "../theme";
import {
  DAY_PX, HOUR_PX, MIN_BLOCK_PX, MONTH_CELL_H, agendaBadge, agendaTitle, agendaViewOptions, calendarEntries, cancelReasonError, dayA11y,
  daySummaryText, declineBookingPrompt, defaultAgendaView, entriesByDay, entryAmountCents, entryTarget, entryView, homeTodoLine,
  listSections, monthCellWidth, monthCells, nowLineTop, overlapWarning, periodLabel, periodNavLabels, relativePickup, shiftDay,
  takenText, timelineBlocks, timelineHeight, timelineScrollY, todayIn, todoCards, todoCardView, vehicleWarnings, weekRows,
  type AgendaEntry,
} from "./agenda-view";

const NBSP = " ";
const TZ = "Europe/Paris";
// Mardi 13 octobre 2026, 09:00 à Paris (UTC+2)
const NOW = Date.parse("2026-10-13T07:00:00Z");
const TODAY = "2026-10-13";

/** Heure de Paris (UTC+2 en octobre avant le 25) → instant ISO. */
const paris = (day: string, hhmm: string) => new Date(Date.parse(`${day}T${hhmm}:00+02:00`)).toISOString();

const entry = (id: string, status: AgendaEntry["status"], day: string, hhmm: string, extra: Partial<AgendaEntry> = {}): AgendaEntry => ({
  id,
  number: Number(id.replace(/\D/g, "")) || 1000,
  type: "scheduled",
  status,
  pickup_at: paris(day, hhmm),
  pickup_address: "Aéroport d'Orly, 94390 Orly",
  dropoff_address: "Paris 8e, 75008 Paris",
  estimated_duration_s: 1800,
  price_cents: 8500,
  currency: "EUR",
  ...extra,
});

const booking = (id: string, state: AgendaBooking["state"], day: string, hhmm: string, extra: Record<string, unknown> = {}) =>
  ({
    ...entry(id, state === "not_confirmed" || state === "declined" ? "NO_DRIVER_FOUND" : "OFFERED", day, hhmm),
    passengers: 2,
    luggage: 1,
    vehicle_category: "business",
    customer_name: "Mme Durand",
    customer_phone: "+33612345678",
    offer_id: state === "to_confirm" ? `offre-${id}` : null,
    offer_expires_at: state === "to_confirm" ? paris(day, "07:30") : null,
    state,
    ...extra,
  }) as unknown as AgendaBooking;

const offer = (offerId: string, rideId: string, day: string, hhmm: string, extra: Record<string, unknown> = {}) =>
  ({
    offer_id: offerId,
    ride_id: rideId,
    number: 2001,
    mode: "fleet",
    status: "pending",
    ride_type: "scheduled",
    pickup_address: "Gare de Lyon, 75012 Paris",
    dropoff_address: "Roissy CDG, 95700 Roissy",
    pickup_at: paris(day, hhmm),
    price_cents: 6500,
    currency: "EUR",
    passengers: 1,
    luggage: 0,
    vehicle_category: "standard",
    estimated_duration_s: 2400,
    sent_at: paris(TODAY, "08:55"),
    expires_at: paris(day, "06:00"),
    network: null,
    ...extra,
  }) as unknown as DriverOfferV2;

describe("vues et titre", () => {
  it("défaut : Liste pour un chauffeur standard (Planning inchangé), Mois en Flotte Privée", () => {
    expect(defaultAgendaView(false)).toBe("list");
    expect(defaultAgendaView(true)).toBe("month");
    expect(agendaTitle(false)).toBe("Planning");
    expect(agendaTitle(true)).toBe("Agenda");
  });

  it("sélecteur Liste · Jour · Semaine · Mois, libellés complets pour le lecteur d'écran", () => {
    expect(agendaViewOptions()).toEqual([
      { value: "list", label: "Liste", accessibilityLabel: "Vue liste" },
      { value: "day", label: "Jour", accessibilityLabel: "Vue jour" },
      { value: "week", label: "Semaine", accessibilityLabel: "Vue semaine" },
      { value: "month", label: "Mois", accessibilityLabel: "Vue mois" },
    ]);
  });
});

describe("périodes", () => {
  it("‹ › : jour, semaine, mois (même quantième, borné à la fin du mois) ; liste : jour inchangé", () => {
    expect(shiftDay("day", "2026-10-31", 1)).toBe("2026-11-01");
    expect(shiftDay("week", "2026-10-13", -1)).toBe("2026-10-06");
    expect(shiftDay("month", "2026-01-31", 1)).toBe("2026-02-28");
    expect(shiftDay("month", "2028-01-31", 1)).toBe("2028-02-29");
    expect(shiftDay("month", "2026-12-15", 1)).toBe("2027-01-15");
    expect(shiftDay("month", "2026-03-31", -1)).toBe("2026-02-28");
    expect(shiftDay("list", "2026-10-13", 1)).toBe("2026-10-13");
  });

  it("libellés de la barre de période et des boutons", () => {
    expect(periodLabel("day", "2026-10-13")).toBe("Mardi 13 octobre");
    expect(periodLabel("week", "2026-10-14")).toBe("12 – 18 oct.");
    expect(periodLabel("month", "2026-10-14")).toBe("Octobre 2026");
    expect(periodNavLabels("week")).toEqual({ prev: "Semaine précédente", next: "Semaine suivante" });
    expect(periodNavLabels("month")).toEqual({ prev: "Mois précédent", next: "Mois suivant" });
  });

  it("aujourd'hui dans le fuseau de l'organisation (près de minuit)", () => {
    expect(todayIn(TZ, Date.parse("2026-10-13T22:30:00Z"))).toBe("2026-10-14");
    expect(todayIn("UTC", Date.parse("2026-10-13T22:30:00Z"))).toBe("2026-10-13");
  });
});

describe("résumés d'un jour", () => {
  const day = [
    entry("r1", "ACCEPTED", TODAY, "14:30", { price_cents: 8500 }),
    entry("r2", "OFFERED", TODAY, "16:00", { price_cents: 9000, state: "to_confirm", offer_id: "o2" }),
    entry("r3", "COMPLETED", TODAY, "07:00", { price_cents: 7000 }),
    entry("r4", "CANCELLED", TODAY, "18:00", { price_cents: 5000 }),
  ];

  it("« 3 courses · 245 € » (annulées et refusées exclues) ; sans prix ; aucune", () => {
    const o = { now: NOW, ownerDriver: false };
    expect(daySummaryText(day, o)).toBe(`3${NBSP}courses · 245${NBSP}€`);
    expect(daySummaryText([entry("r5", "ACCEPTED", TODAY, "15:00", { price_cents: null })], o)).toBe(`1${NBSP}course`);
    expect(daySummaryText([day[3]!], o)).toBe("Aucune course");
  });

  it("lecteur d'écran : « mardi 13 octobre, 3 courses dont 1 à confirmer »", () => {
    expect(dayA11y(TODAY, day.slice(0, 3), { today: "2026-10-12", now: NOW })).toBe(`mardi 13 octobre, 3${NBSP}courses dont 1 à confirmer`);
    expect(dayA11y(TODAY, day, { today: TODAY, now: NOW })).toBe(
      `mardi 13 octobre, aujourd'hui, 3${NBSP}courses dont 1 à confirmer, 1${NBSP}annulée ou refusée`,
    );
    const unconfirmed = entry("r6", "NO_DRIVER_FOUND", TODAY, "20:00", { state: "not_confirmed" });
    expect(dayA11y(TODAY, [unconfirmed], { today: "2026-10-12", now: NOW })).toBe(`mardi 13 octobre, 1${NBSP}course, 1${NBSP}non confirmée`);
    expect(dayA11y("2026-10-14", [], { today: TODAY, now: NOW })).toBe("mercredi 14 octobre, aucune course");
  });
});

describe("mois", () => {
  const items = [
    entry("r1", "ACCEPTED", TODAY, "10:00"),
    entry("r2", "OFFERED", TODAY, "11:00", { state: "to_confirm", offer_id: "o2" }),
    entry("r3", "NO_DRIVER_FOUND", TODAY, "12:00", { state: "not_confirmed" }),
    entry("r4", "DRIVER_EN_ROUTE", TODAY, "13:00"),
    entry("r5", "COMPLETED", "2026-10-01", "09:00"),
  ];
  const cells = monthCells("2026-10-20", entriesByDay(items, TZ), { today: TODAY, selected: "2026-10-01", now: NOW });

  it("grille de 42 jours commençant le lundi (1er octobre 2026 : jeudi)", () => {
    expect(cells).toHaveLength(42);
    expect(cells[0]).toMatchObject({ day: "2026-09-28", label: "28", inMonth: false });
    expect(cells[3]).toMatchObject({ day: "2026-10-01", label: "1", inMonth: true, selected: true });
    expect(cells[41]).toMatchObject({ day: "2026-11-08", inMonth: false });
  });

  it("aujourd'hui, points colorés (couleur = information) puis « +n »", () => {
    const today = cells.find((c) => c.today)!;
    expect(today.day).toBe(TODAY);
    expect(today.dots).toEqual(["violet", "amber", "red"]);
    expect(today.more).toBe(1);
    expect(today.a11y).toBe(`mardi 13 octobre, aujourd'hui, 4${NBSP}courses dont 1 à confirmer, 1${NBSP}non confirmée`);
    expect(cells[3]!.dots).toEqual(["green"]);
    expect(cells[1]).toMatchObject({ dots: [], more: 0, a11y: "mardi 29 septembre, aucune course" });
  });

  it("cases de 48 × 52 px au moins dès un écran Android de 360 px (marge de l'agenda : space.lg)", () => {
    // Sans débord sur la marge : (360 − 2 × 16) / 7 ≈ 46,9 px
    expect(monthCellWidth(360, space.lg)).toBeGreaterThanOrEqual(48);
    expect(monthCellWidth(375, space.lg)).toBeGreaterThanOrEqual(48);
    expect(MONTH_CELL_H).toBeGreaterThanOrEqual(52);
  });
});

describe("semaine", () => {
  const items = [
    entry("r1", "ACCEPTED", "2026-10-12", "08:30", { price_cents: 8500 }),
    entry("r2", "ACCEPTED", "2026-10-12", "10:00", { price_cents: 4000 }),
    entry("r3", "ACCEPTED", "2026-10-12", "12:00", { price_cents: null }),
    entry("r4", "CANCELLED", "2026-10-12", "15:00", { price_cents: 3000 }),
  ];
  const rows = weekRows("2026-10-14", entriesByDay(items, TZ), { today: TODAY, now: NOW, tz: TZ, ownerDriver: false });

  it("7 lignes, lundi en premier", () => {
    expect(rows.map((r) => r.day)).toEqual([
      "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18",
    ]);
    expect(rows[0]!.title).toBe("Lundi 12");
    expect(rows[1]).toMatchObject({ title: "Mardi 13", today: true, count: 0, total: null, lines: [], more: 0 });
  });

  it("nombre, total (mono), 3 éléments compacts puis « +n »", () => {
    const monday = rows[0]!;
    expect(monday.count).toBe(3);
    expect(monday.total).toBe(`125${NBSP}€`);
    expect(monday.lines.map((l) => l.text)).toEqual([
      "08:30 Aéroport d'Orly → Paris 8e", "10:00 Aéroport d'Orly → Paris 8e", "12:00 Aéroport d'Orly → Paris 8e",
    ]);
    expect(monday.more).toBe(1);
    expect(monday.a11y).toBe(`lundi 12 octobre, 3${NBSP}courses, 1${NBSP}annulée ou refusée, 125${NBSP}€`);
  });
});

describe("frise du jour", () => {
  it("position selon la prise en charge (64 px par heure), 48 px au moins", () => {
    const [b] = timelineBlocks([entry("r1", "ACCEPTED", TODAY, "08:30", { estimated_duration_s: 900 })], TZ);
    expect(b).toMatchObject({ top: 8.5 * HOUR_PX, height: MIN_BLOCK_PX, column: 0, columns: 1, overlap: false });
    const [long] = timelineBlocks([entry("r2", "ACCEPTED", TODAY, "10:00", { estimated_duration_s: 5400 })], TZ);
    expect(long!.height).toBe(1.5 * HOUR_PX);
  });

  it("chevauchement réel : côte à côte avec la mention ; blocs voisins qui se toucheraient à l'écran : côte à côte, sans mention", () => {
    const real = timelineBlocks(
      [entry("r1", "ACCEPTED", TODAY, "08:00", { estimated_duration_s: 3600 }), entry("r2", "ACCEPTED", TODAY, "08:30")],
      TZ,
    );
    expect(real.map((b) => [b.column, b.columns, b.overlap])).toEqual([[0, 2, true], [1, 2, true]]);
    const close = timelineBlocks([entry("r1", "ACCEPTED", TODAY, "08:00"), entry("r2", "ACCEPTED", TODAY, "08:35")], TZ);
    expect(close.map((b) => [b.column, b.columns, b.overlap])).toEqual([[0, 2, false], [1, 2, false]]);
    const apart = timelineBlocks([entry("r1", "ACCEPTED", TODAY, "08:00"), entry("r2", "ACCEPTED", TODAY, "09:00")], TZ);
    expect(apart.map((b) => [b.column, b.columns])).toEqual([[0, 1], [0, 1]]);
  });

  it("hauteur (fin de soirée), trait « maintenant », défilement initial", () => {
    const late = timelineBlocks([entry("r1", "ACCEPTED", TODAY, "23:45")], TZ);
    expect(timelineHeight(late)).toBe(23.75 * HOUR_PX + MIN_BLOCK_PX);
    expect(timelineHeight([])).toBe(DAY_PX);
    expect(nowLineTop(NOW, TZ)).toBe(9 * HOUR_PX);
    expect(timelineScrollY(late, 9 * HOUR_PX)).toBe(8 * HOUR_PX);
    expect(timelineScrollY(late, null)).toBe(22.75 * HOUR_PX);
    expect(timelineScrollY([], null)).toBe(8 * HOUR_PX);
    expect(timelineScrollY([], 0)).toBe(0);
  });
});

describe("éléments affichés", () => {
  it("course : couleur, libellé, lecteur d'écran, destination", () => {
    const v = entryView(entry("r1042", "ACCEPTED", TODAY, "14:30"), { tz: TZ, now: NOW, ownerDriver: false }, true);
    expect(v).toMatchObject({
      time: "14:30", title: `Course${NBSP}1042`, route: "Aéroport d'Orly → Paris 8e", kind: "confirmed", kindLabel: "Confirmée",
      tone: "violet", muted: false, price: `85${NBSP}€`, target: { kind: "ride", id: "r1042" },
    });
    expect(v.a11y).toBe(`14:30, course 1042, Aéroport d'Orly vers Paris 8e, confirmée, 85${NBSP}€, chevauchement`);
  });

  it("heure dépassée (ambre), annulée (en retrait), réservation : offre ou bloc « À traiter »", () => {
    const o = { tz: TZ, now: NOW, ownerDriver: false };
    expect(entryView(entry("r1", "ACCEPTED", TODAY, "08:00"), o)).toMatchObject({ kind: "overdue", tone: "amber" });
    expect(entryView(entry("r2", "CANCELLED", TODAY, "10:00"), o)).toMatchObject({ kind: "cancelled", muted: true });
    const booked = entryView(entry("b1043", "OFFERED", TODAY, "16:00", { state: "to_confirm", offer_id: "o1" }), o);
    expect(booked).toMatchObject({ title: `Réservation${NBSP}1043`, kind: "to_confirm", kindLabel: "À confirmer", tone: "amber", target: { kind: "offer", id: "o1" } });
    expect(booked.a11y).toBe(`16:00, réservation 1043, Aéroport d'Orly vers Paris 8e, à confirmer, 85${NBSP}€`);
    expect(entryTarget({ id: "b1", state: "to_confirm", offer_id: "o1" })).toEqual({ kind: "offer", id: "o1" });
    expect(entryTarget({ id: "b2", state: "not_confirmed", offer_id: null })).toEqual({ kind: "todo", id: "b2" });
  });

  it("courses et réservations sans doublon (réservation prise entre deux lectures)", () => {
    const ride = entry("r1", "ACCEPTED", TODAY, "10:00");
    const unassigned = [entry("r1", "OFFERED", TODAY, "10:00", { state: "to_confirm" }), entry("b2", "OFFERED", TODAY, "11:00", { state: "to_confirm" })];
    expect(calendarEntries([ride], unassigned).map((e) => [e.id, e.state ?? null])).toEqual([["r1", null], ["b2", "to_confirm"]]);
    expect(calendarEntries([ride], null)).toEqual([ride]);
  });

  it("courses et réservations sans doublon : l'argent lu de la course est gardé", () => {
    const money: DriverRideMoney = {
      price_cents: 5900, currency: "EUR", payment_method: "cash", collects: true, driver_part_cents: 4000, giver_part_cents: 1900,
      direction: "driver_owes", amount_cents: 1900, counterparty: null, creditor_name: "Taxi Martin",
    };
    const [ride] = calendarEntries([entry("r1", "ACCEPTED", TODAY, "10:00", { money })], null);
    expect(entryAmountCents(ride!, { ownerDriver: false })).toBe(4000);
  });

  it("liste : regroupée par jour local (« Aujourd'hui », « Demain », « Jeudi 15 octobre »)", () => {
    const rides = [
      entry("r3", "ACCEPTED", "2026-10-15", "08:00"),
      entry("r1", "ACCEPTED", TODAY, "23:30"),
      entry("r2", "ACCEPTED", "2026-10-14", "00:15"),
    ];
    expect(listSections(rides, TZ, TODAY).map((s) => [s.title, s.items.map((r) => r.id)])).toEqual([
      ["Aujourd'hui", ["r1"]], ["Demain", ["r2"]], ["Jeudi 15 octobre", ["r3"]],
    ]);
  });
});

describe("montants : sa part ou le prix, comme la vue Liste", () => {
  // Course de centrale de 59 € dont la part du chauffeur est de 40 € (la vue Liste affiche 40 €)
  const centraleMoney: DriverRideMoney = {
    price_cents: 5900, currency: "EUR", payment_method: "cash", collects: true, driver_part_cents: 4000, giver_part_cents: 1900,
    direction: "driver_owes", amount_cents: 1900, counterparty: null, creditor_name: "Taxi Martin",
  };
  // Flotte : ni part ni sens (S20)
  const fleetMoney: DriverRideMoney = {
    price_cents: 8500, currency: "EUR", payment_method: "card", collects: true, driver_part_cents: null, giver_part_cents: null,
    direction: null, amount_cents: null, counterparty: null, creditor_name: null,
  };
  const partnerNetwork = {
    execution_id: "e1",
    giver: { name: "Taxi Alpha", legal_name: null, vtc_registration: null, phone: null, phone_until: null },
  } as AgendaEntry["network"];
  const centrale = entry("r1", "ACCEPTED", TODAY, "10:00", { price_cents: 5900, money: centraleMoney, network: null });
  const fleet = entry("r2", "ACCEPTED", TODAY, "11:00", { price_cents: 8500, money: fleetMoney, network: null });
  const partner = entry("r3", "ACCEPTED", TODAY, "12:00", {
    price_cents: 6000, money: { ...centraleMoney, price_cents: 6000, driver_part_cents: 4500, giver_part_cents: 1500 }, network: partnerNetwork,
  });
  // Réservation encore sans chauffeur (Flotte Privée) : son prix
  const booking = entry("b4", "OFFERED", TODAY, "13:00", { price_cents: 7000, state: "to_confirm", offer_id: "o4", money: fleetMoney, network: null });
  const me = { ownerDriver: false };
  const owner = { ownerDriver: true };

  it("course de centrale ou partenaire : sa part ; course de flotte, argent non lu, réservation sans chauffeur : le prix", () => {
    expect(entryAmountCents(centrale, me)).toBe(4000);
    expect(entryAmountCents(partner, me)).toBe(4500);
    expect(entryAmountCents(fleet, me)).toBe(8500);
    expect(entryAmountCents(entry("r5", "ACCEPTED", TODAY, "14:00"), me)).toBe(8500);
    expect(entryAmountCents(booking, me)).toBe(7000);
  });

  it("fiche du gérant (Flotte Privée passée en centrale) : le prix de ses courses, sa part d'une course partenaire", () => {
    expect(entryAmountCents(centrale, owner)).toBe(5900);
    expect(entryAmountCents(partner, owner)).toBe(4500);
  });

  it("ligne du jour et bloc de la frise : le montant affiché, lecteur d'écran compris", () => {
    const v = entryView(centrale, { tz: TZ, now: NOW, ...me });
    expect(v.price).toBe(`40${NBSP}€`);
    expect(v.a11y).toBe(`10:00, course 1, Aéroport d'Orly vers Paris 8e, confirmée, 40${NBSP}€`);
    expect(entryView(centrale, { tz: TZ, now: NOW, ...owner }).price).toBe(`59${NBSP}€`);
  });

  it("totaux du jour (vues Jour et Mois) et de la semaine : sur les montants affichés, jamais sur le prix brut d'une part", () => {
    const items = [centrale, fleet, partner, booking];
    // 40 + 85 + 45 + 70 = 240 € (et non 59 + 85 + 60 + 70 = 274 €) ; fiche du gérant : 59 + 85 + 45 + 70 = 259 €
    expect(daySummaryText(items, { now: NOW, ...me })).toBe(`4${NBSP}courses · 240${NBSP}€`);
    expect(daySummaryText(items, { now: NOW, ...owner })).toBe(`4${NBSP}courses · 259${NBSP}€`);
    const row = weekRows(TODAY, entriesByDay(items, TZ), { today: TODAY, now: NOW, tz: TZ, ...me }).find((r) => r.day === TODAY)!;
    expect(row.total).toBe(`240${NBSP}€`);
    expect(row.a11y).toBe(`mardi 13 octobre, aujourd'hui, 4${NBSP}courses dont 1 à confirmer, 240${NBSP}€`);
  });
});

describe("« À traiter » (Flotte Privée)", () => {
  const unassigned = [
    booking("b3", "declined", "2026-10-14", "07:00"),
    booking("b2", "not_confirmed", TODAY, "08:30"),
    booking("b1", "to_confirm", "2026-10-14", "08:30"),
    booking("b4", "to_check", "2026-10-15", "09:00", { vehicle_category: "van" }),
    booking("b5", "to_confirm", TODAY, "18:00", { offer_id: "offre-gps" }),
  ];
  const offers = [
    offer("offre-b1", "b1", "2026-10-14", "08:30", { expires_at: paris("2026-10-14", "07:15") }),
    offer("offre-gps", "b5", TODAY, "18:00", { mode: "geo", expires_at: paris(TODAY, "09:05") }),
    offer("offre-neuve", "b9", "2026-10-16", "06:00"),
    offer("offre-partenaire", "p1", "2026-10-16", "07:00", { network: { execution_id: null } }),
  ];

  it("à confirmer : réservations jointes aux offres (échéance de l'offre), offre arrivée après la lecture ; ordre de prise en charge", () => {
    const { toConfirm } = todoCards(unassigned, offers);
    expect(toConfirm.map((c) => [c.rideId, c.offerId, c.expiresAt])).toEqual([
      ["b5", "offre-gps", paris(TODAY, "09:05")],
      ["b1", "offre-b1", paris("2026-10-14", "07:15")],
      ["b9", "offre-neuve", paris("2026-10-16", "06:00")],
    ]);
    expect(toConfirm[2]).toMatchObject({ state: "to_confirm", customerName: null, customerPhone: null, number: 2001 });
  });

  it("non confirmées : à vérifier et non confirmées, puis refusées ; agenda illisible : offres seules", () => {
    expect(todoCards(unassigned, offers).unconfirmed.map((c) => [c.rideId, c.state])).toEqual([
      ["b2", "not_confirmed"], ["b4", "to_check"], ["b3", "declined"],
    ]);
    const fallback = todoCards(null, offers);
    expect(fallback.toConfirm.map((c) => c.offerId)).toEqual(["offre-b1", "offre-neuve"]);
    expect(fallback.unconfirmed).toEqual([]);
  });

  it("« dans 25 min », « dans 3 h », « demain », « dans 4 j », « il y a 2 h »", () => {
    expect(relativePickup(paris(TODAY, "09:25"), TZ, NOW)).toBe(`dans 25${NBSP}min`);
    expect(relativePickup(paris(TODAY, "12:10"), TZ, NOW)).toBe(`dans 3${NBSP}h`);
    expect(relativePickup(paris("2026-10-14", "02:00"), TZ, NOW)).toBe("demain");
    expect(relativePickup(paris("2026-10-14", "01:00"), TZ, Date.parse(paris(TODAY, "20:00")))).toBe(`dans 5${NBSP}h`);
    expect(relativePickup(paris("2026-10-14", "08:30"), TZ, NOW)).toBe("demain");
    expect(relativePickup(paris("2026-10-17", "08:30"), TZ, NOW)).toBe(`dans 4${NBSP}j`);
    expect(relativePickup(paris(TODAY, "07:00"), TZ, NOW)).toBe(`il y a 2${NBSP}h`);
    expect(relativePickup(paris(TODAY, "08:50"), TZ, NOW)).toBe(`il y a 10${NBSP}min`);
  });

  it("avertissements : catégorie ou places au-delà de son véhicule (montée en gamme permise)", () => {
    const business = { category: "business" as const, seats: 4 };
    expect(vehicleWarnings({ category: "van", passengers: 2 }, business)).toEqual([
      `Catégorie demandée${NBSP}: Van (votre véhicule${NBSP}: Business)`,
    ]);
    expect(vehicleWarnings({ category: "standard", passengers: 4 }, business)).toEqual([]);
    expect(vehicleWarnings({ category: "business", passengers: 6 }, business)).toEqual([`6${NBSP}passagers pour 4${NBSP}places`]);
    expect(vehicleWarnings({ category: "van", passengers: 9 }, null)).toEqual([]);
  });

  it("chevauchement avec une course confirmée seulement", () => {
    const rides = [
      entry("r7", "ACCEPTED", "2026-10-14", "08:00", { estimated_duration_s: 3600 }),
      entry("r8", "CANCELLED", "2026-10-14", "08:40"),
    ];
    const card = { rideId: "b1", pickupAt: paris("2026-10-14", "08:30"), estimatedDurationS: 1800 };
    expect(overlapWarning(card, rides, TZ)).toBe("Chevauche votre course 7 de 08:00");
    expect(overlapWarning({ ...card, pickupAt: paris("2026-10-14", "09:00") }, rides, TZ)).toBeNull();
  });

  it("carte à confirmer : heure, client, échéance, avertissements, lecteur d'écran", () => {
    const [card] = todoCards([booking("b1", "to_confirm", "2026-10-14", "08:30", { vehicle_category: "van" })], []).toConfirm;
    const rides = [entry("r7", "ACCEPTED", "2026-10-14", "08:15")];
    const v = todoCardView(card!, {
      tz: TZ, now: NOW, vehicle: { category: "business", seats: 4 }, rides, answerBefore: "Réponse avant demain 07:30",
    });
    expect(v).toMatchObject({
      stateLabel: "À confirmer", stateTone: "amber", muted: false, when: "Demain 08:30", relative: "demain",
      meta: `Réservation${NBSP}1 · 2${NBSP}passagers · 1${NBSP}bagage`, price: `85${NBSP}€`, customer: "Mme Durand",
      answerBefore: "Réponse avant demain 07:30", takeable: true,
    });
    expect(v.warnings).toEqual([`Catégorie demandée${NBSP}: Van (votre véhicule${NBSP}: Business)`, "Chevauche votre course 7 de 08:15"]);
    expect(v.a11y).toBe(
      `À confirmer, réservation 1, Demain 08:30, demain, Aéroport d'Orly vers Paris 8e, 2${NBSP}passagers · 1${NBSP}bagage, 85${NBSP}€, client Mme Durand, Réponse avant demain 07:30, Catégorie demandée${NBSP}: Van (votre véhicule${NBSP}: Business), Chevauche votre course 7 de 08:15`,
    );
  });

  it("refusée en retrait ; immédiate ; plus de 6 h après l'heure : plus prenable", () => {
    const ctx = { tz: TZ, now: NOW, vehicle: null, rides: [], answerBefore: null };
    const [declined] = todoCards([booking("b3", "declined", TODAY, "10:00")], []).unconfirmed;
    expect(todoCardView(declined!, ctx)).toMatchObject({ stateLabel: "Refusée", stateTone: "neutral", muted: true, answerBefore: null });
    const [instant] = todoCards([booking("b4", "not_confirmed", TODAY, "08:58", { type: "instant" })], []).unconfirmed;
    expect(todoCardView(instant!, ctx)).toMatchObject({ when: "Réservation immédiate", relative: null, stateTone: "red", takeable: true });
    const [old] = todoCards([booking("b5", "not_confirmed", "2026-10-13", "02:30")], []).unconfirmed;
    expect(todoCardView(old!, ctx).takeable).toBe(false);
  });

  it("refus : confirmation, la même dans l'agenda et l'écran d'offre (elle passe « Refusée », le site en est informé)", () => {
    expect(declineBookingPrompt(1042)).toEqual({
      title: `Refuser la réservation 1042${NBSP}?`,
      message: `Elle passera «${NBSP}Refusée${NBSP}» et votre site en sera informé.`,
      confirm: "Refuser",
    });
  });

  it("motif d'annulation : 3 à 280 caractères", () => {
    expect(cancelReasonError(" ab ")).toBe(`Indiquez le motif (3${NBSP}caractères au moins).`);
    expect(cancelReasonError("Client injoignable")).toBeNull();
    expect(cancelReasonError("x".repeat(281))).toBe(`280${NBSP}caractères au plus.`);
  });

  it("réservation prise : confirmée, enchaînée, déjà la sienne", () => {
    expect(takenText({ code: "ACCEPTED" })).toEqual({ title: "Réservation confirmée", message: "Ajoutée à votre agenda. Rappels programmés." });
    expect(takenText({ code: "ACCEPTED", chained: true }).message).toBe("Elle commencera après votre course en cours.");
    expect(takenText({ code: "UNCHANGED" }).title).toBe("Déjà dans votre agenda");
  });
});

describe("accueil (Flotte Privée)", () => {
  it("pastille de l'agenda : à confirmer + à traiter, ambre s'il y en a à traiter", () => {
    expect(agendaBadge(2, 0)).toEqual({ count: 2, alert: false, a11y: `Agenda, 2${NBSP}réservations à traiter` });
    expect(agendaBadge(1, 1)).toEqual({ count: 2, alert: true, a11y: `Agenda, 2${NBSP}réservations à traiter` });
    expect(agendaBadge(0, undefined)).toEqual({ count: 0, alert: false, a11y: "Agenda" });
  });

  it("ligne « À confirmer (n) », non confirmées en dessous ou seules", () => {
    expect(homeTodoLine(0, 0)).toBeNull();
    expect(homeTodoLine(2, null)).toEqual({ title: "À confirmer (2)", sub: null, alert: false });
    expect(homeTodoLine(1, 2)).toEqual({ title: "À confirmer (1)", sub: `2${NBSP}réservations non confirmées`, alert: true });
    expect(homeTodoLine(0, 1)).toEqual({ title: "Non confirmées (1)", sub: null, alert: true });
  });
});
