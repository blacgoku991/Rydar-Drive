// Agenda (Liste, Jour, Semaine, Mois) : jours civils, grilles, fenêtre de lecture, regroupement par jour local (fuseau
// de l'organisation, passage à l'heure d'hiver), frise d'une journée, catégories et titres.
import { describe, expect, it } from "vitest";
import {
  addDays, AGENDA_KIND_META, AGENDA_KINDS, AGENDA_LIST_DAYS, AGENDA_VIEW_PARAMS, AGENDA_VIEWS, agendaKind,
  agendaViewFromParam, dayHeading, dayLayout, daySummary, dayTitle, fetchWindow, groupByDay, isoWeekday, minutesOfDay,
  monthGrid, monthTitle, overlaps, rideInterval, viewRange, weekStart, weekTitle, type AgendaItem,
} from "./agenda";
import { RIDE_STATUSES, type RideStatus } from "./domain";
import { PRIVATE_FLEET_AGENDA_MAX_DAYS, PRIVATE_FLEET_BOOKING_STATES } from "./private-fleet";

const DAY = 86_400_000;
const PARIS = "Europe/Paris";

describe("jours civils et grilles", () => {
  it("addDays, jour de la semaine ISO, lundi de la semaine", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(isoWeekday("2026-10-12")).toBe(1);
    expect(isoWeekday("2026-10-18")).toBe(7);
    expect(weekStart("2026-10-14")).toBe("2026-10-12");
    expect(weekStart("2026-10-12")).toBe("2026-10-12");
    expect(weekStart("2026-10-18")).toBe("2026-10-12");
  });

  it("grille de mois : 42 jours, commence le lundi (octobre 2026 : le 1er est un jeudi)", () => {
    const grid = monthGrid("2026-10-14");
    expect(grid).toHaveLength(42);
    expect(grid[0]).toBe("2026-09-28");
    expect(grid[3]).toBe("2026-10-01");
    expect(grid[41]).toBe("2026-11-08");
    grid.forEach((day, i) => expect(isoWeekday(day), day).toBe((i % 7) + 1));
    expect(new Set(grid).size).toBe(42);
  });

  it("mois commençant un dimanche (novembre 2026) : le 1er en dernière colonne de la première ligne", () => {
    const grid = monthGrid("2026-11-20");
    expect(grid[0]).toBe("2026-10-26");
    expect(grid[6]).toBe("2026-11-01");
    expect(grid[41]).toBe("2026-12-06");
    expect(grid.filter((d) => d.startsWith("2026-11"))).toHaveLength(30);
  });

  it("février bissextile (2028) : 29 jours", () => {
    const grid = monthGrid("2028-02-10");
    expect(grid[0]).toBe("2028-01-31");
    expect(grid.filter((d) => d.startsWith("2028-02"))).toHaveLength(29);
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2028-02-29", 1)).toBe("2028-03-01");
  });
});

describe("période affichée et fenêtre de lecture", () => {
  it("jours de chaque vue", () => {
    expect(viewRange("day", "2026-10-14")).toEqual({ from: "2026-10-14", to: "2026-10-15" });
    expect(viewRange("week", "2026-10-14")).toEqual({ from: "2026-10-12", to: "2026-10-19" });
    expect(viewRange("month", "2026-10-14")).toEqual({ from: "2026-09-28", to: "2026-11-09" });
    expect(viewRange("list", "2026-10-14")).toEqual({ from: "2026-10-14", to: addDays("2026-10-14", AGENDA_LIST_DAYS) });
  });

  it("fenêtre : jours de la vue ± 1 jour en UTC, 44 jours au plus (borne SQL : 62)", () => {
    expect(fetchWindow("week", "2026-10-14")).toEqual({ from: "2026-10-11T00:00:00.000Z", to: "2026-10-20T00:00:00.000Z" });
    let longest = 0;
    for (let i = 0; i < 800; i++) {
      const day = addDays("2026-01-01", i);
      for (const view of AGENDA_VIEWS) {
        const w = fetchWindow(view, day);
        const days = (Date.parse(w.to) - Date.parse(w.from)) / DAY;
        longest = Math.max(longest, days);
        // couvre minuit local du premier jour et du lendemain du dernier jour, à UTC+14 comme à UTC−12
        const range = viewRange(view, day);
        expect(Date.parse(w.from)).toBeLessThanOrEqual(Date.parse(`${range.from}T00:00:00Z`) - 14 * 3_600_000);
        expect(Date.parse(w.to)).toBeGreaterThanOrEqual(Date.parse(`${range.to}T00:00:00Z`) + 12 * 3_600_000);
      }
    }
    expect(longest).toBe(44);
    expect(longest).toBeLessThanOrEqual(PRIVATE_FLEET_AGENDA_MAX_DAYS);
  });

  it("paramètre d'URL du web (?vue=)", () => {
    for (const view of AGENDA_VIEWS) expect(agendaViewFromParam(AGENDA_VIEW_PARAMS[view], "list")).toBe(view);
    expect(agendaViewFromParam("mois", "list")).toBe("month");
    expect(agendaViewFromParam(null, "month")).toBe("month");
    expect(agendaViewFromParam("year", "list")).toBe("list");
  });
});

