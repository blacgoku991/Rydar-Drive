import { fetchWindow } from "@rydar/shared";
import { describe, expect, it } from "vitest";
import {
  MONTH_CELL_ITEMS, TIMELINE_HOUR_PX, agendaHref, agendaParams, dayAriaLabel, dayTimeline, entriesByDay, entryAriaLabel, listDays, monthCells,
  nextEntryLink, periodLabel, rangeTitle, shiftPeriod, summaryLabel, toEntries, validDay, weekColumns, weekPhoneRuns, type AgendaRide,
} from "./agenda-model";

// Agenda du tableau de bord (docs/FLOTTE-PRIVEE.md § 7.3) : vues Mois, Semaine, Jour, Liste dans le fuseau de
// l'ORGANISATION, passage à l'heure d'hiver compris (dimanche 25 octobre 2026, Europe/Paris : 03:00 CEST → 02:00 CET,
// journée de 25 h).

const TZ = "Europe/Paris";
const NOW = Date.parse("2026-10-20T08:00:00Z");

let n = 0;
const ride = (pickup_at: string, over: Partial<AgendaRide> = {}): AgendaRide => ({
  id: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
  number: 1000 + n,
  type: "scheduled",
  status: "ACCEPTED",
  pickup_at,
  pickup_address: "Aéroport d'Orly, Terminal 4, 94390 Orly",
  dropoff_address: "12 Rue de Rivoli, 75004 Paris",
  customer_name: "M. Martin",
  price_cents: 8500,
  currency: "EUR",
  estimated_duration_s: 45 * 60,
  ...over,
});

describe("paramètres d'URL", () => {
  it("vue et date valides gardées ; date absente ou invalide : aujourd'hui ; vue inconnue : mois", () => {
    expect(agendaParams({ vue: "semaine", date: "2026-10-25" }, "2026-10-20")).toEqual({ view: "week", day: "2026-10-25" });
    expect(agendaParams({ vue: "liste" }, "2026-10-20")).toEqual({ view: "list", day: "2026-10-20" });
    expect(agendaParams({ vue: "annee", date: "2026-02-30" }, "2026-10-20")).toEqual({ view: "month", day: "2026-10-20" });
    expect(validDay("2028-02-29")).toBe("2028-02-29");
    expect(validDay("2026-02-29")).toBeNull();
    expect(validDay("25/10/2026")).toBeNull();
    expect(agendaHref("day", "2026-10-25")).toBe("/dashboard/agenda?vue=jour&date=2026-10-25");
  });

  it("période précédente / suivante : jour, semaine (lundi), mois (le 1er, changement d'année), liste (30 jours)", () => {
    expect(shiftPeriod("day", "2026-10-25", 1)).toBe("2026-10-26");
    expect(shiftPeriod("week", "2026-10-25", -1)).toBe("2026-10-12");
    expect(shiftPeriod("month", "2026-12-15", 1)).toBe("2027-01-01");
    expect(shiftPeriod("month", "2026-01-31", -1)).toBe("2025-12-01");
    expect(shiftPeriod("list", "2026-10-01", 1)).toBe("2026-10-31");
  });

  it("titres : jour, semaine, mois, liste (titre court des 30 jours, lisible sur téléphone)", () => {
    expect(periodLabel("day", "2026-10-25")).toBe("Dimanche 25 octobre");
    expect(periodLabel("week", "2026-10-25")).toBe("19 – 25 oct.");
    expect(periodLabel("month", "2026-10-25")).toBe("Octobre 2026");
    expect(periodLabel("list", "2026-10-25")).toBe("25 oct. – 23 nov.");
  });

  it("titre court d'une suite de jours : même mois, deux mois, deux années", () => {
    expect(rangeTitle("2026-10-10", "2026-10-16")).toBe("10 – 16 oct.");
    expect(rangeTitle("2026-09-28", "2026-10-04")).toBe("28 sept. – 4 oct.");
    expect(rangeTitle("2026-12-20", "2027-01-18")).toBe("20 déc. 2026 – 18 janv. 2027");
    expect(periodLabel("list", "2026-12-20")).toBe("20 déc. 2026 – 18 janv. 2027");
  });
});

