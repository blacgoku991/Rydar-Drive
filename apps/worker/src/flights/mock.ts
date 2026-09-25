// Fournisseur « mock » (défaut sans clé, et en dev où le réseau externe est bloqué) :
// déterministe, sans réseau. Retard fixé par numéro de vol (hachage) ou par FLIGHT_MOCK_DELAYS.
import {
  airportFromAddress,
  normalizeFlightNumber,
  terminalFromAddress,
  type FlightContext,
  type FlightInfo,
  type FlightProvider,
} from "./types";

export type MockOverride = number | "cancelled" | "diverted";

/** « AF1234=35,EK073=-10,BA304=cancelled » → { AF1234: 35, EK073: -10, BA304: "cancelled" } */
export function parseMockDelays(spec: string | undefined): Record<string, MockOverride> {
  const out: Record<string, MockOverride> = {};
  for (const part of (spec ?? "").split(/[,;]+/)) {
    const m = /^([A-Za-z0-9 ]+?)\s*[=:]\s*(.+)$/.exec(part.trim());
    if (!m) continue;
    const key = normalizeFlightNumber(m[1]!);
    const v = m[2]!.trim().toLowerCase();
    if (/^annul|^cancel/.test(v)) out[key] = "cancelled";
    else if (/^d[eé]rout|^divert/.test(v)) out[key] = "diverted";
    else if (Number.isFinite(Number(v))) out[key] = Math.round(Number(v));
  }
  return out;
}

/** FNV-1a 32 bits : même vol → même profil, d'un démarrage à l'autre. */
export function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Profils de retard (minutes) : surtout à l'heure, quelques retards, un peu d'avance. */
const DELAY_PROFILE = [0, 0, 0, 0, 5, 10, 20, 35, 50, -10, -15, 25];

/** Provenance (ou destination en mode départ) plausible par compagnie + durée de vol (min). */
const ROUTES: Record<string, [string, number][]> = {
  AF: [["Nice (NCE)", 85], ["Marseille (MRS)", 80], ["Toulouse (TLS)", 75], ["New York (JFK)", 480], ["Montréal (YUL)", 450], ["Tokyo (HND)", 840], ["Dakar (DSS)", 330], ["Abidjan (ABJ)", 380]],
  EK: [["Dubaï (DXB)", 420]],
  BA: [["Londres (LHR)", 75]],
  LH: [["Francfort (FRA)", 80], ["Munich (MUC)", 95]],
  KL: [["Amsterdam (AMS)", 80]],
  U2: [["Genève (GVA)", 65], ["Londres (LGW)", 80], ["Milan (MXP)", 90]],
  TO: [["Lisbonne (LIS)", 150], ["Marrakech (RAK)", 190], ["Porto (OPO)", 130]],
  AT: [["Casablanca (CMN)", 180]],
  QR: [["Doha (DOH)", 390]],
  DL: [["New York (JFK)", 480], ["Atlanta (ATL)", 540]],
  AA: [["New York (JFK)", 480], ["Dallas (DFW)", 600]],
  UA: [["Newark (EWR)", 470], ["Chicago (ORD)", 540]],
};
const DEFAULT_ROUTES: [string, number][] = [["Londres (LHR)", 75], ["Rome (FCO)", 125], ["Madrid (MAD)", 125], ["Barcelone (BCN)", 100]];

/** Terminaux par aéroport et compagnie (Paris) ; sinon « 1 ». */
const TERMINALS: Record<string, Record<string, string[]>> = {
  CDG: { AF: ["2E", "2F", "2G"], EK: ["2C"], BA: ["2A"], LH: ["1"], KL: ["2F"], U2: ["2D"], QR: ["1"], DL: ["2E"], AA: ["2A"], UA: ["1"], AT: ["1"], TO: ["3"], _: ["1", "2D", "3"] },
  ORY: { AF: ["2"], TO: ["3"], U2: ["3"], AT: ["1"], _: ["4", "1", "3"] },
  BVA: { _: ["1", "2"] },
};

