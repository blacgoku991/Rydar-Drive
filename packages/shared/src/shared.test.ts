import { describe, expect, it } from "vitest";
import {
  apiRideCreateSchema, canDriverTransition, classifyRide, DRIVER_FLOW, estimatePrice, estimateRoute, extractErrorCode,
  formatDistance, formatPrice, haversine, humanizeError, isCategoryCompatible, normalizePhone, rideFormSchema, TENANT_FIELDS,
} from "./index";

describe("format", () => {
  it("prix et distances en français", () => {
    expect(formatPrice(6500)).toBe("65 €");
    expect(formatPrice(7250)).toBe("72,50 €");
    expect(formatDistance(1800)).toBe("1,8 km");
    expect(formatDistance(640)).toBe("640 m");
    expect(formatDistance(12_400)).toBe("12 km");
  });
  it("normalise les téléphones", () => {
    expect(normalizePhone("06 12 34 56 78")).toBe("+33612345678");
    expect(normalizePhone("+44 20 7946 0958")).toBe("+442079460958");
    expect(normalizePhone("abc")).toBeNull();
  });
});

describe("domaine", () => {
  it("machine à états chauffeur", () => {
    expect(canDriverTransition("ACCEPTED", "DRIVER_EN_ROUTE")).toBe(true);
    expect(canDriverTransition("ACCEPTED", "COMPLETED")).toBe(false);
    expect(DRIVER_FLOW.IN_PROGRESS?.label).toBe("Terminer la course");
  });
  it("compatibilité des catégories (miroir SQL)", () => {
    expect(isCategoryCompatible("standard", "business", true)).toBe(true);
    expect(isCategoryCompatible("standard", "business", false)).toBe(false);
    expect(isCategoryCompatible("business", "van", true)).toBe(false);
    expect(isCategoryCompatible("van", "van", false)).toBe(true);
  });
  it("classification instantanée / planifiée", () => {
    const now = new Date("2026-09-24T10:00:00Z");
    expect(classifyRide(null, now)).toBe("instant");
    expect(classifyRide(new Date("2026-09-24T10:30:00Z"), now)).toBe("instant");
    expect(classifyRide(new Date("2026-09-24T12:00:00Z"), now)).toBe("scheduled");
  });
  it("codes d'erreur métier", () => {
    expect(extractErrorCode("PLAN_LIMIT_DRIVERS: limite de 10 chauffeurs")).toBe("PLAN_LIMIT_DRIVERS");
    expect(humanizeError("FORBIDDEN_TENANT: accès refusé")).toBe("Accès refusé.");
  });
});

describe("géo & tarifs", () => {
  it("haversine Paris → CDG ≈ 25 km", () => {
    const d = haversine({ lat: 48.8698, lng: 2.3075 }, { lat: 49.0047, lng: 2.571 });
    expect(d).toBeGreaterThan(23_000);
    expect(d).toBeLessThan(26_000);
  });
  it("estimation de prix avec minimum et majoration de nuit", () => {
    const rule = {
      vehicle_category: "business" as const, base_fare_cents: 1200, per_km_cents: 220, per_minute_cents: 55,
      minimum_fare_cents: 3500, night_surcharge_percent: 15, night_start: "21:00", night_end: "06:00",
    };
    const { distanceM, durationS } = estimateRoute({ lat: 48.8698, lng: 2.3075 }, { lat: 49.0047, lng: 2.571 });
    const day = estimatePrice(rule, distanceM, durationS, new Date("2026-09-24T12:00:00Z"));
    const night = estimatePrice(rule, distanceM, durationS, new Date("2026-09-24T23:30:00Z"));
    expect(day).toBeGreaterThan(8000);
    expect(night).toBeGreaterThan(day);
    expect(estimatePrice(rule, 500, 120)).toBe(3500);
  });
});

