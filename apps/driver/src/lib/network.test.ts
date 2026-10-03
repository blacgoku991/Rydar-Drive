// Réseau partagé, app chauffeur (spec §12.3, décisions du propriétaire) : offre partenaire avec UN seul montant (à bord /
// prépayée), bloquée ; course décidée par driver_ride.money ; bon de réservation ; conditions ; lisibilité du profil ;
// IBAN masqué ; sections partenaires ; mots interdits (§7.1) dans tout le code de l'app.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  BookingVoucher, DriverHomeNetwork, DriverNetworkCreditor, DriverNetworkSettlementItem, DriverNetworkState, DriverOfferV2, DriverRideMoney,
  NetworkDriverMoney, Ride,
} from "@rydar/shared";
import { NETWORK_FORBIDDEN_WORDS, NETWORK_TERMS_VERSION } from "@rydar/shared";
import { describe, expect, it } from "vitest";
import {
  clientWindowNote, creditorView, driverNetworkStatus, earningsPartner, forbiddenWordsIn, giverPhone, legacyOffer, legacyRide, maskIban,
  networkHomeBanner, networkTermsContent, networkVisible, offerBlockView, partnerDoneView, partnerItemView, partnerOfferView, payoutFormErrors,
  rideMoneyView, settleHref, shouldProposeNetworkTerms, voucherView, type AppRide,
} from "./network";

/** Espaces insécables (prix, typographie française) ramenés à des espaces pour comparer les textes. */
const plain = (s: string | null | undefined) => (s ?? "").replace(/[  ]/g, " ");
const NOW = Date.parse("2026-11-10T09:00:00Z"); // 10/11/2026 10:00 à Paris
const TZ = "Europe/Paris";
const iso = (minutesFromNow: number) => new Date(NOW + minutesFromNow * 60_000).toISOString();

// -----------------------------------------------------------------------------------------------------------------
// Fixtures (formes du contrat @rydar/shared network.ts)
// -----------------------------------------------------------------------------------------------------------------

/** Course de 50 € de Taxi Alpha (centrale, 15 % + 10 % de frais) : part de A 12,50 €, part du chauffeur 37,50 €. */
const money = (collects: boolean, payment: NetworkDriverMoney["payment_method"] = collects ? "cash" : "online"): NetworkDriverMoney => ({
  price_cents: 5_000, currency: "EUR", payment_method: payment, collects, driver_part_cents: 3_750, giver_part_cents: 1_250,
  direction: collects ? "driver_owes" : "centrale_owes", amount_cents: collects ? 1_250 : 3_750, counterparty: "driver",
});

function offer(over: Partial<DriverOfferV2> = {}): DriverOfferV2 {
  return {
    offer_id: "o1", ride_id: "r1", number: 1783, mode: "geo", status: "pending", ride_type: "instant",
    pickup_address: "75011 Paris", pickup_lat: 48.858, pickup_lng: 2.379, dropoff_address: "Versailles", dropoff_lat: 48.801, dropoff_lng: 2.13,
    pickup_at: iso(10), price_cents: 5_000, currency: "EUR", payment_method: "cash", passengers: 1, luggage: 0, vehicle_category: "standard",
    distance_m: 1_200, estimated_distance_m: 21_000, estimated_duration_s: 1_800, route_polyline: null, flight_number: null, comment: null,
    sent_at: iso(0), expires_at: iso(1), dispatch_model: null, commission_cents: null, platform_fee_cents: null, driver_payout_cents: 3_750,
    driver_collects: true, blocked: null,
    network: {
      giver: { name: "Taxi Alpha", legal_name: "SAS Alpha Transports", vtc_registration: "EVTC075190001" },
      pickup_area: "75011 Paris", dropoff_area: "Versailles", money: money(true),
    },
    ...over,
  } as DriverOfferV2;
}

function rideMoney(over: Partial<DriverRideMoney> = {}): DriverRideMoney {
  return {
    price_cents: 5_000, currency: "EUR", payment_method: "cash", collects: true, driver_part_cents: 3_750, giver_part_cents: 1_250,
    direction: "driver_owes", amount_cents: 1_250, counterparty: "driver", creditor_name: "Taxi Alpha", ...over,
  };
}

function voucher(over: Partial<BookingVoucher> = {}): BookingVoucher {
  return {
    booked_by: { name: "Taxi Alpha", legal_name: "SAS Alpha Transports", vtc_registration: "EVTC075190001", phone: "+33140000000" },
    operator: { kind: "organization", name: "Flotte Beta", vtc_registration: "EVTC092180002" },
    booked_at: "2026-11-09T17:30:00Z",
    pickup_at: "2026-11-10T13:15:00Z",
    pickup_address: "12 rue Oberkampf, 75011 Paris",
    customer: { name: "Mme Durand", phone: "+33612345678" },
    receipt_by: "Taxi Alpha",
    ...over,
  };
}

