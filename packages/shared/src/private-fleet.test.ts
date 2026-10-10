// Flotte Privée : schémas (création, bascule, clé du site, réglages des réservations), profils de dispatch dans les
// bornes SQL (organization_settings), état d'une réservation à traiter, libellés.
import { describe, expect, it } from "vitest";
import { dispatchPlan, ERROR_MESSAGES, humanizeError } from "./domain";
import {
  PRIVATE_BOOKING_LEAD_CHOICES, PRIVATE_BOOKING_REMINDER_CHOICES, PRIVATE_BOOKING_SETTINGS_LABELS, PRIVATE_BOOKING_TIMEOUT_CHOICES,
  PRIVATE_FLEET_BLOCKER_LABELS, PRIVATE_FLEET_BLOCKERS, PRIVATE_FLEET_BOOKING_STATE_META, PRIVATE_FLEET_BOOKING_STATES,
  PRIVATE_FLEET_CREATE_LABELS, PRIVATE_FLEET_DISPATCH_PROFILE, PRIVATE_FLEET_SITE_KEY_LABELS, PRIVATE_FLEET_SITE_KEY_SCOPES,
  PRIVATE_FLEET_SWITCH_LABELS, PRIVATE_FLEET_TAKE_MAX_AGE_HOURS, STANDARD_DISPATCH_PROFILE, privateBookingSettingsColumns,
  privateBookingSettingsSchema, privateFleetBookingState, privateFleetCreatePayload, privateFleetCreateSchema,
  privateFleetDriverPayload, privateFleetDriverSchema, privateFleetSiteKeySchema, privateFleetSwitchArgs,
  privateFleetSwitchSchema, privateFleetTakeable, siteOrigin, withWwwVariant, type DispatchProfile,
} from "./private-fleet";
import { API_SCOPES, BROWSER_KEY_SCOPES, describeError } from "./schemas";

const PLAN = "6f1c0d7e-2b8a-4c1e-9d3f-5a7b9c1d2e3f";

const create = {
  name: "VTC Karim",
  slug: "vtc-karim",
  email: "contact@vtc-karim.fr",
  phone: "06 12 34 56 78",
  city: "Paris",
  legalName: "Karim B. EI",
  siret: "123 456 789 00012",
  vtcRegistration: "EVTC075230001",
  ownerFirstName: "Karim",
  ownerLastName: "Benali",
  ownerEmail: "Karim@Example.fr",
  ownerPhone: "+33 6 98 76 54 32",
  vtcCardNumber: "T075-2026",
  vehicle: { brand: "Mercedes", model: "Classe E", color: "Noir", plate: "ab-123-cd", category: "business", seats: 4, luggageCapacity: 3 },
  contractRef: "CP-2026-014",
};

