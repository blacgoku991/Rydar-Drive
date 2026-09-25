import { describe, expect, it, vi } from "vitest";
import { aerodataboxProvider, aerodataboxRequest, parseAeroDataBox } from "./aerodatabox";
import { aviationstackUrl, parseAviationstack } from "./aviationstack";
import { flightawareUrl, parseFlightAware } from "./flightaware";
import { selectFlightProvider, withCache } from "./index";
import { APPLY_FLIGHT_SQL, FLIGHTS_TO_CHECK_SQL, flightJob, mapLimit, type FlightRow, type QueryFn } from "./job";
import { mockProvider, parseMockDelays } from "./mock";
import { AERODATABOX_ARRIVED, AERODATABOX_MULTI_LEG, AVIATIONSTACK_EK73, AVIATIONSTACK_ERROR, FLIGHTAWARE_AF1234 } from "./samples";
import {
  airportFromAddress,
  FlightProviderError,
  normalizeInfo,
  normalizeStatus,
  normalizeTerminal,
  terminalFromAddress,
  toIso,
  wallTimeToIso,
  type FlightInfo,
  type FlightProvider,
} from "./types";

const MIN = 60_000;
const at = (iso: string) => Date.parse(iso);

describe("vols — normalisation", () => {
  it("statuts des trois fournisseurs → vocabulaire Rydar", () => {
    const cases: Record<string, string> = {
      Expected: "scheduled", CheckIn: "scheduled", Boarding: "scheduled", GateClosed: "scheduled", Delayed: "delayed",
      EnRoute: "departed", Departed: "departed", Approaching: "departed", Arrived: "landed", Canceled: "cancelled",
      CanceledUncertain: "unknown", Diverted: "diverted", Unknown: "unknown",
      scheduled: "scheduled", active: "departed", landed: "landed", cancelled: "cancelled", incident: "unknown", diverted: "diverted",
      "Scheduled / Delayed": "delayed", "En Route / On Time": "departed", "Taxiing / Left Gate": "departed", "Landed / Taxiing": "landed",
      "Arrived / Gate Arrival": "landed", "": "unknown",
    };
    for (const [raw, want] of Object.entries(cases)) expect(normalizeStatus(raw), raw).toBe(want);
  });

  it("heures : format AeroDataBox, ISO, heure murale dans un fuseau (heure d'été / d'hiver)", () => {
    expect(toIso("2026-09-25 13:05Z")).toBe("2026-09-25T13:05:00.000Z");
    expect(toIso("2026-09-25 15:05+02:00")).toBe("2026-09-25T13:05:00.000Z");
    expect(toIso("pas une date")).toBeNull();
    expect(toIso(null)).toBeNull();
    expect(wallTimeToIso("2026-09-25T14:25:00+00:00", "Europe/Paris")).toBe("2026-09-25T12:25:00.000Z");
    expect(wallTimeToIso("2026-12-25T14:25:00+00:00", "Europe/Paris")).toBe("2026-12-25T13:25:00.000Z");
    expect(wallTimeToIso("2026-09-25T09:40:00+00:00", "Asia/Dubai")).toBe("2026-09-25T05:40:00.000Z");
    expect(wallTimeToIso("2026-03-29T03:30:00", "Europe/Paris")).toBe("2026-03-29T01:30:00.000Z"); // juste après le passage à l'heure d'été
    expect(wallTimeToIso("2026-09-25T14:25:00", null)).toBe("2026-09-25T14:25:00.000Z");
  });

  it("terminal, aéroport reconnu dans l'adresse", () => {
    expect(normalizeTerminal("T2E")).toBe("2E");
    expect(normalizeTerminal("Terminal 2f")).toBe("2F");
    expect(normalizeTerminal("  ")).toBeNull();
    expect(airportFromAddress("Aéroport Paris-Charles de Gaulle, Terminal 2E, 95700 Roissy-en-France")).toBe("CDG");
    expect(airportFromAddress("Aéroport de Paris-Orly, Terminal 4, 94390 Orly")).toBe("ORY");
    expect(airportFromAddress("Aéroport de Beauvais-Tillé")).toBe("BVA");
    expect(airportFromAddress("Gare de Lyon, Paris")).toBeNull();
    expect(terminalFromAddress("Aéroport Paris-Charles de Gaulle, Terminal 2E, 95700 Roissy")).toBe("2E");
    expect(terminalFromAddress("Orly T4")).toBe("4");
    expect(terminalFromAddress("Gare du Nord")).toBeNull();
  });

  it("heure réelle connue → atterri (arrivée) / parti (départ) ; champs nettoyés", () => {
    const raw: FlightInfo = { status: "scheduled", scheduled: "2026-09-25 13:05Z", estimated: "x", actual: "2026-09-25 13:31Z", terminal: "T2F", origin: "a".repeat(80) };
    expect(normalizeInfo(raw, "arrival")).toEqual({
      status: "landed", scheduled: "2026-09-25T13:05:00.000Z", estimated: null, actual: "2026-09-25T13:31:00.000Z", terminal: "2F", origin: "a".repeat(60),
    });
    expect(normalizeInfo(raw, "departure").status).toBe("departed");
    expect(normalizeInfo({ ...raw, status: "cancelled" }, "arrival").status).toBe("cancelled");
  });
});