describe("fuseau de l'organisation et passage à l'heure d'hiver", () => {
  // 25/10/2026 (Paris) : 00:30 CEST = 24/10 22:30 UTC ; 02:30 CEST = 00:30 UTC ; 02:30 CET = 01:30 UTC ; 23:30 CET = 22:30 UTC
  const before = ride("2026-10-24T22:30:00Z");
  const firstTwoThirty = ride("2026-10-25T00:30:00Z");
  const secondTwoThirty = ride("2026-10-25T01:30:00Z");
  const lateEvening = ride("2026-10-25T22:30:00Z");
  const nextDay = ride("2026-10-25T23:30:00Z");
  const entries = toEntries([nextDay, lateEvening, secondTwoThirty, firstTwoThirty, before], TZ, NOW);
  const byDay = entriesByDay(entries, TZ);

  it("regroupement par jour local (la journée de 25 h garde ses deux « 02:30 »), trié par heure", () => {
    expect(byDay["2026-10-25"]!.map((e) => e.time)).toEqual(["00:30", "02:30", "02:30", "23:30"]);
    expect(byDay["2026-10-26"]!.map((e) => e.time)).toEqual(["00:30"]);
    expect(byDay["2026-10-24"]).toBeUndefined();
  });

  it("un autre fuseau regroupe autrement (heure de New York)", () => {
    const ny = entriesByDay(entries, "America/New_York");
    expect(Object.keys(ny).sort()).toEqual(["2026-10-24", "2026-10-25"]);
  });

  it("semaine : du lundi 19 au dimanche 25 octobre, la course de 00:30 le 26 hors semaine", () => {
    const cols = weekColumns("2026-10-22", byDay, "2026-10-20", NOW);
    expect(cols.map((c) => c.day)).toEqual(["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25"]);
    expect(cols[6]!.entries).toHaveLength(4);
    expect(cols[6]!.heading).toBe("Dimanche 25 octobre");
    expect(cols[1]!.today).toBe(true);
  });

  it("frise du 25 : heure murale (les deux « 02:30 » côte à côte, signalées), début avant 6 h si besoin", () => {
    const t = dayTimeline(byDay["2026-10-25"]!, TZ);
    expect(t.startHour).toBe(0);
    expect(t.hours).toHaveLength(24);
    expect(t.height).toBe(24 * TIMELINE_HOUR_PX);
    const twoThirty = t.blocks.filter((b) => b.entry.time === "02:30");
    expect(twoThirty.map((b) => b.top)).toEqual([2.5 * TIMELINE_HOUR_PX, 2.5 * TIMELINE_HOUR_PX]);
    expect(twoThirty.map((b) => b.columns)).toEqual([2, 2]);
    expect(new Set(twoThirty.map((b) => b.column))).toEqual(new Set([0, 1]));
    expect(twoThirty.every((b) => b.overlap)).toBe(true);
    // 23:30, 45 min estimées : bloc jusqu'à minuit (jamais au-delà)
    const late = t.blocks.find((b) => b.entry.time === "23:30")!;
    expect(late.top).toBe(23.5 * TIMELINE_HOUR_PX);
    expect(late.height).toBe(0.5 * TIMELINE_HOUR_PX);
    expect(late.overlap).toBe(false);
  });

  it("frise sans course avant 6 h : commence à 6 h ; hauteur selon la durée estimée (30 min au moins)", () => {
    const day = entriesByDay(
      toEntries([ride("2026-10-20T06:00:00Z", { estimated_duration_s: 90 * 60 }), ride("2026-10-20T13:00:00Z", { estimated_duration_s: null })], TZ, NOW),
      TZ,
    )["2026-10-20"]!;
    const t = dayTimeline(day, TZ);
    expect(t.startHour).toBe(6);
    expect(t.hours[0]).toBe(6);
    expect(t.blocks[0]!.top).toBe(2 * TIMELINE_HOUR_PX); // 08:00 locale (UTC+2)
    expect(t.blocks[0]!.height).toBe(1.5 * TIMELINE_HOUR_PX);
    expect(t.blocks[1]!.height).toBe(0.5 * TIMELINE_HOUR_PX);
  });

  it("fenêtre de lecture : marge d'un jour de chaque côté (couvre tout fuseau)", () => {
    expect(fetchWindow("day", "2026-10-25")).toEqual({ from: "2026-10-24T00:00:00.000Z", to: "2026-10-27T00:00:00.000Z" });
  });
});