function partnerRide(over: Partial<AppRide> = {}): AppRide {
  return {
    id: "r1", number: 1783, type: "scheduled", status: "ACCEPTED", pickup_address: "12 rue Oberkampf, 75011 Paris", pickup_lat: 48.86,
    pickup_lng: 2.37, dropoff_address: "Château de Versailles, 78000 Versailles", dropoff_lat: 48.8, dropoff_lng: 2.12, pickup_at: iso(240),
    created_at: iso(-600), accepted_at: iso(-60), completed_at: null, cancelled_at: null, cancel_reason: null, passengers: 1, luggage: 1,
    vehicle_category: "standard", estimated_distance_m: 21_000, estimated_duration_s: 1_800, route_polyline: null, flight_number: null,
    comment: null, customer_name: null, customer_phone: null, customer_visible_from: iso(180), customer_visible_until: null,
    price_cents: 5_000, currency: "EUR", payment_method: "cash", money: rideMoney(),
    network: { execution_id: "e1", giver: { name: "Taxi Alpha", legal_name: "SAS Alpha Transports", vtc_registration: "EVTC075190001", phone: "+33140000000", phone_until: null } },
    voucher: voucher(),
    ...over,
  };
}

function state(over: Partial<DriverNetworkState> = {}, readiness: Partial<DriverNetworkState["readiness"]> = {}): DriverNetworkState {
  return {
    enabled: true, org_allowed: true, accepted_version: NETWORK_TERMS_VERSION, accepted_at: iso(-10_000),
    terms: { version: NETWORK_TERMS_VERSION, min_version: null, grace_until: null }, mode: "consent",
    organization: { id: "b", name: "Flotte Beta", dispatch_model: "fleet", receiving: true },
    capable_at: iso(-5), excluded_until: null,
    readiness: { ready: true, missing: [], warnings: [], terms_grace_until: null, excluded_until: null, ...readiness },
    payout: { configured: false, payee_name: null, iban_last4: null, bic: null, updated_at: null, in_use: false },
    ...over,
  };
}

function item(over: Partial<DriverNetworkSettlementItem> = {}): DriverNetworkSettlementItem {
  return {
    id: "s1", ride_id: "r1", reference: "R1783", direction: "driver_owes", amount_cents: 1_250, price_cents: 5_000, driver_part_cents: 3_750,
    giver_part_cents: 1_250, currency: "EUR", payment_method: "cash", status: "due", overdue: false, on_hold: false, hold_until: null,
    due_at: iso(48 * 60), declared_at: null, declared_method: null, settled_at: null, settled_method: null, disputed_at: null,
    driver_disputed_at: null, driver_dispute_reason: null, can_dispute: false,
    ride: { number: 1783, pickup: "75011 Paris", dropoff: "Versailles", completed_at: iso(-30) },
    ...over,
  };
}

function creditor(over: Partial<DriverNetworkCreditor> = {}): DriverNetworkCreditor {
  return {
    organization: { id: "a", name: "Taxi Alpha", phone: "+33140000000" }, currency: "EUR", grace_hours: 48,
    summary: { owed_cents: 1_250, overdue_cents: 0, declared_cents: 0, payout_due_cents: 0, on_hold_cents: 0 },
    pay: {
      amount_cents: 1_250, count: 1, settlement_ids: ["s1"], reference: "RP-AB12-1011", link: "https://revolut.me/taxialpha/12.50",
      link_domain: "revolut.me", methods: ["link", "transfer", "cash"],
      bank: { payee_name: "SAS Alpha Transports", iban: "FR7630006000011234567890189", bic: null }, instructions: null,
    },
    blocked: null, blocked_message: null, items: [item()],
    ...over,
  };
}

// -----------------------------------------------------------------------------------------------------------------