describe("vols — fournisseur mock", () => {
  const T0 = at("2026-09-25T15:00:00Z"); // prise en charge demandée

  it("FLIGHT_MOCK_DELAYS : retards, avance, annulation, déroutement", () => {
    expect(parseMockDelays("AF1234=35,EK073=-10, ba 304=annulé;LH1=diverted,XX=abc")).toEqual({ AF1234: 35, EK073: -10, BA304: "cancelled", LH1: "diverted" });
    expect(parseMockDelays("BA304=cancelled")).toEqual({ BA304: "cancelled" });
    expect(parseMockDelays(undefined)).toEqual({});
  });

  it("horaire prévu déduit de la prise en charge (− marge), retard imposé, déterministe", async () => {
    const now = T0 - 2 * 3600_000;
    const p = mockProvider({ delays: { AF1234: 35 }, now: () => now });
    const ctx = { mode: "arrival" as const, requestedAt: new Date(T0).toISOString(), bufferMinutes: 15, airportAddress: "Aéroport Paris-Charles de Gaulle, Terminal 2E" };
    const a = await p.getFlightStatus("AF1234", "2026-09-25", ctx);
    expect(a).toEqual({
      status: "delayed",
      scheduled: "2026-09-25T14:45:00.000Z",
      estimated: "2026-09-25T15:20:00.000Z",
      actual: null,
      terminal: "2E",
      origin: expect.any(String),
    });
    expect(await p.getFlightStatus("af 1234", "2026-09-25", ctx)).toEqual(a);
    // Horaire déjà connu : conservé tel quel
    const known = await p.getFlightStatus("AF1234", "2026-09-25", { ...ctx, knownScheduled: "2026-09-25T14:30:00Z" });
    expect(known).toMatchObject({ scheduled: "2026-09-25T14:30:00.000Z", estimated: "2026-09-25T15:05:00.000Z" });
    // Avance (Dubaï → Paris : 7 h de vol, donc déjà parti 2 h avant)
    const early = await mockProvider({ delays: { EK073: -10 }, now: () => now }).getFlightStatus("EK073", "2026-09-25", ctx);
    expect(early).toMatchObject({ status: "departed", estimated: "2026-09-25T14:35:00.000Z", origin: "Dubaï (DXB)", terminal: "2E" });
  });

  it("en vol pendant le trajet, atterri dès l'heure estimée passée", async () => {
    let now = T0 - 60 * MIN; // 15:20 − 60 min : Nice → Paris (85 min) déjà parti
    const p = mockProvider({ delays: { AF1234: 35 }, now: () => now });
    const ctx = { requestedAt: new Date(T0).toISOString(), knownScheduled: "2026-09-25T14:45:00Z" };
    const nice = (await p.getFlightStatus("AF1234", "2026-09-25", ctx))!;
    expect(["departed", "delayed"]).toContain(nice.status);
    now = at("2026-09-25T15:21:00Z");
    expect(await p.getFlightStatus("AF1234", "2026-09-25", ctx)).toMatchObject({ status: "landed", actual: "2026-09-25T15:20:00.000Z" });
  });

  it("retard révélé seulement à moins de 6 h du vol ; sans surcharge : profil par numéro", async () => {
    const ctx = { requestedAt: new Date(T0).toISOString() };
    const far = await mockProvider({ delays: { AF1234: 50 }, now: () => T0 - 10 * 3600_000 }).getFlightStatus("AF1234", "2026-09-25", ctx);
    expect(far).toMatchObject({ status: "scheduled", estimated: far!.scheduled });
    const p = mockProvider({ now: () => T0 - 3600_000 });
    const delays = new Set<number>();
    for (const fn of ["AF1", "AF22", "AF333", "EK73", "BA304", "LH1034", "U24012", "TO3120", "AF7701", "KL1227"]) {
      const r = (await p.getFlightStatus(fn, "2026-09-25", ctx))!;
      delays.add((Date.parse(r.estimated!) - Date.parse(r.scheduled!)) / MIN);
    }
    expect(delays.size).toBeGreaterThan(1); // plusieurs profils
    for (const d of delays) expect(d).toBeGreaterThanOrEqual(-15);
  });

  it("annulé / dérouté ; mode départ = horaires de départ (dépôt + 2 h 30)", async () => {
    const p = mockProvider({ delays: { BA304: "cancelled", LH1: "diverted", AF1680: 40 }, now: () => T0 - 30 * MIN });
    expect(await p.getFlightStatus("BA304", "2026-09-25", {})).toMatchObject({ status: "cancelled", estimated: null });
    expect(await p.getFlightStatus("LH1", "2026-09-25", {})).toMatchObject({ status: "diverted" });
    const dep = await p.getFlightStatus("AF1680", "2026-09-25", { mode: "departure", requestedAt: new Date(T0).toISOString(), airportAddress: "Aéroport de Paris-Orly" });
    expect(dep).toMatchObject({ status: "delayed", scheduled: "2026-09-25T17:30:00.000Z", estimated: "2026-09-25T18:10:00.000Z", actual: null, terminal: "2" });
  });
});