describe("création d'un client Flotte Privée", () => {
  it("saisie complète : normalisée (téléphones, SIRET, e-mail, plaque), frais 0 par défaut, offre facultative", () => {
    const v = privateFleetCreateSchema.parse({ ...create, planId: "" });
    expect(v).toMatchObject({
      phone: "+33612345678", ownerPhone: "+33698765432", siret: "12345678900012", ownerEmail: "karim@example.fr",
      platformFeePercent: 0, platformFeeFixedCents: 0, planId: null, temporaryPassword: false,
    });
    expect(v.password).toBeUndefined();
    expect(v.vehicle.plate).toBe("AB-123-CD");
    expect(privateFleetCreateSchema.parse({ ...create, planId: PLAN, platformFeePercent: "2.505", platformFeeFixedCents: "50" }))
      .toMatchObject({ planId: PLAN, platformFeePercent: 2.51, platformFeeFixedCents: 50 });
  });

  it("refus : identifiant réservé, SIRET, référence du contrat, frais hors bornes, mot de passe provisoire sans mot de passe", () => {
    const issue = (input: Record<string, unknown>) => {
      const res = privateFleetCreateSchema.safeParse(input);
      expect(res.success).toBe(false);
      return describeError(res.error!, PRIVATE_FLEET_CREATE_LABELS);
    };
    expect(issue({ ...create, slug: "eligibilite" })).toBe("Identifiant : nom réservé à la plateforme");
    expect(issue({ ...create, siret: "1234" })).toBe("SIRET : 14 chiffres");
    expect(issue({ ...create, contractRef: " a " })).toBe(
      "Référence du contrat signé : indiquez la référence des conditions particulières et du contrat de prestations signés",
    );
    expect(issue({ ...create, platformFeePercent: 60 })).toBe("Frais Rydar (%) : entre 0 et 50 %");
    expect(issue({ ...create, temporaryPassword: true })).toBe("Mot de passe provisoire : requis (ou décochez la case)");
    expect(privateFleetCreateSchema.safeParse({ ...create, temporaryPassword: true, password: "provisoire-2026" }).success).toBe(true);
    expect(issue({ ...create, vehicle: { ...create.vehicle, seats: 0 } })).toMatch(/^Places : /);
  });

  it("champs obligatoires du client (§ 8.1) : nom commercial, identifiant, e-mail, téléphone et ville ; le reste facultatif", () => {
    const refused = (input: Record<string, unknown>) => {
      const res = privateFleetCreateSchema.safeParse(input);
      expect(res.success).toBe(false);
      return { path: res.error!.issues[0]!.path, message: describeError(res.error!, PRIVATE_FLEET_CREATE_LABELS) };
    };
    const noCity: Record<string, unknown> = { ...create };
    delete noCity.city;
    expect(refused(noCity)).toEqual({ path: ["city"], message: "Ville : champ obligatoire" });
    for (const city of ["", "   "]) expect(refused({ ...create, city })).toEqual({ path: ["city"], message: "Ville : ville requise" });
    expect(refused({ ...create, city: "x".repeat(81) }).path).toEqual(["city"]);
    for (const field of ["name", "slug", "email", "phone"]) expect(refused({ ...create, [field]: "" }).path, field).toEqual([field]);
    // Facultatifs : absents ou vides, envoyés à null
    const minimal = privateFleetCreateSchema.parse({ ...create, city: "  Lyon ", legalName: "", siret: "", vtcRegistration: "" });
    expect(privateFleetCreatePayload(minimal).p_org).toMatchObject({ city: "Lyon", legal_name: null, siret: null, vtc_registration: null });
  });

  it("paramètres des RPC : organisation, fiche (e-mail de connexion), véhicule, offre, frais, contrat", () => {
    const payload = privateFleetCreatePayload(privateFleetCreateSchema.parse(create));
    expect(payload).toEqual({
      p_org: {
        name: "VTC Karim", slug: "vtc-karim", email: "contact@vtc-karim.fr", phone: "+33612345678", city: "Paris",
        legal_name: "Karim B. EI", siret: "12345678900012", vtc_registration: "EVTC075230001",
      },
      p_driver: { first_name: "Karim", last_name: "Benali", phone: "+33698765432", email: "karim@example.fr", vtc_card_number: "T075-2026" },
      p_vehicle: { brand: "Mercedes", model: "Classe E", color: "Noir", plate: "AB-123-CD", category: "business", seats: 4, luggage_capacity: 3 },
      p_plan_id: null,
      p_percent: 0,
      p_fixed_cents: 0,
      p_contract_ref: "CP-2026-014",
    });
    // Fiche recréée : e-mail du compte (absent → celui du compte, choisi par la base)
    const driver = privateFleetDriverSchema.parse({ ...create, vtcCardNumber: "" });
    expect(privateFleetDriverPayload(driver).p_driver).toEqual({
      first_name: "Karim", last_name: "Benali", phone: "+33698765432", email: null, vtc_card_number: null,
    });
  });

  it("libellés de tous les champs du formulaire", () => {
    const paths = [
      ...Object.keys(create).filter((k) => k !== "vehicle"),
      ...Object.keys(create.vehicle).map((k) => `vehicle.${k}`),
      "platformFeePercent", "platformFeeFixedCents", "planId", "temporaryPassword", "password",
    ];
    for (const p of paths) expect(PRIVATE_FLEET_CREATE_LABELS[p], p).toBeTruthy();
  });
});