describe("offre partenaire : UN seul montant, jamais commission ni frais Rydar (U4)", () => {
  it("client payé à bord : « Course de {A} (partenaire) », part du chauffeur, « vous reverserez 12,50 € à {A} »", () => {
    const v = partnerOfferView(offer())!;
    expect(v.title).toBe("Course de Taxi Alpha (partenaire)");
    expect(v.gainCents).toBe(3_750);
    expect(plain(v.line)).toBe("Le client vous paie 50 € à bord · vous reverserez 12,50 € à Taxi Alpha");
    expect(v.paymentLabel).toBe("Espèces");
    expect(v.pickup).toBe("75011 Paris");
    expect(v.dropoff).toBe("Versailles");
    expect(v.addressNote).toBe("Adresse exacte communiquée après acceptation");
  });

  it("client prépayé : « Course déjà payée à {A} · {A} vous versera 37,50 € »", () => {
    const o = offer({ payment_method: "online" });
    o.network!.money = money(false);
    expect(plain(partnerOfferView(o)!.line)).toBe("Course déjà payée à Taxi Alpha · Taxi Alpha vous versera 37,50 €");
  });

  it("carte à bord : le terminal du chauffeur (C20) ; départ sans code postal : communiqué après acceptation", () => {
    const o = offer();
    o.network!.money = money(true, "card");
    o.network!.pickup_area = null;
    const v = partnerOfferView(o)!;
    expect(v.paymentLabel).toBe("Carte à bord (votre terminal)");
    expect(v.pickup).toBe("Départ communiqué après acceptation");
  });

  it("aucun mot « commission » ni « frais » dans ce que voit le chauffeur d'une offre ou d'une course partenaire", () => {
    const shown = [partnerOfferView(offer())!, rideMoneyView(partnerRide())].flatMap((v) => Object.values(v)).filter((x) => typeof x === "string");
    for (const text of shown) expect(text).not.toMatch(/commission|frais/i);
  });

  it("offre de son organisation : pas de vue partenaire ; serveur antérieur (driver_offers) : jamais partenaire", () => {
    expect(partnerOfferView(offer({ network: null }))).toBeNull();
    const { network: _n, ...old } = offer();
    expect(legacyOffer(old as never).network).toBeNull();
  });
});

describe("offre bloquée : motif, message (noms insérés), écran où régler", () => {
  it("impayé envers A : seules ses courses, « Régler » → onglet Courses partenaires", () => {
    const b = offerBlockView("giver_unpaid", null, { giver: "Taxi Alpha", executor: "Flotte Beta" })!;
    expect(plain(b.message)).toBe("Un impayé envers Taxi Alpha bloque seulement les courses de Taxi Alpha : réglez-le pour en recevoir à nouveau.");
    expect(b).toMatchObject({ payable: true, target: "network", actionLabel: "Régler" });
    expect(settleHref(b.target)).toEqual({ pathname: "/commissions", params: { tab: "network" } });
  });

  it("plafond de B (garante) et plafond de A ; message du serveur prioritaire", () => {
    expect(plain(offerBlockView("executor_limit", null, { executor: "Flotte Beta" })!.message))
      .toBe("Plafond de Flotte Beta atteint : réglez d'abord vos courses partenaires.");
    expect(offerBlockView("giver_credit_limit", "Plafond de Taxi Alpha atteint (serveur).", { giver: "Taxi Alpha" })!.message)
      .toBe("Plafond de Taxi Alpha atteint (serveur).");
  });

  it("commissions dues à sa propre organisation (own_unpaid) : écran Commissions ; blocages propres inchangés", () => {
    expect(offerBlockView("own_unpaid", null, {})).toMatchObject({ target: "own", actionLabel: "Régler mes commissions" });
    expect(settleHref("own")).toBe("/commissions");
    expect(offerBlockView("unpaid", null)).toMatchObject({ target: "own", payable: true });
    expect(offerBlockView("new_driver", null)).toMatchObject({ payable: false });
    expect(offerBlockView(null, null)).toBeNull();
  });
});