describe("vols — AeroDataBox", () => {
  it("requête RapidAPI (défaut) ou API.market", () => {
    const r = aerodataboxRequest({ key: "k" }, "AF1234", "2026-09-25");
    expect(r.url).toBe("https://aerodatabox.p.rapidapi.com/flights/number/AF1234/2026-09-25?dateLocalRole=Both&withAircraftImage=false&withLocation=false");
    expect(r.headers).toEqual({ "X-RapidAPI-Key": "k", "X-RapidAPI-Host": "aerodatabox.p.rapidapi.com" });
    const m = aerodataboxRequest({ key: "k", marketplace: "apimarket" }, "AF1234", "2026-09-25");
    expect(m.url.startsWith("https://prod.api.market/api/v1/aedbx/aerodatabox/flights/number/AF1234/2026-09-25?")).toBe(true);
    expect(m.headers).toEqual({ "x-api-market-key": "k" });
  });

  it("vol multi-escales : tronçon qui arrive à l'aéroport de la course", () => {
    expect(parseAeroDataBox(AERODATABOX_MULTI_LEG, "2026-09-25", { mode: "arrival", airport: "CDG" })).toEqual({
      status: "departed",
      scheduled: "2026-09-25T13:05:00.000Z",
      estimated: "2026-09-25T13:40:00.000Z",
      actual: null,
      terminal: "2F",
      origin: "Lyon (LYS)",
    });
    // Sans aéroport reconnu : horaire le plus proche de la référence (prise en charge − marge)
    expect(parseAeroDataBox(AERODATABOX_MULTI_LEG, "2026-09-25", { requestedAt: "2026-09-25T10:30:00Z" })).toMatchObject({ status: "landed", actual: "2026-09-25T10:12:00.000Z", origin: "Nice (NCE)" });
  });

  it("arrivé : heure réelle ; mode départ : horaires de départ, destination", () => {
    expect(parseAeroDataBox(AERODATABOX_ARRIVED, "2026-09-25", { airport: "CDG" })).toEqual({
      status: "landed",
      scheduled: "2026-09-25T07:35:00.000Z",
      estimated: "2026-09-25T07:31:00.000Z",
      actual: "2026-09-25T07:31:00.000Z",
      terminal: "2A",
      origin: "London (LHR)",
    });
    expect(parseAeroDataBox(AERODATABOX_MULTI_LEG, "2026-09-25", { mode: "departure", airport: "LYS", requestedAt: "2026-09-25T09:00:00Z" })).toEqual({
      status: "departed",
      scheduled: "2026-09-25T11:40:00.000Z",
      estimated: "2026-09-25T12:12:00.000Z",
      actual: "2026-09-25T12:12:00.000Z",
      terminal: "1",
      origin: "Paris (CDG)",
    });
    expect(parseAeroDataBox([], "2026-09-25")).toBeNull();
  });

  it("HTTP : 204 → introuvable, 429 → erreur sans la clé, délai maximal", async () => {
    const reply = (status: number, body = "") => vi.fn(async () => new Response(status === 204 ? null : body, { status }));
    expect(await aerodataboxProvider({ key: "secret", fetch: reply(204) }).getFlightStatus("AF1", "2026-09-25")).toBeNull();
    const err = await aerodataboxProvider({ key: "secret", fetch: reply(429, '{"message":"Too many requests"}') }).getFlightStatus("AF1", "2026-09-25").catch((e) => e);
    expect(err).toBeInstanceOf(FlightProviderError);
    expect(err.message).toBe("HTTP_429: Too many requests");
    expect(err.message).not.toContain("secret");
    const ok = vi.fn(async () => new Response(JSON.stringify(AERODATABOX_ARRIVED), { status: 200 }));
    expect(await aerodataboxProvider({ key: "k", fetch: ok }).getFlightStatus("BA304", "2026-09-25", { airport: "CDG" })).toMatchObject({ status: "landed" });
    const hang = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason))));
    const slow = await aerodataboxProvider({ key: "k", fetch: hang, timeoutMs: 30 }).getFlightStatus("AF1", "2026-09-25").catch((e) => e);
    expect(slow).toMatchObject({ name: "FlightProviderError", message: "TIMEOUT" });
  });
});