describe("bascule (changer d'offre de service)", () => {
  const note = "E-mail du client du 09/10/2026";

  it("entrée en Flotte Privée : note seule, ni taux ni offre", () => {
    const v = privateFleetSwitchSchema.parse({ target: "private_fleet", consentNote: note });
    expect(privateFleetSwitchArgs(v)).toEqual({
      p_enabled: true, p_consent_note: note, p_dispatch_model: null, p_percent: null, p_fixed_cents: null,
      p_fee_mode: "notice", p_effective_on: null,
    });
    const rates = privateFleetSwitchSchema.safeParse({ target: "private_fleet", consentNote: note, platformFeePercent: 5, platformFeeFixedCents: 0 });
    expect(rates.success).toBe(false);
    expect(rates.error!.issues[0]!.path).toEqual(["platformFeePercent"]);
  });

  it("sortie : offre choisie ou absence d'offre assumée ; taux les deux ou aucun ; centrale sur accord écrit", () => {
    const noPlan = privateFleetSwitchSchema.safeParse({ target: "fleet", consentNote: note });
    expect(noPlan.success).toBe(false);
    expect(describeError(noPlan.error!, PRIVATE_FLEET_SWITCH_LABELS)).toBe("Offre : choisissez une offre, ou confirmez qu'aucune limite ne s'appliquera");
    const fleet = privateFleetSwitchSchema.parse({ target: "fleet", consentNote: note, acceptNoPlan: true, platformFeePercent: "", platformFeeFixedCents: null });
    expect(privateFleetSwitchArgs(fleet)).toMatchObject({ p_enabled: false, p_dispatch_model: null, p_percent: null, p_fixed_cents: null });
    const centrale = privateFleetSwitchSchema.parse({
      target: "centrale", consentNote: note, planId: PLAN, platformFeePercent: 3, platformFeeFixedCents: 50, mode: "consent",
    });
    expect(privateFleetSwitchArgs(centrale)).toEqual({
      p_enabled: false, p_consent_note: note, p_dispatch_model: "centrale", p_percent: 3, p_fixed_cents: 50,
      p_fee_mode: "consent", p_effective_on: null,
    });
    const oneRate = privateFleetSwitchSchema.safeParse({ target: "centrale", consentNote: note, planId: PLAN, platformFeePercent: 3 });
    expect(oneRate.success).toBe(false);
    expect(oneRate.error!.issues[0]!.path).toEqual(["platformFeeFixedCents"]);
    expect(privateFleetSwitchSchema.safeParse({ target: "fleet", consentNote: "ok", acceptNoPlan: true }).success).toBe(false);
  });
});