describe("course : affichage décidé par driver_ride.money (et non par le modèle de l'organisation)", () => {
  it("partenaire payée à bord : sa part, UN montant à régler à A, récapitulatif « 12,50 € à régler à {A} »", () => {
    const v = rideMoneyView(partnerRide());
    expect(v).toMatchObject({ kind: "partner", giver: "Taxi Alpha", gainCents: 3_750, collects: true, amountCents: 1_250 });
    if (v.kind !== "partner") throw new Error("vue partenaire attendue");
    const done = partnerDoneView(v, item(), TZ, NOW);
    expect(plain(done.title)).toBe("12,50 € à régler à Taxi Alpha");
    expect(plain(done.sub)).toMatch(/^À régler avant le jeu\. 12\/11 10:00 · dans 2 j$/);
  });

  it("partenaire prépayée : « {A} vous versera 37,50 € », retenu si la course est à vérifier", () => {
    const r = partnerRide({ payment_method: "online", money: rideMoney({ collects: false, payment_method: "online", direction: "centrale_owes", amount_cents: 3_750 }) });
    const v = rideMoneyView(r);
    if (v.kind !== "partner") throw new Error("vue partenaire attendue");
    expect(plain(partnerDoneView(v, null, TZ, NOW).title)).toBe("Taxi Alpha vous versera 37,50 €");
    const held = partnerDoneView(v, item({ direction: "centrale_owes", amount_cents: 3_750, on_hold: true, hold_until: iso(72 * 60) }), TZ, NOW);
    expect(plain(held.sub)).toBe("Course à vérifier : versement retenu jusqu'au ven. 13/11 10:00");
  });

  it("course propre de centrale : part et commission ; flotte : prix seul (jamais les frais Rydar d'une flotte)", () => {
    expect(rideMoneyView(partnerRide({ network: null }))).toMatchObject({ kind: "centrale", gainCents: 3_750, deductionCents: 1_250 });
    const fleet = partnerRide({ network: null, money: rideMoney({ driver_part_cents: null, giver_part_cents: null, direction: null, amount_cents: null }) });
    expect(rideMoneyView(fleet)).toEqual({ kind: "plain", currency: "EUR" });
  });

  it("serveur antérieur (ligne rides) : argent déduit du modèle, sans bon ni bloc réseau", () => {
    const row = {
      ...partnerRide(), driver_id: "d1", organization_id: "b", customer_name: "M. Martin", customer_phone: "+33600000000",
      driver_payout_cents: 4_000, commission_cents: 900, platform_fee_cents: 100,
    } as unknown as Ride;
    const centrale = legacyRide(row, { model: "centrale", organization: "Taxi Bleu" });
    expect(centrale).toMatchObject({ network: null, voucher: null, driver_id: "d1", customer_name: "M. Martin" });
    expect(centrale.money).toMatchObject({ driver_part_cents: 4_000, giver_part_cents: 1_000, direction: "driver_owes", amount_cents: 1_000, creditor_name: "Taxi Bleu" });
    const fleet = legacyRide(row, { model: "fleet" });
    expect(fleet.money).toMatchObject({ driver_part_cents: null, giver_part_cents: null, direction: null, amount_cents: null });
    expect(rideMoneyView(fleet).kind).toBe("plain");
  });

  it("client d'une course partenaire : visible 1 h avant la prise en charge, effacé 1 h après la fin", () => {
    expect(clientWindowNote(partnerRide(), NOW)).toBe("Coordonnées du client visibles 1 h avant la prise en charge.");
    expect(clientWindowNote(partnerRide({ customer_visible_until: iso(-1) }), NOW)).toBe("Coordonnées du client effacées 1 h après la fin de la course.");
    expect(clientWindowNote(partnerRide({ customer_name: "Mme Durand", customer_phone: "+33612345678" }), NOW)).toBeNull();
    expect(clientWindowNote(partnerRide({ network: null }), NOW)).toBeNull();
  });

  it("« Appeler {A} » jusqu'à fin + 48 h seulement", () => {
    expect(giverPhone(partnerRide(), NOW)).toBe("+33140000000");
    const expired = partnerRide();
    expired.network!.giver.phone_until = iso(-1);
    expect(giverPhone(expired, NOW)).toBeNull();
    expect(giverPhone(partnerRide({ network: null }), NOW)).toBeNull();
  });
});

describe("bon de réservation (§7.5) : toutes les courses", () => {
  it("course partenaire, B flotte : A qui a pris la réservation, B exploitant, client, dates, lieu, reçu délivré par A", () => {
    const v = voucherView(voucher(), TZ);
    expect(v.lines.map((l) => [l.label, plain(l.value)])).toEqual([
      ["Réservation prise par", "Taxi Alpha (SAS Alpha Transports) · inscription VTC n° EVTC075190001 · +33 1 40 00 00 00"],
      ["Exploitant qui exécute la course", "Flotte Beta · inscription VTC n° EVTC092180002"],
      ["Client", "Mme Durand · +33 6 12 34 56 78"],
      ["Réservation faite le", "09/11/2026 à 18:30"],
      ["Prise en charge", "10/11/2026 à 14:15 · 12 rue Oberkampf, 75011 Paris"],
    ]);
    expect(plain(v.receipt)).toBe("Reçu ou facture du client : délivré par Taxi Alpha");
  });

  it("B centrale : le chauffeur indépendant et son n° d'exploitant ; client hors fenêtre : communiqué 1 h avant", () => {
    const v = voucherView(voucher({ operator: { kind: "driver", name: "Karim Benali", vtc_registration: "EVTC075230009" }, customer: null }), TZ);
    expect(plain(v.lines.find((l) => l.key === "operator")!.value)).toBe("Karim Benali (chauffeur indépendant) · inscription VTC n° EVTC075230009");
    expect(v.lines.find((l) => l.key === "customer")!.value).toBe("Communiqué 1 h avant la prise en charge");
  });

  it("course propre (sans raison sociale distincte ni n° connu) : lignes sans trou", () => {
    const v = voucherView(voucher({ booked_by: { name: "Taxi Bleu", legal_name: null, vtc_registration: null, phone: null }, receipt_by: "Taxi Bleu" }), TZ);
    expect(v.lines[0]!.value).toBe("Taxi Bleu");
    expect(plain(v.receipt)).toBe("Reçu ou facture du client : délivré par Taxi Bleu");
  });
});