describe("schémas", () => {
  const base = {
    pickup: { address: "12 Avenue des Champs-Élysées, Paris", lat: 48.87, lng: 2.3 },
    dropoff: { address: "Aéroport CDG Terminal 2E" },
    customer: { name: "Client", phone: "06 12 34 56 78" },
  };
  it("API : accepte un payload minimal et applique les valeurs par défaut", () => {
    const parsed = apiRideCreateSchema.parse(base);
    expect(parsed.passengers).toBe(1);
    expect(parsed.vehicle_category).toBe("standard");
    expect(parsed.customer.phone).toBe("+33612345678");
  });
  it("API : refuse organization_id (champ inconnu) — la clé API décide du tenant", () => {
    expect(TENANT_FIELDS).toContain("organization_id");
    const res = apiRideCreateSchema.safeParse({ ...base, organization_id: "x" });
    expect(res.success).toBe(false);
  });
  it("formulaire dashboard : planifiée sans date → erreur", () => {
    const res = rideFormSchema.safeParse({
      pickup: base.pickup, dropoff: base.dropoff, when: "scheduled", customerName: "A", customerPhone: "0612345678",
      passengers: 1, luggage: 0, vehicleCategory: "business", paymentMethod: "card",
    });
    expect(res.success).toBe(false);
  });
});

import { zonedTimeToUtc } from "./time";
describe("fuseaux horaires", () => {
  it("heure locale Paris → UTC (été / hiver)", () => {
    expect(zonedTimeToUtc("2026-09-25", "06:30", "Europe/Paris").toISOString()).toBe("2026-09-25T04:30:00.000Z");
    expect(zonedTimeToUtc("2026-12-25", "06:30", "Europe/Paris").toISOString()).toBe("2026-12-25T05:30:00.000Z");
  });
});