describe("regroupement par jour local", () => {
  it("près de minuit (heure d'été, Paris) et dans un autre fuseau ; tri par heure de prise en charge", () => {
    const rides = [
      { id: "c", pickup_at: "2026-07-14T22:01:00Z" }, // 00:01 le 15/07 à Paris
      { id: "a", pickup_at: "2026-07-14T21:59:00Z" }, // 23:59 le 14/07
      { id: "b", pickup_at: "2026-07-14T06:00:00Z" }, // 08:00 le 14/07
    ];
    const paris = groupByDay(rides, PARIS);
    expect(Object.keys(paris).sort()).toEqual(["2026-07-14", "2026-07-15"]);
    expect(paris["2026-07-14"]!.map((r) => r.id)).toEqual(["b", "a"]);
    expect(paris["2026-07-15"]!.map((r) => r.id)).toEqual(["c"]);
    const newYork = groupByDay(rides, "America/New_York");
    expect(Object.keys(newYork)).toEqual(["2026-07-14"]);
    expect(newYork["2026-07-14"]!.map((r) => r.id)).toEqual(["b", "a", "c"]);
  });

  it("semaine du passage à l'heure d'hiver (25/10/2026, Paris) : journée de 25 h, 02:30 deux fois", () => {
    expect(weekStart("2026-10-25")).toBe("2026-10-19");
    expect(weekTitle("2026-10-25")).toBe("19 – 25 oct.");
    const rides = [
      { id: "veille", pickup_at: "2026-10-24T21:59:00Z" }, // 23:59 (UTC+2) le 24/10
      { id: "minuit", pickup_at: "2026-10-24T22:00:00Z" }, // 00:00 (UTC+2) le 25/10
      { id: "deux-trente-ete", pickup_at: "2026-10-25T00:30:00Z" }, // 02:30 (UTC+2)
      { id: "deux-trente-hiver", pickup_at: "2026-10-25T01:30:00Z" }, // 02:30 (UTC+1)
      { id: "soir", pickup_at: "2026-10-25T22:59:00Z" }, // 23:59 (UTC+1), 24 h 59 après minuit
      { id: "lendemain", pickup_at: "2026-10-25T23:00:00Z" }, // 00:00 (UTC+1) le 26/10
    ];
    const days = groupByDay(rides, PARIS);
    expect(days["2026-10-24"]!.map((r) => r.id)).toEqual(["veille"]);
    expect(days["2026-10-25"]!.map((r) => r.id)).toEqual(["minuit", "deux-trente-ete", "deux-trente-hiver", "soir"]);
    expect(days["2026-10-26"]!.map((r) => r.id)).toEqual(["lendemain"]);
    expect(minutesOfDay("2026-10-25T00:30:00Z", PARIS)).toBe(150);
    expect(minutesOfDay("2026-10-25T01:30:00Z", PARIS)).toBe(150);
    expect(minutesOfDay("2026-10-25T22:59:00Z", PARIS)).toBe(1439);
    expect(minutesOfDay("2026-10-24T22:00:00Z", PARIS)).toBe(0);
    // Tous les instants de la semaine sont dans sa fenêtre de lecture
    const w = fetchWindow("week", "2026-10-25");
    for (const r of rides) {
      expect(Date.parse(r.pickup_at)).toBeGreaterThanOrEqual(Date.parse(w.from));
      expect(Date.parse(r.pickup_at)).toBeLessThan(Date.parse(w.to));
    }
  });
});