describe("réglage « Courses du réseau partagé » : rien de nouveau quand le réseau est coupé ou non reçu", () => {
  it("visible seulement réseau ouvert ET organisation qui reçoit", () => {
    expect(networkVisible(state())).toBe(true);
    expect(networkVisible(null)).toBe(false);
    expect(networkVisible(state({}, { ready: false, missing: ["network_off"] }))).toBe(false);
    expect(networkVisible(state({ organization: { id: "b", name: "Flotte Beta", dispatch_model: "fleet", receiving: false } }))).toBe(false);
    expect(networkVisible(state({}, { ready: false, missing: ["org_reception_off"] }))).toBe(false);
  });

  it("« Actif », « Désactivé », ou le premier manque avec UN bouton", () => {
    expect(driverNetworkStatus(state(), TZ)).toMatchObject({ tone: "green", title: "Actif", action: null, warning: null });
    expect(driverNetworkStatus(state({ enabled: false }, { ready: false, missing: ["driver_off"] }), TZ)).toMatchObject({ tone: "muted", title: "Désactivé" });
    const terms = driverNetworkStatus(state({ accepted_version: null }, { ready: false, missing: ["terms", "vtc_card"] }), TZ);
    expect(terms).toMatchObject({ tone: "amber", title: "Conditions à accepter", action: { kind: "open_network_terms", label: "Lire les conditions" } });
    expect(driverNetworkStatus(state({}, { ready: false, missing: ["vtc_card"] }), TZ).action).toEqual({ kind: "open_documents", label: "Mes documents" });
    expect(driverNetworkStatus(state({}, { ready: false, missing: ["blocked:executor_limit"] }), TZ)).toMatchObject({ tone: "red", action: { kind: "pay_network" } });
  });

  it("raisons de l'organisation : pas de bouton, même interrupteur coupé ; exclusion datée ; nouvelles conditions en grâce", () => {
    expect(driverNetworkStatus(state({ enabled: false }, { ready: false, missing: ["org_disallowed", "driver_off"] }), TZ))
      .toMatchObject({ title: "Non autorisé par l'organisation", action: null });
    const excluded = driverNetworkStatus(state({}, { ready: false, missing: ["excluded_until"], excluded_until: "2026-12-10T09:00:00Z" }), TZ);
    expect(plain(excluded.hint)).toContain("jusqu'au 10/12/2026");
    const grace = driverNetworkStatus(
      state({ accepted_version: "2026-08-01", terms: { version: NETWORK_TERMS_VERSION, min_version: "2026-08-01", grace_until: "2026-12-01T00:00:00Z" } },
        { warnings: ["terms_grace"], terms_grace_until: "2026-12-01T00:00:00Z" }),
      TZ,
    );
    expect(grace.title).toBe("Actif");
    expect(plain(grace.warning?.text)).toBe("De nouvelles conditions du réseau partagé sont à accepter avant le 01/12/2026.");
    expect(grace.warning?.action.kind).toBe("open_network_terms");
  });
});