describe("itinéraires", () => {
  it("encode / décode une polyline (exemple de référence Google)", async () => {
    const { encodePolyline, decodePolyline } = await import("./geo");
    const line: [number, number][] = [[-120.2, 38.5], [-120.95, 40.7], [-126.453, 43.252]];
    expect(encodePolyline(line)).toBe("_p~iF~ps|U_ulLnnqC_mqNvxq`@");
    expect(decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@")).toEqual(line);
    expect(decodePolyline(encodePolyline(line, 6), 6)).toEqual(line);
  });

  it("simplifie un tracé et calcule un point le long de la ligne", async () => {
    const { simplifyLine, pointAlong, lineLength } = await import("./geo");
    const straight: [number, number][] = Array.from({ length: 50 }, (_, k) => [2.3 + k * 0.001, 48.85]);
    expect(simplifyLine(straight, 5)).toHaveLength(2);
    const len = lineLength(straight);
    const mid = pointAlong(straight, len / 2);
    expect(mid.done).toBe(false);
    expect(mid.point[0]).toBeCloseTo(2.3245, 3);
    expect(Math.round(mid.heading)).toBe(90);
    expect(pointAlong(straight, len + 10).done).toBe(true);
  });
});

describe("forfaits", () => {
  it("reconnaît Paris ↔ CDG dans les deux sens, pas un trajet intra-Paris", async () => {
    const { matchFixedFare } = await import("./pricing");
    const rule = { fixed_fares: [{ label: "Paris ↔ CDG", price_cents: 7900 }, { label: "Paris ↔ Orly", price_cents: 6500 }] };
    expect(matchFixedFare(rule, "Gare de Lyon, Place Louis-Armand, 75012 Paris", "Aéroport Paris-Charles de Gaulle, Terminal 2E, 95700 Roissy-en-France")?.price_cents).toBe(7900);
    expect(matchFixedFare(rule, "Aéroport de Paris-Orly, Terminal 4, 94390 Orly", "Hôtel Plaza Athénée, 25 Avenue Montaigne, 75008 Paris")?.price_cents).toBe(6500);
    expect(matchFixedFare(rule, "Gare de Lyon, 75012 Paris", "Opéra Garnier, 75009 Paris")).toBeNull();
    expect(matchFixedFare(rule, "La Défense, 92400 Courbevoie", "Aéroport Paris-Charles de Gaulle, Terminal 2E")).toBeNull();
    expect(matchFixedFare(rule, "Aéroport Paris-Charles de Gaulle, Terminal 2E", "Aéroport de Paris-Orly, Terminal 4")).toBeNull();
  });
});

describe("libellés des nouveautés (vols, signalements)", () => {
  it("badge vol : retard, atterri, annulé, à l'heure", async () => {
    const { flightBadge, formatDelay, fleetReportTitle } = await import("./features");
    expect(formatDelay(35)).toBe("+35 min");
    expect(formatDelay(-10)).toBe("−10 min");
    expect(formatDelay(80)).toBe("+1 h 20");
    expect(flightBadge({ flight_number: null })).toBeNull();
    expect(flightBadge({ flight_number: "af 1234", flight_status: "delayed", flight_delay_minutes: 35, flight_terminal: "2E" })).toEqual({ text: "AF1234 · +35 min · T2E", tone: "amber" });
    expect(flightBadge({ flight_number: "AF1234", flight_status: "landed", flight_actual_arrival: "2026-09-25T12:52:00Z", flight_terminal: "T2E" }, "Europe/Paris")?.text).toBe("AF1234 · atterri 14:52 · T2E");
    expect(flightBadge({ flight_number: "AF1234", flight_status: "cancelled" })).toEqual({ text: "AF1234 · annulé", tone: "red" });
    expect(flightBadge({ flight_number: "AF1234", flight_status: "scheduled", flight_delay_minutes: 2 })?.text).toBe("AF1234 · à l'heure");
    expect(fleetReportTitle("police", "Karim")).toBe("Police signalée par Karim");
    expect(fleetReportTitle("control")).toBe("Contrôle signalé");
    const { documentStateLabel } = await import("./features");
    expect(documentStateLabel("expiring", 12)).toBe("Expire dans 12 j");
    expect(documentStateLabel("expiring", 0)).toBe("Expire aujourd'hui");
    expect(documentStateLabel("expired", -3)).toBe("Expiré depuis 3 j");
    expect(documentStateLabel("pending")).toBe("En attente de validation");
  });
});

describe("mode centrale (option 2)", () => {
  it("lien de paiement, message WhatsApp, répartition affichée", async () => {
    const { settlementPaymentLink, settlementRequestMessage, splitSummary, whatsappLink, whatsappNumber, settlementStatusLabel } = await import("./centrale");
    // Même calcul que private.settlement_payment_link
    expect(settlementPaymentLink("https://revolut.me/centrale/{montant}?ref={reference}", 1900, "C1783")).toBe("https://revolut.me/centrale/19.00?ref=C1783");
    expect(settlementPaymentLink("https://pay.example/{montant_centimes}", 1950, null)).toBe("https://pay.example/1950");
    expect(settlementPaymentLink(null, 1900, "C1")).toBeNull();
    expect(settlementPaymentLink("https://x/{montant}", 0, "C1")).toBeNull();

    expect(whatsappNumber("06 12 34 56 78")).toBe("33612345678");
    expect(whatsappNumber("+33 6 12 34 56 78")).toBe("33612345678");
    expect(whatsappNumber("0044 20 7946 0000")).toBe("442079460000");
    expect(whatsappNumber("12")).toBeNull();

    const sp = (v: string | null) => v?.replace(/\u00a0/g, " ") ?? null;
    const text = sp(settlementRequestMessage({
      firstName: "Karim", organizationName: "Elite Paris", amountCents: 1900, rideNumbers: [1783],
      link: "https://revolut.me/elite/19.00", reference: "C1783",
    }));
    expect(text).toContain("Bonjour Karim, merci pour la course #1783 !");
    expect(text).toContain("Commission Elite Paris : 19 € (réf. C1783).");
    expect(text).toContain("Paiement : https://revolut.me/elite/19.00");
    expect(whatsappLink("06 12 34 56 78", "Bonjour")).toBe("https://wa.me/33612345678?text=Bonjour");

    expect(sp(splitSummary({ price_cents: 5900, driver_payout_cents: 4000, commission_cents: 1400, platform_fee_cents: 500 })))
      .toBe("59 € = 40 € chauffeur + 14 € commission + 5 € plateforme");
    expect(splitSummary({ price_cents: 5900, driver_payout_cents: null })).toBeNull();
    expect(settlementStatusLabel("due", "driver_owes", true)).toBe("En retard");
    expect(settlementStatusLabel("paid", "centrale_owes")).toBe("Versé");
  });

  it("formulaires : réglages de la centrale et candidature publique", async () => {
    const { centraleSettingsSchema, joinApplicationSchema } = await import("./centrale");
    const ok = centraleSettingsSchema.parse({
      commissionPercent: "", commissionFixedCents: "1400", graceHours: 24, creditLimitCents: "", blockUnpaid: true,
      newDriverMaxPriceCents: 5000, trustAfterRides: 10, methods: ["link", "cash"], link: "https://revolut.me/x/{montant}", instructions: "",
    });
    expect(ok).toMatchObject({ commissionPercent: null, commissionFixedCents: 1400, creditLimitCents: null, link: "https://revolut.me/x/{montant}", instructions: null });
    const noLink = centraleSettingsSchema.safeParse({ ...ok, commissionPercent: 20, link: "", methods: ["link"] });
    expect(noLink.success).toBe(false);
    const http = centraleSettingsSchema.safeParse({ ...ok, link: "http://paypal.me/x" });
    expect(http.success).toBe(false);

    const application = joinApplicationSchema.safeParse({
      firstName: "Samir", lastName: "B.", phone: "06 12 34 56 78", email: "Samir@Test.dev", password: "motdepasse-solide",
      vehicle: { model: "Prius+", plate: "AB-123-CD", category: "standard", seats: 7 }, acceptTerms: true, website: "",
    });
    expect(application.success).toBe(true);
    if (application.success) expect(application.data).toMatchObject({ phone: "+33612345678", email: "samir@test.dev" });
    expect(joinApplicationSchema.safeParse({ ...application.data, acceptTerms: false }).success).toBe(false);
    expect(joinApplicationSchema.safeParse({ ...application.data, acceptTerms: true, website: "spam" }).success).toBe(false);
  });
});

import { describeError, fieldErrors, ORGANIZATION_CREATE_LABELS, organizationCreateSchema } from "./schemas";
describe("messages de validation lisibles", () => {
  const valid = {
    name: "Mans", slug: "mans", planCode: "starter", email: "contact@mans.fr", phone: "", city: "",
    ownerName: "Karim Benali", ownerEmail: "karim@mans.fr", ownerPassword: "",
  };

  it("création de centrale sans offre acceptée (offre facultative)", () => {
    expect(organizationCreateSchema.safeParse({ ...valid, planCode: "" }).success).toBe(true);
    expect(organizationCreateSchema.safeParse({ ...valid, planCode: undefined }).success).toBe(true);
  });

  it("erreur nommée par son champ, plus de message technique", () => {
    const res = organizationCreateSchema.safeParse({ ...valid, email: "" });
    expect(res.success).toBe(false);
    if (res.success) return;
    expect(describeError(res.error, ORGANIZATION_CREATE_LABELS)).toMatch(/^E-mail de la centrale : /);
    expect(Object.keys(fieldErrors(res.error))).toEqual(["email"]);
  });

  it("messages simples pour les cas courants, champ par champ", () => {
    const res = organizationCreateSchema.safeParse({ ...valid, name: "M", ownerName: "", ownerEmail: "karim", ownerPassword: "court" });
    expect(res.success).toBe(false);
    if (res.success) return;
    const errors = fieldErrors(res.error);
    expect(errors.name).toBe("2 caractères minimum");
    expect(errors.ownerName).toBe("2 caractères minimum");
    expect(errors.ownerEmail).toMatch(/e-mail invalide/i);
    expect(errors.ownerPassword).toBe("10 caractères minimum");
    expect(describeError(res.error, ORGANIZATION_CREATE_LABELS)).toBe("Nom de la centrale : 2 caractères minimum");
    expect(Object.values(errors).join(" ")).not.toMatch(/Trop petit|>=/);
  });

  it("formulaire valide accepté", () => {
    expect(organizationCreateSchema.safeParse(valid).success).toBe(true);
  });
});

import { driverPasswordResetSchema } from "./schemas";
describe("mot de passe oublié (app chauffeur)", () => {
  it("normalise l'adresse et refuse une adresse invalide", () => {
    expect(driverPasswordResetSchema.parse({ email: "  Moussa@Exemple.FR " })).toEqual({ email: "moussa@exemple.fr" });
    expect(driverPasswordResetSchema.safeParse({ email: "moussa" }).success).toBe(false);
    expect(driverPasswordResetSchema.safeParse({}).success).toBe(false);
  });
});

import { emailSchema } from "./schemas";
describe("adresse e-mail : longueur bornée", () => {
  it("refuse une adresse de plus de 254 caractères", () => {
    expect(emailSchema.safeParse(`${"a".repeat(250)}@x.fr`).success).toBe(false);
    expect(emailSchema.safeParse(`${"a".repeat(60)}@exemple.fr`).success).toBe(true);
  });
});
