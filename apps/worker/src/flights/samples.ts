// Réponses d'exemple des fournisseurs (formes documentées, valeurs inventées) — tests unitaires uniquement.

/** AeroDataBox GET /flights/number/AF7701/2026-09-25 : deux tronçons (NCE → LYS → CDG), le second en vol. */
export const AERODATABOX_MULTI_LEG = [
  {
    departure: {
      airport: { icao: "LFMN", iata: "NCE", name: "Nice Côte d'Azur", shortName: "Côte d'Azur", municipalityName: "Nice", countryCode: "FR", timeZone: "Europe/Paris" },
      scheduledTime: { utc: "2026-09-25 08:50Z", local: "2026-09-25 10:50+02:00" },
      revisedTime: { utc: "2026-09-25 08:55Z", local: "2026-09-25 10:55+02:00" },
      terminal: "2",
      quality: ["Basic", "Live"],
    },
    arrival: {
      airport: { icao: "LFLL", iata: "LYS", name: "Lyon Saint-Exupéry", shortName: "Saint-Exupéry", municipalityName: "Lyon", countryCode: "FR", timeZone: "Europe/Paris" },
      scheduledTime: { utc: "2026-09-25 10:10Z", local: "2026-09-25 12:10+02:00" },
      revisedTime: { utc: "2026-09-25 10:12Z", local: "2026-09-25 12:12+02:00" },
      terminal: "1",
      quality: ["Basic", "Live"],
    },
    lastUpdatedUtc: "2026-09-25 10:20Z",
    number: "AF 7701",
    status: "Arrived",
    codeshareStatus: "IsOperator",
    isCargo: false,
    airline: { name: "Air France", iata: "AF", icao: "AFR" },
  },
  {
    departure: {
      airport: { icao: "LFLL", iata: "LYS", name: "Lyon Saint-Exupéry", shortName: "Saint-Exupéry", municipalityName: "Lyon", countryCode: "FR", timeZone: "Europe/Paris" },
      scheduledTime: { utc: "2026-09-25 11:40Z", local: "2026-09-25 13:40+02:00" },
      revisedTime: { utc: "2026-09-25 12:12Z", local: "2026-09-25 14:12+02:00" },
      runwayTime: { utc: "2026-09-25 12:24Z", local: "2026-09-25 14:24+02:00" },
      terminal: "T1",
      gate: "B12",
      quality: ["Basic", "Live"],
    },
    arrival: {
      airport: { icao: "LFPG", iata: "CDG", name: "Paris Charles de Gaulle", shortName: "Charles de Gaulle", municipalityName: "Paris", countryCode: "FR", timeZone: "Europe/Paris" },
      scheduledTime: { utc: "2026-09-25 13:05Z", local: "2026-09-25 15:05+02:00" },
      predictedTime: { utc: "2026-09-25 13:40Z", local: "2026-09-25 15:40+02:00" },
      terminal: "2F",
      gate: "F21",
      baggageBelt: "5",
      quality: ["Basic", "Live"],
    },
    lastUpdatedUtc: "2026-09-25 12:30Z",
    number: "AF 7701",
    status: "EnRoute",
    codeshareStatus: "IsOperator",
    isCargo: false,
    aircraft: { reg: "F-HBNA", modeS: "3965A1", model: "Airbus A320" },
    airline: { name: "Air France", iata: "AF", icao: "AFR" },
  },
];

/** AeroDataBox : vol arrivé (revisedTime = heure réelle au contact). */
export const AERODATABOX_ARRIVED = [
  {
    departure: {
      airport: { icao: "EGLL", iata: "LHR", name: "London Heathrow", shortName: "Heathrow", municipalityName: "London", countryCode: "GB", timeZone: "Europe/London" },
      scheduledTime: { utc: "2026-09-25 06:20Z", local: "2026-09-25 07:20+01:00" },
      revisedTime: { utc: "2026-09-25 06:31Z", local: "2026-09-25 07:31+01:00" },
      terminal: "5",
      quality: ["Basic", "Live"],
    },
    arrival: {
      airport: { icao: "LFPG", iata: "CDG", name: "Paris Charles de Gaulle", shortName: "Charles de Gaulle", municipalityName: "Paris", countryCode: "FR", timeZone: "Europe/Paris" },
      scheduledTime: { utc: "2026-09-25 07:35Z", local: "2026-09-25 09:35+02:00" },
      revisedTime: { utc: "2026-09-25 07:31Z", local: "2026-09-25 09:31+02:00" },
      runwayTime: { utc: "2026-09-25 07:24Z", local: "2026-09-25 09:24+02:00" },
      terminal: "2A",
      quality: ["Basic", "Live"],
    },
    lastUpdatedUtc: "2026-09-25 07:40Z",
    number: "BA 304",
    status: "Arrived",
    codeshareStatus: "IsOperator",
    isCargo: false,
  },
];