describe("frise d'une journée et chevauchements", () => {
  it("blocs à l'heure locale, 30 min au moins, colonnes des chevauchements, jamais au-delà de minuit", () => {
    const blocks = dayLayout(
      [
        { id: "c", pickup_at: "2026-10-14T07:00:00Z", estimated_duration_s: null }, // 09:00, 30 min
        { id: "a", pickup_at: "2026-10-14T06:00:00Z", estimated_duration_s: 3600 }, // 08:00 → 09:00
        { id: "b", pickup_at: "2026-10-14T06:30:00Z", estimated_duration_s: 600 }, // 08:30 → 09:00 (30 min au moins)
        { id: "d", pickup_at: "2026-10-14T20:00:00Z", estimated_duration_s: 3 * 3600 }, // 22:00 → minuit
      ],
      PARIS,
    );
    const by = Object.fromEntries(blocks.map((b) => [b.item.id, b]));
    expect(blocks.map((b) => b.item.id)).toEqual(["a", "b", "c", "d"]);
    expect(by.a).toMatchObject({ start: 480, end: 540, column: 0, columns: 2, overlap: true });
    expect(by.b).toMatchObject({ start: 510, end: 540, column: 1, columns: 2, overlap: true });
    // commence quand les autres finissent : aucun chevauchement
    expect(by.c).toMatchObject({ start: 540, end: 570, column: 0, columns: 1, overlap: false });
    expect(by.d).toMatchObject({ start: 1320, end: 1440, columns: 1, overlap: false });
  });

  it("une colonne libérée est réutilisée dans un même groupe", () => {
    const blocks = dayLayout(
      [
        { id: "long", pickup_at: "2026-10-14T06:00:00Z", estimated_duration_s: 3 * 3600 }, // 08:00 → 11:00
        { id: "x", pickup_at: "2026-10-14T06:30:00Z", estimated_duration_s: 1800 }, // 08:30 → 09:00
        { id: "y", pickup_at: "2026-10-14T07:30:00Z", estimated_duration_s: 1800 }, // 09:30 → 10:00
      ],
      PARIS,
    );
    expect(blocks.map((b) => [b.item.id, b.column, b.columns])).toEqual([["long", 0, 2], ["x", 1, 2], ["y", 1, 2]]);
  });

  it("overlaps : durée estimée, 30 min au moins", () => {
    const a = { pickup_at: "2026-10-14T06:00:00Z", estimated_duration_s: 3600 };
    expect(overlaps(a, { pickup_at: "2026-10-14T06:59:00Z" })).toBe(true);
    expect(overlaps(a, { pickup_at: "2026-10-14T07:00:00Z" })).toBe(false);
    expect(overlaps({ pickup_at: "2026-10-14T06:00:00Z" }, { pickup_at: "2026-10-14T06:29:00Z", estimated_duration_s: 60 })).toBe(true);
    expect(overlaps({ pickup_at: "2026-10-14T06:00:00Z" }, { pickup_at: "2026-10-14T06:30:00Z" })).toBe(false);
    expect(rideInterval({ pickup_at: "2026-10-14T06:00:00Z", estimated_duration_s: 0 })).toEqual({
      start: Date.parse("2026-10-14T06:00:00Z"), end: Date.parse("2026-10-14T06:30:00Z"),
    });
  });
});