describe("vols — aviationstack", () => {
  it("URL (clé en paramètre) ; heures locales converties avec le fuseau de l'aéroport", () => {
    expect(aviationstackUrl({ key: "k" }, "EK73")).toBe("https://api.aviationstack.com/v1/flights?access_key=k&flight_iata=EK73&limit=20");
    expect(parseAviationstack(AVIATIONSTACK_EK73, "2026-09-25", { airport: "CDG" })).toEqual({
      status: "departed",
      scheduled: "2026-09-25T12:25:00.000Z",
      estimated: "2026-09-25T12:50:00.000Z",
      actual: null,
      terminal: "2C",
      origin: "Dubai (DXB)",
    });
    expect(parseAviationstack(AVIATIONSTACK_EK73, "2026-09-25", { airport: "CDG" }, "utc")).toMatchObject({ scheduled: "2026-09-25T14:25:00.000Z" });
  });

  it("jour du vol choisi parmi plusieurs ; mode départ ; erreur fournisseur", () => {
    expect(parseAviationstack(AVIATIONSTACK_EK73, "2026-09-24", { airport: "CDG", knownScheduled: "2026-09-24T12:25:00Z" })).toMatchObject({
      status: "landed",
      actual: "2026-09-24T12:20:00.000Z",
    });
    expect(parseAviationstack(AVIATIONSTACK_EK73, "2026-09-25", { mode: "departure", airport: "DXB" })).toEqual({
      status: "departed",
      scheduled: "2026-09-25T05:40:00.000Z",
      estimated: "2026-09-25T05:40:00.000Z",
      actual: "2026-09-25T06:00:00.000Z",
      terminal: "3",
      origin: "Charles De Gaulle (CDG)",
    });
    expect(() => parseAviationstack(AVIATIONSTACK_ERROR, "2026-09-25")).toThrow(/usage_limit_reached/);
    expect(parseAviationstack({ data: [] }, "2026-09-25")).toBeNull();
  });
});