describe("clé du site du client", () => {
  it("origine https normalisée (en-tête Origin), sans chemin ; variante www", () => {
    expect(siteOrigin("https://MonSite.fr/")).toBe("https://monsite.fr");
    expect(siteOrigin(" https://www.mon-site.fr:443 ")).toBe("https://www.mon-site.fr");
    expect(siteOrigin("https://monsite.fr:8443")).toBe("https://monsite.fr:8443");
    for (const bad of ["http://monsite.fr", "https://monsite.fr/reserver", "https://localhost", "monsite.fr", "https://monsite.fr?x=1", "https://a@monsite.fr"]) {
      expect(siteOrigin(bad), bad).toBeNull();
    }
    expect(withWwwVariant("https://monsite.fr")).toEqual(["https://monsite.fr", "https://www.monsite.fr"]);
    expect(withWwwVariant("https://www.monsite.fr")).toEqual(["https://www.monsite.fr", "https://monsite.fr"]);
  });

  it("clé serveur : portées du backend du site, aucune origine ; clé navigateur : création et devis, origines + www", () => {
    expect(privateFleetSiteKeySchema.parse({ kind: "server", name: "Site VTC Karim", origins: ["https://x.fr"] })).toEqual({
      kind: "server", name: "Site VTC Karim", scopes: ["rides:create", "rides:read", "rides:cancel", "rides:quote", "webhooks:manage"], origins: [],
    });
    expect(privateFleetSiteKeySchema.parse({ kind: "browser", name: "Site VTC Karim", origins: ["https://VTC-karim.fr/", "https://www.vtc-karim.fr"] })).toEqual({
      kind: "browser", name: "Site VTC Karim", scopes: ["rides:create", "rides:quote"], origins: ["https://vtc-karim.fr", "https://www.vtc-karim.fr"],
    });
    const none = privateFleetSiteKeySchema.safeParse({ kind: "browser", name: "Site", origins: [] });
    expect(describeError(none.error!, PRIVATE_FLEET_SITE_KEY_LABELS)).toBe("Adresse du site : obligatoire pour une clé navigateur (https://…)");
    const bad = privateFleetSiteKeySchema.safeParse({ kind: "browser", name: "Site", origins: ["https://ok.fr", "http://ko.fr"] });
    expect(bad.error!.issues[0]!.path).toEqual(["origins", 1]);
    expect(describeError(bad.error!, PRIVATE_FLEET_SITE_KEY_LABELS)).toBe(
      "Adresse du site : https:// et nom de domaine seulement, sans chemin (ex. https://monsite.fr)",
    );
    expect(privateFleetSiteKeySchema.safeParse({ kind: "browser", name: "Site", origins: Array.from({ length: 6 }, (_, i) => `https://s${i}.fr`) }).success).toBe(false);
  });

  it("portées connues de l'API ; navigateur = BROWSER_KEY_SCOPES", () => {
    for (const scopes of Object.values(PRIVATE_FLEET_SITE_KEY_SCOPES)) {
      for (const s of scopes) expect(API_SCOPES as readonly string[]).toContain(s);
    }
    expect(PRIVATE_FLEET_SITE_KEY_SCOPES.browser).toEqual(BROWSER_KEY_SCOPES);
  });
});

describe("réglages « Réservations » du chauffeur", () => {
  it("choix proposés seulement ; rappels dédoublonnés, du plus lointain au plus proche ; colonnes", () => {
    const v = privateBookingSettingsSchema.parse({
      scheduledDispatchLeadMinutes: "120", offerTimeoutSeconds: 300, reminderOffsetsMinutes: [30, 1440, 180, 30], defaultPaymentMethod: "cash",
    });
    expect(privateBookingSettingsColumns(v)).toEqual({
      scheduled_dispatch_lead_minutes: 120, offer_timeout_seconds: 300, reminder_offsets_minutes: [1440, 180, 30], default_payment_method: "cash",
    });
    const bad = privateBookingSettingsSchema.safeParse({ scheduledDispatchLeadMinutes: 45, offerTimeoutSeconds: 300, reminderOffsetsMinutes: [], defaultPaymentMethod: "cash" });
    expect(describeError(bad.error!, PRIVATE_BOOKING_SETTINGS_LABELS)).toBe("Confirmer au plus tard : choisissez un délai proposé");
    expect(privateBookingSettingsSchema.safeParse({ scheduledDispatchLeadMinutes: 60, offerTimeoutSeconds: 30, reminderOffsetsMinutes: [], defaultPaymentMethod: "cash" }).success).toBe(false);
    expect(privateBookingSettingsSchema.safeParse({ scheduledDispatchLeadMinutes: 60, offerTimeoutSeconds: 60, reminderOffsetsMinutes: [90], defaultPaymentMethod: "cash" }).success).toBe(false);
  });

  it("choix dans les bornes SQL de organization_settings", () => {
    for (const m of PRIVATE_BOOKING_LEAD_CHOICES) expect(m >= 5 && m <= 1440, `${m}`).toBe(true);
    for (const s of PRIVATE_BOOKING_TIMEOUT_CHOICES) expect(s >= 10 && s <= 600, `${s}`).toBe(true);
    for (const m of PRIVATE_BOOKING_REMINDER_CHOICES) expect(m > 0, `${m}`).toBe(true);
    expect(PRIVATE_BOOKING_REMINDER_CHOICES.length).toBeLessThanOrEqual(8);
    expect(PRIVATE_BOOKING_LEAD_CHOICES).toContain(PRIVATE_FLEET_DISPATCH_PROFILE.scheduled_dispatch_lead_minutes);
    expect(PRIVATE_BOOKING_TIMEOUT_CHOICES).toContain(PRIVATE_FLEET_DISPATCH_PROFILE.offer_timeout_seconds);
  });
});