/** aviationstack GET /v1/flights?flight_iata=EK73 : heures LOCALES suffixées « +00:00 ». */
export const AVIATIONSTACK_EK73 = {
  pagination: { limit: 20, offset: 0, count: 2, total: 2 },
  data: [
    {
      flight_date: "2026-09-24",
      flight_status: "landed",
      departure: { airport: "Dubai", timezone: "Asia/Dubai", iata: "DXB", icao: "OMDB", terminal: "3", gate: "A3", delay: 5, scheduled: "2026-09-24T09:40:00+00:00", estimated: "2026-09-24T09:40:00+00:00", actual: "2026-09-24T09:45:00+00:00", estimated_runway: null, actual_runway: null },
      arrival: { airport: "Charles De Gaulle", timezone: "Europe/Paris", iata: "CDG", icao: "LFPG", terminal: "2C", gate: null, baggage: "26", delay: null, scheduled: "2026-09-24T14:25:00+00:00", estimated: null, actual: "2026-09-24T14:20:00+00:00", estimated_runway: null, actual_runway: null },
      airline: { name: "Emirates", iata: "EK", icao: "UAE" },
      flight: { number: "73", iata: "EK73", icao: "UAE73", codeshared: null },
    },
    {
      flight_date: "2026-09-25",
      flight_status: "active",
      departure: { airport: "Dubai", timezone: "Asia/Dubai", iata: "DXB", icao: "OMDB", terminal: "3", gate: "A1", delay: 20, scheduled: "2026-09-25T09:40:00+00:00", estimated: "2026-09-25T09:40:00+00:00", actual: "2026-09-25T10:00:00+00:00", estimated_runway: "2026-09-25T10:00:00+00:00", actual_runway: "2026-09-25T10:00:00+00:00" },
      arrival: { airport: "Charles De Gaulle", timezone: "Europe/Paris", iata: "CDG", icao: "LFPG", terminal: "2C", gate: null, baggage: "26", delay: 25, scheduled: "2026-09-25T14:25:00+00:00", estimated: "2026-09-25T14:50:00+00:00", actual: null, estimated_runway: null, actual_runway: null },
      airline: { name: "Emirates", iata: "EK", icao: "UAE" },
      flight: { number: "73", iata: "EK73", icao: "UAE73", codeshared: null },
    },
  ],
};

export const AVIATIONSTACK_ERROR = { error: { code: "usage_limit_reached", message: "Your monthly usage limit has been reached. Please upgrade your Subscription Plan." } };

/** FlightAware AeroAPI GET /flights/AF1234?start=…&end=… : aujourd'hui en vol (retard), demain annulé. */
export const FLIGHTAWARE_AF1234 = {
  links: null,
  num_pages: 1,
  flights: [
    {
      ident: "AFR1234",
      ident_icao: "AFR1234",
      ident_iata: "AF1234",
      fa_flight_id: "AFR1234-1790000000-schedule-0002",
      operator: "AFR",
      flight_number: "1234",
      status: "Scheduled",
      cancelled: true,
      diverted: false,
      origin: { code: "LIRF", code_icao: "LIRF", code_iata: "FCO", timezone: "Europe/Rome", name: "Leonardo da Vinci–Fiumicino", city: "Rome" },
      destination: { code: "LFPG", code_icao: "LFPG", code_iata: "CDG", timezone: "Europe/Paris", name: "Paris Charles de Gaulle", city: "Paris" },
      scheduled_out: "2026-09-26T10:30:00Z",
      estimated_out: null,
      actual_out: null,
      scheduled_off: "2026-09-26T10:45:00Z",
      scheduled_on: "2026-09-26T12:50:00Z",
      scheduled_in: "2026-09-26T13:00:00Z",
      estimated_in: null,
      actual_in: null,
      terminal_origin: "1",
      terminal_destination: "2F",
    },
    {
      ident: "AFR1234",
      ident_icao: "AFR1234",
      ident_iata: "AF1234",
      fa_flight_id: "AFR1234-1789900000-schedule-0001",
      operator: "AFR",
      flight_number: "1234",
      status: "En Route / Delayed",
      cancelled: false,
      diverted: false,
      origin: { code: "LIRF", code_icao: "LIRF", code_iata: "FCO", timezone: "Europe/Rome", name: "Leonardo da Vinci–Fiumicino", city: "Rome" },
      destination: { code: "LFPG", code_icao: "LFPG", code_iata: "CDG", timezone: "Europe/Paris", name: "Paris Charles de Gaulle", city: "Paris" },
      departure_delay: 1800,
      arrival_delay: 1500,
      scheduled_out: "2026-09-25T10:30:00Z",
      estimated_out: "2026-09-25T11:00:00Z",
      actual_out: "2026-09-25T11:02:00Z",
      scheduled_off: "2026-09-25T10:45:00Z",
      estimated_off: "2026-09-25T11:15:00Z",
      actual_off: "2026-09-25T11:14:00Z",
      scheduled_on: "2026-09-25T12:50:00Z",
      estimated_on: "2026-09-25T13:12:00Z",
      actual_on: null,
      scheduled_in: "2026-09-25T13:00:00Z",
      estimated_in: "2026-09-25T13:25:00Z",
      actual_in: null,
      terminal_origin: "1",
      terminal_destination: "2F",
      gate_destination: "F32",
      baggage_claim: "12",
    },
  ],
};