describe("vols — FlightAware AeroAPI", () => {
  it("fenêtre de recherche bornée à +2 jours", () => {
    const url = flightawareUrl({ now: () => at("2026-09-25T10:00:00Z") }, "AF1234", "2026-09-25");
    expect(url).toBe(
      "https://aeroapi.flightaware.com/aeroapi/flights/AF1234?start=2026-09-24T00%3A00%3A00Z&end=2026-09-27T00%3A00%3A00Z",
    );
    const late = flightawareUrl({ now: () => at("2026-09-25T10:00:00Z") }, "AF1234", "2026-09-26");
    expect(late).toContain("end=2026-09-27T09%3A59%3A00Z");
  });

  it("arrivée : heures « in » (porte), provenance ; le vol du jour, pas celui du lendemain (annulé)", () => {
    expect(parseFlightAware(FLIGHTAWARE_AF1234, "2026-09-25", { airport: "CDG", requestedAt: "2026-09-25T13:15:00Z" })).toEqual({
      status: "departed",
      scheduled: "2026-09-25T13:00:00.000Z",
      estimated: "2026-09-25T13:25:00.000Z",
      actual: null,
      terminal: "2F",
      origin: "Rome (FCO)",
    });
    expect(parseFlightAware(FLIGHTAWARE_AF1234, "2026-09-26", { airport: "CDG", requestedAt: "2026-09-26T13:15:00Z" })).toMatchObject({ status: "cancelled", scheduled: "2026-09-26T13:00:00.000Z" });
  });

  it("départ : heures « out », destination", () => {
    expect(parseFlightAware(FLIGHTAWARE_AF1234, "2026-09-25", { mode: "departure", airport: "FCO", requestedAt: "2026-09-25T08:00:00Z" })).toEqual({
      status: "departed",
      scheduled: "2026-09-25T10:30:00.000Z",
      estimated: "2026-09-25T11:00:00.000Z",
      actual: "2026-09-25T11:02:00.000Z",
      terminal: "1",
      origin: "Paris (CDG)",
    });
    expect(parseFlightAware({ flights: [] }, "2026-09-25")).toBeNull();
  });
});