describe("mois", () => {
  it("grille de 42 jours commençant le lundi, jours hors du mois signalés, 3 courses par case puis « +N »", () => {
    const many = ["06:00", "08:00", "10:00", "12:00", "14:00"].map((t) => ride(`2026-10-14T${t}:00Z`));
    const byDay = entriesByDay(toEntries(many, TZ, NOW), TZ);
    const cells = monthCells("2026-10-14", byDay, "2026-10-20", NOW);
    expect(cells).toHaveLength(42);
    expect(cells[0]!.day).toBe("2026-09-28");
    expect(cells[0]!.inMonth).toBe(false);
    const d14 = cells.find((c) => c.day === "2026-10-14")!;
    expect(d14.entries).toHaveLength(MONTH_CELL_ITEMS);
    expect(d14.more).toBe(2);
    expect(d14.summary).toEqual({ count: 5, totalCents: 42500, toConfirm: 0, unconfirmed: 0 });
    expect(cells.find((c) => c.day === "2026-10-20")!.today).toBe(true);
  });

  it("mois commençant un dimanche (novembre 2026) : la grille commence le lundi 26 octobre", () => {
    expect(monthCells("2026-11-10", {}, "2026-10-20", NOW)[0]!.day).toBe("2026-10-26");
  });

  it("lien « +N » : nom accessible qui dit le jour (et commence par le texte visible) ; aucun sans « +N »", () => {
    const rides = (day: string, n: number) => ["06:00", "08:00", "10:00", "12:00", "14:00"].slice(0, n).map((t) => ride(`${day}T${t}:00Z`));
    const byDay = entriesByDay(toEntries([...rides("2026-10-14", 5), ...rides("2026-10-15", 4), ...rides("2026-10-16", 3)], TZ, NOW), TZ);
    const cells = monthCells("2026-10-14", byDay, "2026-10-20", NOW);
    const cell = (day: string) => cells.find((c) => c.day === day)!;
    expect(cell("2026-10-14").moreLabel).toBe("+2 autres courses, mercredi 14 octobre");
    expect(cell("2026-10-15").moreLabel).toBe("+1 autre course, jeudi 15 octobre");
    expect(cell("2026-10-15").moreLabel!.startsWith(`+${cell("2026-10-15").more}`)).toBe(true);
    // Deux cases du mois n'ont jamais le même nom de lien
    const labels = cells.map((c) => c.moreLabel).filter(Boolean);
    expect(new Set(labels).size).toBe(labels.length);
    expect(cell("2026-10-16").moreLabel).toBeNull();
    expect(cell("2026-10-20").moreLabel).toBeNull();
    expect(cell("2026-10-14").title).toBe("mercredi 14 octobre");
  });

  it("liens des courses (mois, semaine) : texte visible, puis le jour et l'état", () => {
    const [entry] = toEntries([ride("2026-10-21T08:00:00Z", { status: "OFFERED", state: "to_confirm" })], TZ, NOW);
    const cell = monthCells("2026-10-21", entriesByDay([entry!], TZ), "2026-10-20", NOW).find((c) => c.day === "2026-10-21")!;
    expect(entryAriaLabel(cell.entries[0]!, cell.title)).toBe("10:00 Aéroport d'Orly → 12 Rue de Rivoli, mercredi 21 octobre, À confirmer");
    const column = weekColumns("2026-10-21", entriesByDay([entry!], TZ), "2026-10-20", NOW).find((c) => c.day === "2026-10-21")!;
    expect(column.title).toBe("mercredi 21 octobre");
    expect(column.heading).toBe("Mercredi 21 octobre");
    expect(entryAriaLabel(column.entries[0]!, column.title)).toBe(entryAriaLabel(cell.entries[0]!, cell.title));
  });
});