describe("profils de dispatch", () => {
  const increasing = (a: readonly number[]) => a.every((v, i) => i === 0 || v > a[i - 1]!);
  // Contraintes de organization_settings (20260924000200, 20260924003200)
  const inSqlBounds = (p: DispatchProfile) => {
    expect(p.dispatch_radii_m.length).toBeGreaterThanOrEqual(1);
    expect(p.dispatch_radii_m.length).toBeLessThanOrEqual(8);
    for (const r of p.dispatch_radii_m) expect(r > 0 && r <= 100_000, `${r}`).toBe(true);
    expect(increasing(p.dispatch_radii_m)).toBe(true);
    expect(p.dispatch_retry_radii_m.length).toBeLessThanOrEqual(4);
    for (const r of p.dispatch_retry_radii_m) expect(r >= 500 && r <= 100_000, `${r}`).toBe(true);
    expect(increasing(p.dispatch_retry_radii_m)).toBe(true);
    expect(p.offer_timeout_seconds >= 10 && p.offer_timeout_seconds <= 600).toBe(true);
    expect(p.instant_threshold_minutes >= 0 && p.instant_threshold_minutes <= 720).toBe(true);
    expect(p.scheduled_dispatch_lead_minutes >= 5 && p.scheduled_dispatch_lead_minutes <= 1440).toBe(true);
  };

  it("Flotte Privée : seule une course « maintenant » est immédiate, un dernier appel à 100 km sans relance", () => {
    inSqlBounds(PRIVATE_FLEET_DISPATCH_PROFILE);
    expect(dispatchPlan(PRIVATE_FLEET_DISPATCH_PROFILE.dispatch_radii_m, PRIVATE_FLEET_DISPATCH_PROFILE.dispatch_retry_radii_m).waves).toEqual([100_000]);
    expect(PRIVATE_FLEET_DISPATCH_PROFILE).toMatchObject({ instant_threshold_minutes: 0, offer_timeout_seconds: 300, scheduled_dispatch_lead_minutes: 60 });
  });

  it("standard : 4 → 8 → 12 → 16 km, relance 4 → 8 km", () => {
    inSqlBounds(STANDARD_DISPATCH_PROFILE);
    expect(dispatchPlan(STANDARD_DISPATCH_PROFILE.dispatch_radii_m, STANDARD_DISPATCH_PROFILE.dispatch_retry_radii_m).waves)
      .toEqual([4000, 8000, 12000, 16000, 4000, 8000]);
    expect(STANDARD_DISPATCH_PROFILE).toMatchObject({ instant_threshold_minutes: 45, offer_timeout_seconds: 30 });
  });
});