describe("vols — choix du fournisseur et cache", () => {
  it("premier fournisseur dont la clé existe, sinon mock (hors production)", () => {
    expect(selectFlightProvider({}).provider?.name).toBe("mock");
    expect(selectFlightProvider({ AVIATIONSTACK_KEY: "a", FLIGHTAWARE_KEY: "f" }).provider?.name).toBe("aviationstack");
    expect(selectFlightProvider({ AERODATABOX_KEY: "x", FLIGHTAWARE_KEY: "f" }).provider?.name).toBe("aerodatabox");
    expect(selectFlightProvider({ FLIGHT_PROVIDER: "flightaware", AERODATABOX_KEY: "x", FLIGHTAWARE_KEY: "f" }).provider?.name).toBe("flightaware");
    expect(selectFlightProvider({ FLIGHT_PROVIDER: "flightaware" })).toMatchObject({ provider: null, reason: "FLIGHTAWARE_KEY manquante" });
    expect(selectFlightProvider({ FLIGHT_PROVIDER: "off", AERODATABOX_KEY: "x" }).provider).toBeNull();
    expect(selectFlightProvider({ FLIGHT_PROVIDER: "flightradar" }).provider).toBeNull();
    // Production sans clé : pas de retards inventés sur de vraies courses
    expect(selectFlightProvider({ NODE_ENV: "production" }).provider).toBeNull();
    expect(selectFlightProvider({ NODE_ENV: "production", FLIGHT_PROVIDER: "mock" }).provider?.name).toBe("mock");
  });

  it("cache 2 min par vol + date + mode ; requêtes simultanées fusionnées ; erreurs non conservées", async () => {
    let now = 0;
    let fail = false;
    const inner: FlightProvider = {
      name: "aerodatabox",
      getFlightStatus: vi.fn(async (fn: string) => {
        if (fail) throw new Error("boom");
        return { status: "scheduled", scheduled: null, estimated: null, actual: null, terminal: null, origin: fn } as FlightInfo;
      }),
    };
    const p = withCache(inner, 120_000, () => now);
    await Promise.all([p.getFlightStatus("AF1", "2026-09-25"), p.getFlightStatus("af 1", "2026-09-25")]);
    now = 119_000;
    await p.getFlightStatus("AF1", "2026-09-25");
    expect(inner.getFlightStatus).toHaveBeenCalledTimes(1);
    await p.getFlightStatus("AF1", "2026-09-25", { mode: "departure" });
    await p.getFlightStatus("AF1", "2026-09-26");
    expect(inner.getFlightStatus).toHaveBeenCalledTimes(3);
    now = 121_000;
    await p.getFlightStatus("AF1", "2026-09-25");
    expect(inner.getFlightStatus).toHaveBeenCalledTimes(4);
    fail = true;
    now = 300_000;
    await expect(p.getFlightStatus("AF1", "2026-09-25")).rejects.toThrow("boom");
    fail = false;
    await expect(p.getFlightStatus("AF1", "2026-09-25")).resolves.toMatchObject({ origin: "AF1" });
    expect(inner.getFlightStatus).toHaveBeenCalledTimes(6);
  });
});