describe("conditions proposées une fois à l'accueil, puis à chaque nouvelle version", () => {
  const fresh = state({ enabled: false, accepted_version: null, accepted_at: null }, { ready: false, missing: ["driver_off", "terms"] });

  it("organisation qui reçoit, jamais acceptées : proposées une fois", () => {
    expect(shouldProposeNetworkTerms(fresh, null)).toBe(true);
    expect(shouldProposeNetworkTerms(fresh, NETWORK_TERMS_VERSION)).toBe(false);
  });

  it("nouvelle version (chauffeur actif) : proposée de nouveau ; déjà acceptée : non", () => {
    const updated = state({ terms: { version: "2027-01-01", min_version: NETWORK_TERMS_VERSION, grace_until: "2027-02-01T00:00:00Z" } });
    expect(shouldProposeNetworkTerms(updated, NETWORK_TERMS_VERSION)).toBe(true);
    expect(shouldProposeNetworkTerms(state(), null)).toBe(false);
  });

  it("jamais : réseau coupé, organisation qui ne reçoit pas, chauffeur non autorisé, ou qui a arrêté lui-même", () => {
    expect(shouldProposeNetworkTerms({ ...fresh, readiness: { ...fresh.readiness, missing: ["network_off"] } }, null)).toBe(false);
    expect(shouldProposeNetworkTerms({ ...fresh, organization: { ...fresh.organization, receiving: false } }, null)).toBe(false);
    expect(shouldProposeNetworkTerms({ ...fresh, org_allowed: false }, null)).toBe(false);
    const stopped = state({ enabled: false, terms: { version: "2027-01-01", min_version: null, grace_until: null } }, { ready: false, missing: ["driver_off"] });
    expect(shouldProposeNetworkTerms(stopped, null)).toBe(false);
  });
});