describe("catégories d'affichage", () => {
  const NOW = Date.parse("2026-10-14T10:00:00Z");
  const item = (status: RideStatus, extra: Partial<AgendaItem> = {}): AgendaItem => ({
    status, type: "scheduled", pickup_at: "2026-10-14T12:00:00Z", ...extra,
  });

  it("agendaKind pour chaque statut", () => {
    const expected: Record<RideStatus, string> = {
      CREATED: "to_confirm",
      SEARCHING_DRIVER: "to_confirm",
      OFFERED: "to_confirm",
      ACCEPTED: "confirmed",
      DRIVER_EN_ROUTE: "ongoing",
      DRIVER_ARRIVED: "ongoing",
      PASSENGER_ONBOARD: "ongoing",
      IN_PROGRESS: "ongoing",
      COMPLETED: "completed",
      CANCELLED: "cancelled",
      NO_DRIVER_FOUND: "not_confirmed",
    };
    for (const status of RIDE_STATUSES) expect(agendaKind(item(status), NOW), status).toBe(expected[status]);
  });

  it("heure dépassée (planifiée acceptée non démarrée), état d'une réservation à traiter", () => {
    expect(agendaKind(item("ACCEPTED", { pickup_at: "2026-10-14T09:00:00Z" }), NOW)).toBe("overdue");
    expect(agendaKind(item("ACCEPTED", { type: "instant", pickup_at: "2026-10-14T09:00:00Z" }), NOW)).toBe("confirmed");
    for (const state of PRIVATE_FLEET_BOOKING_STATES) {
      expect(agendaKind(item("SEARCHING_DRIVER", { state }), NOW)).toBe(state);
      expect(agendaKind(item("NO_DRIVER_FOUND", { state }), NOW)).toBe(state);
    }
    // État périmé d'une course déjà attribuée : son statut l'emporte
    expect(agendaKind(item("ACCEPTED", { state: "to_confirm" }), NOW)).toBe("confirmed");
  });

  it("chaque catégorie a un libellé et un ton (couleur = information)", () => {
    expect(Object.keys(AGENDA_KIND_META).sort()).toEqual([...AGENDA_KINDS].sort());
    expect(AGENDA_KIND_META.not_confirmed.tone).toBe("red");
    expect(AGENDA_KIND_META.to_confirm.tone).toBe("amber");
    expect(AGENDA_KIND_META.overdue.tone).toBe("amber");
    expect(AGENDA_KIND_META.confirmed.tone).toBe("violet");
    expect(AGENDA_KIND_META.ongoing.tone).toBe("cyan");
    expect(AGENDA_KIND_META.cancelled.tone).toBe("neutral");
    expect(AGENDA_KIND_META.declined.label).toBe("Refusée");
  });

  it("résumé d'un jour : annulées et refusées exclues", () => {
    const summary = daySummary(
      [
        { ...item("ACCEPTED"), price_cents: 8500 },
        { ...item("OFFERED"), price_cents: 12000 },
        { ...item("NO_DRIVER_FOUND"), price_cents: 4000 },
        { ...item("SEARCHING_DRIVER", { state: "to_check" }), price_cents: null },
        { ...item("CANCELLED"), price_cents: 9900 },
        { ...item("NO_DRIVER_FOUND", { state: "declined" }), price_cents: 5000 },
      ],
      NOW,
    );
    expect(summary).toEqual({ count: 4, totalCents: 24500, toConfirm: 1, unconfirmed: 2 });
  });
});

describe("titres", () => {
  it("jour, semaine (même mois, deux mois, deux années), mois ; en-têtes de la liste", () => {
    expect(dayTitle("2026-10-14")).toBe("mercredi 14 octobre");
    expect(weekTitle("2026-10-14")).toBe("12 – 18 oct.");
    expect(weekTitle("2026-10-01")).toBe("28 sept. – 4 oct.");
    expect(weekTitle("2026-12-30")).toBe("28 déc. 2026 – 3 janv. 2027");
    expect(monthTitle("2026-10-14")).toBe("octobre 2026");
    expect(dayHeading("2026-10-14", "2026-10-14")).toBe("Aujourd'hui");
    expect(dayHeading("2026-10-15", "2026-10-14")).toBe("Demain");
    expect(dayHeading("2026-10-16", "2026-10-14")).toBe("vendredi 16 octobre");
  });
});