describe("vols — tâche du worker", () => {
  const row = (i: number, extra: Partial<FlightRow> = {}): FlightRow => ({
    id: `00000000-0000-0000-0000-00000000000${i}`,
    organization_id: "org",
    number: String(100 + i),
    flight_number: `AF${1000 + i}`,
    flight_date: "2026-09-25",
    mode: "arrival",
    timezone: "Europe/Paris",
    pickup_at: new Date("2026-09-25T15:00:00Z"),
    flight_status: null,
    flight_scheduled_arrival: null,
    ...extra,
  });

  function fakeDb(rows: FlightRow[]) {
    const applied: unknown[][] = [];
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql === FLIGHTS_TO_CHECK_SQL) return { rows: rows as never[] };
      if (sql === APPLY_FLIGHT_SQL) {
        applied.push(params!);
        return { rows: [{ r: { ok: true, code: "UPDATED", flight_status: params![1], delay_minutes: 35, pickup_changed: true, notified: true, events: ["flight.delayed"] } }] as never[] };
      }
      // contexte des courses
      return {
        rows: rows.map((r) => ({ id: r.id, pickup_address: "Aéroport Paris-Charles de Gaulle, Terminal 2E", dropoff_address: "Paris", requested_at: new Date("2026-09-25T15:00:00Z"), buffer: 15 })) as never[],
      };
    });
    return { query: query as unknown as QueryFn, applied, raw: query };
  }

  it("interroge le fournisseur (3 en parallèle max) puis appelle apply_flight_status avec le numéro réservé", async () => {
    const db = fakeDb([row(1), row(2), row(3), row(4), row(5)]);
    let inFlight = 0;
    let peak = 0;
    const seen: unknown[] = [];
    const provider: FlightProvider = {
      name: "mock",
      async getFlightStatus(fn, date, ctx) {
        seen.push({ fn, date, ctx: { ...ctx, signal: undefined } });
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return { status: "delayed", scheduled: "2026-09-25 14:45Z", estimated: "2026-09-25T15:20:00Z", actual: null, terminal: "T2E", origin: "Nice" };
      },
    };
    const log = vi.fn();
    const stats = await flightJob({ query: db.query, provider, batch: 25, concurrency: 3, log }).tick();
    expect(peak).toBe(3);
    expect(stats).toMatchObject({ checked: 5, updated: 5, shifted: 5, notified: 5, errors: 0, notFound: 0 });
    expect(db.raw.mock.calls[0]).toEqual([FLIGHTS_TO_CHECK_SQL, [25]]);
    expect(seen[0]).toEqual({
      fn: "AF1001",
      date: "2026-09-25",
      ctx: expect.objectContaining({ mode: "arrival", airport: "CDG", requestedAt: "2026-09-25T15:00:00.000Z", bufferMinutes: 15, knownScheduled: null }),
    });
    expect(db.applied[0]).toEqual([row(1).id, "delayed", "2026-09-25T14:45:00.000Z", "2026-09-25T15:20:00.000Z", null, "2E", "Nice", "mock", "AF1001"]);
    expect(log).toHaveBeenCalledWith("info", "flight updated", expect.objectContaining({ ride: "101", events: ["flight.delayed"] }));
  });

  it("erreur fournisseur ou vol introuvable : journalisé, rien d'écrit, les autres courses continuent", async () => {
    const db = fakeDb([row(1), row(2), row(3)]);
    const provider: FlightProvider = {
      name: "aerodatabox",
      async getFlightStatus(fn) {
        if (fn === "AF1001") throw new FlightProviderError("HTTP_503: down", 503);
        if (fn === "AF1002") return null;
        return { status: "landed", scheduled: null, estimated: null, actual: "2026-09-25T14:50:00Z", terminal: null, origin: null };
      },
    };
    const log = vi.fn();
    const stats = await flightJob({ query: db.query, provider, log }).tick();
    expect(stats).toMatchObject({ checked: 2, errors: 1, notFound: 1, updated: 1 });
    expect(db.applied.map((p) => p[8])).toEqual(["AF1003"]);
    expect(log).toHaveBeenCalledWith("warn", "flight lookup failed", expect.objectContaining({ flight: "AF1001", error: "HTTP_503: down" }));
    expect(log).toHaveBeenCalledWith("warn", "flight not found", expect.objectContaining({ flight: "AF1002" }));
  });

  it("pas de passage concurrent ; arrêt : plus de nouvelle requête", async () => {
    const db = fakeDb([row(1), row(2), row(3), row(4)]);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const calls: string[] = [];
    const provider: FlightProvider = {
      name: "mock",
      async getFlightStatus(fn) {
        calls.push(fn);
        await gate;
        return null;
      },
    };
    const job = flightJob({ query: db.query, provider, concurrency: 1 });
    const first = job.tick();
    await new Promise((r) => setTimeout(r, 5));
    expect(await job.tick()).toBeNull(); // déjà en cours
    job.stop();
    release();
    expect(await first).toMatchObject({ skipped: 3 });
    expect(calls).toEqual(["AF1001"]);
    expect(await job.tick()).toBeNull();
  });

  it("mapLimit respecte la limite", async () => {
    let cur = 0;
    let max = 0;
    await mapLimit([1, 2, 3, 4, 5, 6, 7], 2, async () => {
      cur++;
      max = Math.max(max, cur);
      await new Promise((r) => setTimeout(r, 2));
      cur--;
    });
    expect(max).toBe(2);
  });
});