describe("catégories, résumés et textes", () => {
  it("couleur = information : à confirmer, non confirmée, confirmée, en cours, terminée, annulée, heure dépassée", () => {
    const e = toEntries(
      [
        ride("2026-10-21T08:00:00Z", { status: "OFFERED", state: "to_confirm" }),
        ride("2026-10-21T09:00:00Z", { status: "NO_DRIVER_FOUND", state: "not_confirmed" }),
        ride("2026-10-21T10:00:00Z"),
        ride("2026-10-21T11:00:00Z", { status: "IN_PROGRESS" }),
        ride("2026-10-21T12:00:00Z", { status: "COMPLETED" }),
        ride("2026-10-21T13:00:00Z", { status: "CANCELLED" }),
        ride("2026-10-19T08:00:00Z"),
      ],
      TZ,
      NOW,
    );
    expect(e.map((x) => [x.label, x.tone])).toEqual([
      ["À confirmer", "amber"],
      ["Non confirmée", "red"],
      ["Confirmée", "violet"],
      ["En cours", "cyan"],
      ["Terminée", "green"],
      ["Annulée", "neutral"],
      ["Heure dépassée", "amber"],
    ]);
    expect(e[0]!.route).toBe("Aéroport d'Orly → 12 Rue de Rivoli");
  });

  it("résumé d'un jour (annulées exclues) et texte du lecteur d'écran", () => {
    const e = toEntries(
      [ride("2026-10-21T08:00:00Z", { status: "OFFERED", state: "to_confirm" }), ride("2026-10-21T10:00:00Z"), ride("2026-10-21T12:00:00Z", { status: "CANCELLED" })],
      TZ,
      NOW,
    );
    const cell = monthCells("2026-10-21", entriesByDay(e, TZ), "2026-10-20", NOW).find((c) => c.day === "2026-10-21")!;
    expect(summaryLabel(cell.summary)).toBe("2\u00a0courses · 170\u00a0€");
    expect(cell.ariaLabel).toBe("mercredi 21 octobre, 2\u00a0courses dont 1 à confirmer");
    expect(dayAriaLabel("2026-10-22", { count: 0, totalCents: 0, toConfirm: 0, unconfirmed: 0 })).toBe("jeudi 22 octobre, aucune course");
    expect(summaryLabel({ count: 0, totalCents: 0, toConfirm: 0, unconfirmed: 0 })).toBeNull();
  });

  it("liste : jours avec des courses seulement, « Aujourd'hui », « Demain », puis la date", () => {
    const e = toEntries([ride("2026-10-20T10:00:00Z"), ride("2026-10-21T10:00:00Z"), ride("2026-10-24T10:00:00Z"), ride("2026-12-24T10:00:00Z")], TZ, NOW);
    const days = listDays("2026-10-20", entriesByDay(e, TZ), "2026-10-20", NOW);
    expect(days.map((d) => d.heading)).toEqual(["Aujourd'hui", "Demain", "Samedi 24 octobre"]);
  });
});