const MIN = 60_000;

export type MockOptions = {
  delays?: Record<string, MockOverride>;
  now?: () => number;
  /** Le retard n'apparaît qu'à moins de N heures du vol (comme chez un vrai fournisseur). */
  revealHours?: number;
};

export function mockProvider(opts: MockOptions = {}): FlightProvider {
  const now = opts.now ?? Date.now;
  const revealMs = (opts.revealHours ?? 6) * 3600_000;
  const delays = opts.delays ?? {};

  return {
    name: "mock",
    async getFlightStatus(flightNumber: string, date: string, ctx: FlightContext = {}): Promise<FlightInfo> {
      const fn = normalizeFlightNumber(flightNumber);
      const h = hash(fn);
      const airline = /^([A-Z0-9]{2})/.exec(fn)?.[1] ?? "";
      const [place, durationMin] = (ROUTES[airline] ?? DEFAULT_ROUTES)[h % (ROUTES[airline] ?? DEFAULT_ROUTES).length]!;
      const mode = ctx.mode ?? "arrival";

      // Horaire prévu : celui déjà connu, sinon déduit de l'heure demandée (arrivée = prise en charge − marge,
      // départ = dépôt + 2 h 30), arrondi aux 5 min ; à défaut midi (UTC) le jour du vol.
      let scheduled = ctx.knownScheduled ? Date.parse(ctx.knownScheduled) : Number.NaN;
      if (!Number.isFinite(scheduled)) {
        const requested = ctx.requestedAt ? Date.parse(ctx.requestedAt) : Number.NaN;
        const base = Number.isFinite(requested)
          ? mode === "arrival"
            ? requested - (ctx.bufferMinutes ?? 15) * MIN
            : requested + 150 * MIN
          : Date.parse(`${date}T12:00:00Z`);
        scheduled = Math.floor(base / (5 * MIN)) * 5 * MIN;
      }

      const airport = ctx.airport ?? airportFromAddress(ctx.airportAddress) ?? "CDG";
      const table = TERMINALS[airport] ?? { _: ["1"] };
      const choices = table[airline] ?? table._ ?? ["1"];
      const terminal = terminalFromAddress(ctx.airportAddress) ?? choices[(h >>> 8) % choices.length]!;

      const override = delays[fn];
      const base = { scheduled: new Date(scheduled).toISOString(), terminal, origin: place };
      if (override === "cancelled") return { ...base, status: "cancelled", estimated: null, actual: null };
      if (override === "diverted") return { ...base, status: "diverted", estimated: null, actual: null };

      const t = now();
      const fullDelay = typeof override === "number" ? override : DELAY_PROFILE[h % DELAY_PROFILE.length]!;
      const delay = t >= scheduled - revealMs ? fullDelay : 0;
      const estimated = scheduled + delay * MIN;
      const iso = (ms: number) => new Date(ms).toISOString();

      if (mode === "arrival") {
        // Atterri dès que l'heure estimée est passée ; en vol pendant la durée du trajet avant
        if (t >= estimated) return { ...base, status: "landed", estimated: iso(estimated), actual: iso(estimated) };
        const status = t >= estimated - durationMin * MIN ? "departed" : delay >= 15 ? "delayed" : "scheduled";
        return { ...base, status, estimated: iso(estimated), actual: null };
      }
      // Mode départ : horaires de DÉPART ; parti puis arrivé à destination
      if (t >= estimated + durationMin * MIN) return { ...base, status: "landed", estimated: iso(estimated), actual: iso(estimated) };
      if (t >= estimated) return { ...base, status: "departed", estimated: iso(estimated), actual: iso(estimated) };
      return { ...base, status: delay >= 15 ? "delayed" : "scheduled", estimated: iso(estimated), actual: null };
    },
  };
}