describe("écran des conditions (§7.3) : un seul « J'accepte », le chauffeur règle lui-même", () => {
  it("première fois : texte au nom de son organisation, version datée, « J'accepte »", () => {
    const c = networkTermsContent(state({ enabled: false, accepted_version: null }), new Date(NOW));
    expect(c.primary).toBe("J'accepte");
    expect(c.version).toBe(NETWORK_TERMS_VERSION);
    expect(plain(c.lead)).toContain("Flotte Beta reçoit les courses du réseau partagé");
    expect(c.points.map(plain)).toEqual([
      "Vous faites la course pour le compte de Flotte Beta.",
      "Si le client paie à bord, vous réglez la part de l'organisation qui vous confie la course, pour le compte de Flotte Beta, avec les moyens de paiement qu'elle propose.",
      "Si le client a déjà payé, cette organisation vous verse votre part.",
      "Les montants sont affichés avant d'accepter la course et ne changent plus ensuite.",
      "L'organisation qui vous confie la course reçoit votre prénom, l'initiale de votre nom, votre véhicule, votre plaque, votre téléphone et le n° de votre carte VTC.",
      "Vous pouvez arrêter à tout moment dans votre profil.",
    ]);
    expect(plain(c.note)).toBe("En touchant « J'accepte », vous acceptez les conditions des courses du réseau partagé (version du 01/11/2026).");
    // Décision Q2 : jamais « J'ai compris », jamais « encaissement géré par l'organisation »
    expect([c.lead, ...c.points, c.note].join(" ")).not.toMatch(/J'ai compris|géré par/);
  });

  it("déjà acceptées : « Activer » si coupé, rien si actif ; nouvelle version : lead « ont changé » et fin de grâce", () => {
    expect(networkTermsContent(state({ enabled: false })).primary).toBe("Activer");
    expect(networkTermsContent(state()).primary).toBeNull();
    const updated = networkTermsContent(
      state({ accepted_version: "2026-08-01", terms: { version: NETWORK_TERMS_VERSION, min_version: "2026-08-01", grace_until: "2026-12-01T00:00:00Z" } }),
      new Date(NOW),
    );
    expect(updated.primary).toBe("J'accepte");
    expect(plain(updated.lead)).toContain("ont changé. Les précédentes restent valables jusqu'au 01/12/2026.");
  });
});

describe("coordonnées bancaires : IBAN jamais réaffiché en entier", () => {
  it("masqué : 4 derniers caractères seulement", () => {
    expect(plain(maskIban("0189"))).toBe("•••• 0189");
    expect(maskIban(null)).toBe("—");
  });

  it("contrôles : titulaire, IBAN complet et valide (clé), BIC facultatif", () => {
    expect(payoutFormErrors({ payee: "Karim Benali", iban: "FR76 3000 6000 0112 3456 7890 189", bic: "" })).toEqual({});
    expect(payoutFormErrors({ payee: "Karim Benali", iban: "fr7630006000011234567890189", bic: "bnpafrpp" })).toEqual({});
    const bad = payoutFormErrors({ payee: "K", iban: "FR7630006000011234567890188", bic: "BNP" });
    expect(Object.keys(bad).sort()).toEqual(["bic", "iban", "payee"]);
    expect(plain(bad.iban)).toBe("IBAN invalide : vérifiez les chiffres.");
    expect(payoutFormErrors({ payee: "Karim Benali", iban: "  ", bic: "" }).iban).toBe("Saisissez l'IBAN complet.");
  });
});

describe("accueil : bandeau des courses partenaires", () => {
  const home = (over: Partial<DriverHomeNetwork> = {}): DriverHomeNetwork => ({
    owed_cents: 1_250, overdue_cents: 0, payout_due_cents: 0,
    creditors: [{ id: "a", name: "Taxi Alpha", owed_cents: 1_250, overdue_cents: 0, blocked: null }],
    readiness: { ready: true, missing: [], warnings: [], terms_grace_until: null, excluded_until: null },
    ...over,
  });

  it("à régler à une organisation ; en retard ; plusieurs organisations", () => {
    expect(networkHomeBanner(home(), "Flotte Beta")).toMatchObject({ tone: "amber", cta: "Payer", late: false });
    expect(plain(networkHomeBanner(home(), "Flotte Beta")!.title)).toBe("12,50 € à régler à Taxi Alpha");
    expect(networkHomeBanner(home({ overdue_cents: 1_250 }), "Flotte Beta")!.late).toBe(true);
    const two = home({ owed_cents: 2_000, creditors: [...home().creditors, { id: "c", name: "Taxi Gamma", owed_cents: 750, overdue_cents: 0, blocked: null }] });
    expect(plain(networkHomeBanner(two, "Flotte Beta")!.title)).toBe("20 € à régler (courses partenaires)");
  });

  it("blocage : impayé envers A (ses courses seulement) ou plafond de B", () => {
    const blocked = networkHomeBanner(home({ creditors: [{ id: "a", name: "Taxi Alpha", owed_cents: 1_250, overdue_cents: 1_250, blocked: "giver_unpaid" }] }), "Flotte Beta")!;
    expect(blocked).toMatchObject({ tone: "red", alert: true, cta: "Régler" });
    expect(plain(blocked.sub)).toContain("bloque seulement les courses de Taxi Alpha");
    const limit = networkHomeBanner(home({ readiness: { ready: false, missing: ["blocked:executor_limit"], warnings: [], terms_grace_until: null, excluded_until: null } }), "Flotte Beta")!;
    expect(plain(limit.sub)).toBe("Plafond de Flotte Beta atteint : réglez d'abord vos courses partenaires.");
  });

  it("part à recevoir ; rien à signaler ; pas de bloc réseau : rien", () => {
    const payout = networkHomeBanner(home({ owed_cents: 0, payout_due_cents: 3_750, creditors: [{ id: "a", name: "Taxi Alpha", owed_cents: 0, overdue_cents: 0, blocked: null }] }), "B");
    expect(payout).toMatchObject({ tone: "green", cta: "Voir" });
    expect(plain(payout!.title)).toBe("37,50 € à recevoir de Taxi Alpha");
    expect(networkHomeBanner(home({ owed_cents: 0, creditors: [] }), "B")).toBeNull();
    expect(networkHomeBanner(null, "B")).toBeNull();
  });
});

describe("« Courses partenaires » : un bloc par organisation, avec SES moyens", () => {
  it("à régler : montant, référence, moyens de l'organisation (lien + domaine, virement, espèces), échéance", () => {
    const v = creditorView(creditor(), TZ, NOW);
    expect(v.pay).toMatchObject({ amountCents: 1_250, reference: "RP-AB12-1011", link: "https://revolut.me/taxialpha/12.50", linkDomain: "revolut.me", manual: ["transfer", "cash"], urgent: false });
    expect(plain(v.pay!.dueLine)).toBe("À régler avant le jeu. 12/11 10:00 · dans 2 j");
    expect(v.payout).toBeNull();
  });

  it("« Pas reçu » par l'organisation, retard, blocage : à régler de nouveau ou à contester", () => {
    const disputed = creditorView(creditor({ items: [item({ status: "disputed", disputed_at: iso(-60), can_dispute: true })] }), TZ, NOW);
    expect(plain(disputed.pay!.dueLine)).toBe("Taxi Alpha n'a pas reçu votre paiement de 12,50 € : réglez-le de nouveau, ou contestez");
    expect(disputed.pay!.urgent).toBe(true);
    const late = creditorView(creditor({
      summary: { owed_cents: 1_250, overdue_cents: 1_250, declared_cents: 0, payout_due_cents: 0, on_hold_cents: 0 },
      blocked: "giver_unpaid", blocked_message: null,
    }), TZ, NOW);
    expect(plain(late.pay!.dueLine)).toContain("en retard : réglez maintenant pour recevoir de nouveau les courses de Taxi Alpha");
    expect(plain(late.blocked)).toContain("bloque seulement les courses de Taxi Alpha");
  });

  it("à recevoir, retenu (course à vérifier) ; rien à régler", () => {
    const v = creditorView(creditor({
      pay: null,
      summary: { owed_cents: 0, overdue_cents: 0, declared_cents: 0, payout_due_cents: 3_750, on_hold_cents: 2_000 },
      items: [item({ direction: "centrale_owes", amount_cents: 3_750 })],
    }), TZ, NOW);
    expect(v.pay).toBeNull();
    expect(plain(v.payout!.text)).toBe("Taxi Alpha vous versera 37,50 € (et 20 € après vérification)");
  });

  it("lignes : un seul montant par sens, jamais commission ; « Je conteste » une fois par ligne", () => {
    const due = partnerItemView(item(), "Taxi Alpha", TZ, NOW);
    expect(due).toMatchObject({ owes: true, title: "Course 1783", kind: "à reverser", status: "À régler", statusTone: "amber", dispute: null });
    expect(plain(due.amount)).toBe("−12,50 €");
    expect(plain(due.meta)).toContain("50 € · Espèces");
    const notReceived = partnerItemView(item({ status: "disputed", disputed_at: iso(-60), can_dispute: true }), "Taxi Alpha", TZ, NOW);
    expect(notReceived.notReceived).toBe("Taxi Alpha n'a pas reçu ce paiement.");
    expect(plain(notReceived.dispute?.label)).toBe("Je conteste : j'ai payé");
    const held = partnerItemView(item({ direction: "centrale_owes", amount_cents: 3_750, on_hold: true, hold_until: iso(72 * 60) }), "Taxi Alpha", TZ, NOW);
    expect(held).toMatchObject({ owes: false, kind: "votre part", status: "Retenu", statusTone: "amber" });
    expect(plain(held.amount)).toBe("+37,50 €");
    const paid = partnerItemView(item({ direction: "centrale_owes", status: "paid", settled_at: iso(-120), can_dispute: true }), "Taxi Alpha", TZ, NOW);
    expect(plain(paid.dispute?.label)).toBe("Je conteste : pas reçu");
    const sent = partnerItemView(item({ direction: "centrale_owes", status: "paid", settled_at: iso(-120), can_dispute: false, driver_disputed_at: iso(-30), driver_dispute_reason: "Rien reçu" }), "Taxi Alpha", TZ, NOW);
    expect(sent.dispute).toBeNull();
    expect(plain(sent.disputed)).toBe("Contestation envoyée aujourd'hui 09:30 : « Rien reçu »");
    for (const v of [due, notReceived, held, paid, sent]) {
      for (const text of Object.values(v)) if (typeof text === "string") expect(text).not.toMatch(/commission|frais/i);
    }
  });
});

describe("gains : net par course partenaire", () => {
  it("organisation, part du chauffeur et part de A (termes figés)", () => {
    const r = { id: "r1", number: 1783, pickup: "75011 Paris", dropoff: "Versailles", completed_at: iso(-30), price_cents: 5_000, net_cents: 3_750,
      currency: "EUR", payment_method: "cash" as const, vehicle_category: "standard" as const, distance_m: null, duration_s: null, network_giver: "Taxi Alpha" };
    expect(earningsPartner(r)).toEqual({ giver: "Taxi Alpha", gainCents: 3_750, giverPartCents: 1_250, collects: true });
    expect(earningsPartner({ ...r, network_giver: null })).toBeNull();
  });
});

describe("mots interdits (§7.1) : nulle part dans l'app chauffeur", () => {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return name === "node_modules" ? [] : files(path);
      return /\.(ts|tsx)$/.test(name) && !name.endsWith(".test.ts") ? [path] : [];
    });
  }

  it("aucun fichier de app/ ni src/ (écrans, libellés, conditions)", () => {
    const all = [...files(join(ROOT, "app")), ...files(join(ROOT, "src"))];
    expect(all.length).toBeGreaterThan(40);
    expect(all.some((p) => p.endsWith("network-terms.tsx"))).toBe(true);
    const found = all.map((path) => ({ path, words: forbiddenWordsIn(readFileSync(path, "utf8")) })).filter((f) => f.words.length > 0);
    expect(found).toEqual([]);
  });

  it("détection : « mise en relation », « intermédiaire », « place de marché », « marketplace »", () => {
    expect(forbiddenWordsIn("Rydar, intermédiaire et Marketplace")).toEqual(["intermédiaire", "marketplace"]);
    expect(NETWORK_FORBIDDEN_WORDS).toContain("mise en relation");
  });
});