describe("réservations à traiter", () => {
  it("privateFleetBookingState : à confirmer, refusée, non confirmée, à vérifier ; null si attribuée ou close", () => {
    expect(privateFleetBookingState({ status: "OFFERED", pending_offer: true, last_offer_status: "pending" })).toBe("to_confirm");
    expect(privateFleetBookingState({ status: "NO_DRIVER_FOUND", last_offer_status: "declined" })).toBe("declined");
    expect(privateFleetBookingState({ status: "NO_DRIVER_FOUND", last_offer_status: "expired" })).toBe("not_confirmed");
    expect(privateFleetBookingState({ status: "NO_DRIVER_FOUND" })).toBe("not_confirmed");
    expect(privateFleetBookingState({ status: "SEARCHING_DRIVER", last_offer_status: "expired" })).toBe("not_confirmed");
    expect(privateFleetBookingState({ status: "SEARCHING_DRIVER", last_offer_status: null })).toBe("to_check");
    expect(privateFleetBookingState({ status: "CREATED" })).toBe("to_check");
    expect(privateFleetBookingState({ status: "ACCEPTED", driver_id: "d1" })).toBeNull();
    expect(privateFleetBookingState({ status: "SEARCHING_DRIVER", driver_id: "d1" })).toBeNull();
    expect(privateFleetBookingState({ status: "CANCELLED" })).toBeNull();
    expect(Object.keys(PRIVATE_FLEET_BOOKING_STATE_META)).toEqual([...PRIVATE_FLEET_BOOKING_STATES]);
    expect(PRIVATE_FLEET_BOOKING_STATE_META.not_confirmed.label).toBe("Non confirmée");
  });

  it("« La prendre » : sans chauffeur, jusqu'à 6 h après l'heure prévue", () => {
    const now = Date.parse("2026-10-14T12:00:00Z");
    expect(PRIVATE_FLEET_TAKE_MAX_AGE_HOURS).toBe(6);
    expect(privateFleetTakeable({ status: "NO_DRIVER_FOUND", pickup_at: "2026-10-14T06:00:00Z" }, now)).toBe(true);
    expect(privateFleetTakeable({ status: "NO_DRIVER_FOUND", pickup_at: "2026-10-14T05:59:00Z" }, now)).toBe(false);
    expect(privateFleetTakeable({ status: "OFFERED", pickup_at: "2026-10-15T06:00:00Z" }, now)).toBe(true);
    expect(privateFleetTakeable({ status: "ACCEPTED", driver_id: "d1", pickup_at: "2026-10-15T06:00:00Z" }, now)).toBe(false);
    expect(privateFleetTakeable({ status: "CANCELLED", pickup_at: "2026-10-15T06:00:00Z" }, now)).toBe(false);
  });
});

describe("libellés", () => {
  it("raisons d'un passage refusé", () => {
    expect(Object.keys(PRIVATE_FLEET_BLOCKER_LABELS)).toEqual([...PRIVATE_FLEET_BLOCKERS]);
    for (const label of Object.values(PRIVATE_FLEET_BLOCKER_LABELS)) expect(label).not.toMatch(/ [:;!?]/);
  });

  it("codes d'erreur de l'annexe A : libellés, espaces insécables", () => {
    for (const code of [
      "PRIVATE_FLEET_LOCKED", "PRIVATE_FLEET_MODEL", "PRIVATE_FLEET_RESTRICTED", "PRIVATE_FLEET_SINGLE_DRIVER",
      "PRIVATE_FLEET_DRIVER_OWNER", "PRIVATE_FLEET_NOT_ELIGIBLE", "AGENDA_RANGE_INVALID", "PRIVATE_FLEET_ONLY",
      "PRIVATE_FLEET_PLAN_INVALID", "PRIVATE_FLEET_HAS_DRIVER", "OWNER_NOT_NEW", "SELF_NOT_ALLOWED", "SLUG_TAKEN",
      "ALREADY_REGISTERED", "RIDE_TOO_LATE",
    ]) {
      expect(ERROR_MESSAGES[code], code).toBeTruthy();
      expect(ERROR_MESSAGES[code], code).not.toMatch(/ [:;!?]/);
    }
    expect(humanizeError("PRIVATE_FLEET_SINGLE_DRIVER: une seule fiche chauffeur en Flotte Privée")).toBe(ERROR_MESSAGES.PRIVATE_FLEET_SINGLE_DRIVER);
  });
});