describe("deux vocabulaires : « course » (flottes, centrales) et « réservation » (Flotte Privée)", () => {
  const e = toEntries(
    [ride("2026-10-21T08:00:00Z", { status: "OFFERED", state: "to_confirm" }), ride("2026-10-21T10:00:00Z"), ride("2026-10-21T12:00:00Z", { status: "CANCELLED" })],
    TZ,
    NOW,
  );
  const byDay = entriesByDay(e, TZ);

  it("résumé d'un jour et texte du lecteur d'écran : « réservations » seulement en Flotte Privée", () => {
    const course = monthCells("2026-10-21", byDay, "2026-10-20", NOW).find((c) => c.day === "2026-10-21")!;
    const booking = monthCells("2026-10-21", byDay, "2026-10-20", NOW, "booking").find((c) => c.day === "2026-10-21")!;
    expect(summaryLabel(course.summary)).toBe("2\u00a0courses · 170\u00a0€");
    expect(summaryLabel(booking.summary, "EUR", "booking")).toBe("2\u00a0réservations · 170\u00a0€");
    expect(course.ariaLabel).toBe("mercredi 21 octobre, 2\u00a0courses dont 1 à confirmer");
    expect(booking.ariaLabel).toBe("mercredi 21 octobre, 2\u00a0réservations dont 1 à confirmer");
    expect(dayAriaLabel("2026-10-22", { count: 0, totalCents: 0, toConfirm: 0, unconfirmed: 0 }, "booking")).toBe("jeudi 22 octobre, aucune réservation");
    expect(dayAriaLabel("2026-10-22", { count: 1, totalCents: 0, toConfirm: 0, unconfirmed: 0 }, "booking")).toBe("jeudi 22 octobre, 1\u00a0réservation");
  });

  it("« +N » du mois et colonnes de la semaine dans le vocabulaire du profil", () => {
    const many = ["06:00", "08:00", "10:00", "12:00", "14:00"].map((t) => ride(`2026-10-14T${t}:00Z`));
    const days = entriesByDay(toEntries(many, TZ, NOW), TZ);
    expect(monthCells("2026-10-14", days, "2026-10-20", NOW, "booking").find((c) => c.day === "2026-10-14")!.moreLabel).toBe(
      "+2\u00a0autres réservations, mercredi 14 octobre",
    );
    expect(monthCells("2026-10-14", days, "2026-10-20", NOW).find((c) => c.day === "2026-10-14")!.moreLabel).toBe("+2\u00a0autres courses, mercredi 14 octobre");
    const col = weekColumns("2026-10-14", days, "2026-10-20", NOW, "booking").find((c) => c.day === "2026-10-14")!;
    expect(col.ariaLabel).toBe("mercredi 14 octobre, 5\u00a0réservations");
    expect(weekColumns("2026-10-14", days, "2026-10-20", NOW).find((c) => c.day === "2026-10-14")!.ariaLabel).toBe("mercredi 14 octobre, 5\u00a0courses");
  });

  it("jour vide : lien « Prochaine réservation : demain 08:30 » vers la vue Jour de ce jour-là (« course » ailleurs)", () => {
    // NOW : mardi 20 octobre 10:00 à Paris ; 21/10 06:30 UTC = 08:30 à Paris
    expect(nextEntryLink("2026-10-21T06:30:00Z", TZ, NOW, "booking")).toEqual({
      label: "Prochaine réservation\u00a0: demain 08:30",
      href: "/dashboard/agenda?vue=jour&date=2026-10-21",
    });
    expect(nextEntryLink("2026-10-22T06:30:00Z", TZ, NOW).label).toBe("Prochaine course\u00a0: jeu. 22/10 08:30");
    // Le jour suit le fuseau de l'organisation (23:30 à Paris le 25 = 21:30 UTC)
    expect(nextEntryLink("2026-10-25T22:30:00Z", TZ, NOW).href).toBe("/dashboard/agenda?vue=jour&date=2026-10-25");
  });
});

describe("semaine sur téléphone : jours vides consécutifs regroupés", () => {
  const show = (runs: ReturnType<typeof weekPhoneRuns>) => runs.map((r) => (r ? (r.start ? r.label : "…") : null));

  it("« lun. 19 – mer. 21 : rien de prévu » ; un jour avec des courses garde sa carte", () => {
    const e = toEntries([ride("2026-10-22T08:00:00Z"), ride("2026-10-25T08:00:00Z")], TZ, NOW);
    // Semaine du lundi 19 au dimanche 25 ; aujourd'hui = jeudi 22 (avec une course)
    const cols = weekColumns("2026-10-22", entriesByDay(e, TZ), "2026-10-22", NOW);
    expect(show(weekPhoneRuns(cols))).toEqual([
      "lun. 19 – mer. 21\u00a0: rien de prévu", "…", "…", null, "ven. 23 – sam. 24\u00a0: rien de prévu", "…", null,
    ]);
  });

  it("aujourd'hui vide garde sa carte ; un jour vide seul a sa propre ligne", () => {
    // Aucune course, aujourd'hui = mercredi 21
    expect(show(weekPhoneRuns(weekColumns("2026-10-22", {}, "2026-10-21", NOW)))).toEqual([
      "lun. 19 – mar. 20\u00a0: rien de prévu", "…", null, "jeu. 22 – dim. 25\u00a0: rien de prévu", "…", "…", "…",
    ]);
    // Courses les 19, 21, 23 et 25 : les 20, 22 et 24 sont des jours vides isolés
    const e = toEntries(["19", "21", "23", "25"].map((d) => ride(`2026-10-${d}T08:00:00Z`)), TZ, NOW);
    expect(show(weekPhoneRuns(weekColumns("2026-10-22", entriesByDay(e, TZ), "2026-10-19", NOW)))).toEqual([
      null, "mar. 20\u00a0: rien de prévu", null, "jeu. 22\u00a0: rien de prévu", null, "sam. 24\u00a0: rien de prévu", null,
    ]);
  });
});
