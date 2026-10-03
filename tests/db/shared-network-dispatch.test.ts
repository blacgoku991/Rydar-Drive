// Réseau partagé, lot 3 — dispatch (20260924006800_shared_network_dispatch) : scénarios §14.1 n° 6 à 15 de la
// spécification (étape réseau des immédiates et des planifiées, éligibilité, acceptation ; puis course confiée
// verrouillée, retraits, chien de garde, clôture et contrôles de fin), plus les montants (private.network_terms =
// networkTerms() de @rydar/shared au centime) et l'isolement des erreurs (C8).
// Réglages du réseau écrits directement (helpers de tests/db/helpers.ts) : les RPC d'administration arrivent au lot
// 20260924007100. L'interrupteur est rouvert avant chaque test et recoupé à la fin du fichier.
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { ERROR_MESSAGES } from "../../packages/shared/src/domain";
import { NETWORK_OFFER_NOTIFICATION_KEYS, networkTerms, type NetworkTermsGiverInput } from "../../packages/shared/src/network";
import {
  acceptDriverTerms, approveNetwork, as, CDG, CHAMPS_ELYSEES, createDriver, createMember, createOrg, createRideAsOwner,
  enableNetwork, expectPgError, inMinutes, insertRideBypass, networkTermsJson, nextWave, north, pingApp, pool, rideState,
  setSharedNetwork, sql, type Driver, type Org,
} from "./helpers";

afterAll(async () => {
  await setSharedNetwork(false);
  await pool.end();
});

beforeEach(async () => {
  await setSharedNetwork(true);
});

// -----------------------------------------------------------------------------
// Outils
// -----------------------------------------------------------------------------
const tag = () => randomUUID().slice(0, 6);
/** Téléphone propre à un chauffeur partenaire (createDriver donne le même numéro à tous : empreintes d'identité). */
const uniquePhone = () => `+3361${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;

type Result = { ok: boolean; code: string; message?: string; reason?: string; ride_id?: string };

/**
 * Lieu propre à chaque paire d'organisations (≈ 39 km d'écart, plus que le rayon réseau maximal de 16 km) : les
 * partenaires des autres tests, toujours disponibles, ne sont jamais à proximité des courses d'un test.
 */
let sites = 0;
const nextSite = (): [number, number] => [42.5 + ++sites * 0.35, 2.35];

/** Chauffeur partenaire prêt : position, téléphone et carte VTC propres, 4 documents valides, conditions, app à jour. */
async function readyPartner(B: Org, opts: { firstName?: string; at: [number, number] }): Promise<Driver> {
  const d = await createDriver(B, { firstName: opts.firstName ?? "Karim", at: opts.at });
  await sql(`update public.drivers set phone = $2, vtc_card_number = $3, last_name = 'Tazi' where id = $1`, [
    d.id, uniquePhone(), `VTC${tag()}`,
  ]);
  for (const type of ["vtc_card", "insurance", "vehicle_registration", "driving_license"]) {
    await sql(
      `insert into public.driver_documents (organization_id, driver_id, type, status, expires_at, reviewed_at)
       select organization_id, id, $2, 'valid', current_date + 365, now() from public.drivers where id = $1`,
      [d.id, type],
    );
  }
  await acceptDriverTerms(d);
  await pingApp(d);
  return d;
}

type Pair = { A: Org; B: Org; partner: Driver; site: [number, number] };

/** A (donneuse, flotte par défaut, 10 % de frais Rydar) partage, B reçoit ; validées ; un partenaire prêt chez B. */
async function networkPair(opts: { model?: "fleet" | "centrale" } = {}): Promise<Pair> {
  const A = await createOrg(`Donneuse ${tag()}`);
  const B = await createOrg(`Executante ${tag()}`);
  if (opts.model === "centrale") {
    await sql(`update public.organizations set dispatch_model = 'centrale' where id = $1`, [A.id]);
  }
  await enableNetwork(A, { out: true });
  await approveNetwork(A);
  await enableNetwork(B, { in: true });
  await approveNetwork(B);
  const site = nextSite();
  const partner = await readyPartner(B, { at: north(site, 800) });
  return { A, B, partner, site };
}

/** Course de A au lieu de la paire (départ à site, arrivée inchangée). */
async function rideOf(p: Pair, overrides: Record<string, unknown> = {}) {
  return createRideAsOwner(p.A, { pickup_lat: p.site[0], pickup_lng: p.site[1], ...overrides });
}

/** Course propre d'une organisation au lieu de la paire. */
async function ownRide(org: Org, p: Pair, overrides: Record<string, unknown> = {}) {
  return createRideAsOwner(org, { pickup_lat: p.site[0], pickup_lng: p.site[1], ...overrides });
}

/** Course immédiate amenée à la fin de ses vagues propres (6 par défaut), puis un passage du dispatch. */
async function toNetworkStage(rideId: string) {
  await sql(`update public.rides set dispatch_wave = 6, next_dispatch_at = now() - interval '1 second' where id = $1`, [rideId]);
  await sql("select private.dispatch_tick()");
}

async function pendingOffer(rideId: string, driverId: string) {
  const [o] = await sql(`select * from public.ride_offers where ride_id = $1 and driver_id = $2 and status = 'pending'`, [
    rideId, driverId,
  ]);
  return o as { id: string; network_terms: unknown; mode: string; wave: number } | undefined;
}

async function accept(driver: Driver, offerId: string): Promise<Result> {
  return as({ sub: driver.userId }, async (q) => (await q("select public.accept_ride_offer($1) as r", [offerId]))[0].r);
}

async function decline(driver: Driver, offerId: string): Promise<Result> {
  return as({ sub: driver.userId }, async (q) => (await q("select public.decline_ride_offer($1) as r", [offerId]))[0].r);
}

async function driverReason(driverId: string, rideId: string): Promise<string | null> {
  const [row] = await sql(
    `select private.network_driver_reason(d, r) as reason from public.drivers d, public.rides r where d.id = $1 and r.id = $2`,
    [driverId, rideId],
  );
  return row.reason;
}

async function candidateIds(rideId: string, radius = 16000, scheduled = false): Promise<string[]> {
  const rows = await sql(
    `select c.driver_id from public.rides r cross join lateral private.network_candidates(r, $2, $3) c where r.id = $1`,
    [rideId, radius, scheduled],
  );
  return rows.map((x) => x.driver_id);
}

async function phoneHash(driverId: string): Promise<string> {
  const [row] = await sql(`select private.identity_hash('phone', phone) as h from public.drivers where id = $1`, [driverId]);
  return row.h;
}

/** Fiche de A (ancienne fiche du même chauffeur) avec le même téléphone que le partenaire. */
async function giverFiche(A: Org, partner: Driver, status: "active" | "inactive" | "suspended" | "invited") {
  const fiche = await createDriver(A, { firstName: "Ancien", status });
  await sql(`update public.drivers set phone = (select phone from public.drivers where id = $2) where id = $1`, [fiche.id, partner.id]);
  return fiche;
}

/** Commission propre due par une fiche de A (règlement « à régler », échu). */
async function ownDebt(A: Org, ficheId: string) {
  const rideId = await insertRideBypass(A, { driver_id: ficheId, status: "CANCELLED" });
  await sql(
    `insert into public.ride_settlements (organization_id, ride_id, driver_id, driver_label, direction, amount_cents, price_cents,
       commission_cents, driver_payout_cents, payment_method, reference, status, due_at)
     values ($1, $2, $3, 'Ancien T.', 'driver_owes', 1500, 5000, 1500, 3500, 'cash', 'R-TEST', 'due', now() - interval '1 day')`,
    [A.id, rideId, ficheId],
  );
}

/** Course de A acceptée par un partenaire (étape réseau réelle + accept_ride_offer). Renvoie la course et l'exécution. */
async function partnerAccepts(p: Pair, partner: Driver, overrides: Record<string, unknown> = {}) {
  const ride = await rideOf(p, overrides);
  await toNetworkStage(ride.id);
  const offer = await pendingOffer(ride.id, partner.id);
  expect(offer, "offre réseau envoyée").toBeTruthy();
  const res = await accept(partner, offer!.id);
  expect(res).toMatchObject({ ok: true, code: "ACCEPTED" });
  const [e] = await sql(`select * from public.ride_network_executions where ride_id = $1 and ended_at is null`, [ride.id]);
  return { ride, offerId: offer!.id, execution: e };
}

/** Ligne réseau (règlement du lot argent, écrite ici à la main) d'une course acceptée par un partenaire. */
async function networkSettlement(p: Pair, partner: Driver, rideId: string, executionId: string,
  t: { direction: "driver_owes" | "centrale_owes"; status?: string; dueAt?: string; amount?: number }) {
  await sql(
    `insert into public.ride_settlements (organization_id, ride_id, driver_id, driver_label, direction, amount_cents, price_cents,
       commission_cents, platform_fee_cents, driver_payout_cents, payment_method, reference, status, due_at,
       network_driver_id, network_driver_org_id, network_execution_id, network_counterparty)
     values ($1, $2, null, 'Karim T. · Exécutante', $3, $4, 7200, 0, 720, 6480, 'cash', 'R-NET', $5, $6, $7, $8, $9, 'driver')`,
    [p.A.id, rideId, t.direction, t.amount ?? 720, t.status ?? "due", t.dueAt ?? new Date(Date.now() - 86_400_000).toISOString(),
      partner.id, p.B.id, executionId],
  );
}

// =============================================================================
// Montants (§10.1)
// =============================================================================
describe("Montants d'une course partagée : private.network_terms = networkTerms() de @rydar/shared", () => {
  it("au centime, flotte et centrale, taux et prix variés, à bord ou prépayé, répartition stockée", async () => {
    const givers: Array<NetworkTermsGiverInput & { label: string }> = [
      { label: "flotte 10 %", dispatch_model: "fleet", platform_fee_percent: "10.00", platform_fee_fixed_cents: 0 },
      { label: "flotte 1,15 %", dispatch_model: "fleet", platform_fee_percent: "1.15", platform_fee_fixed_cents: 0 },
      { label: "flotte 5 % + 1 €", dispatch_model: "fleet", platform_fee_percent: "5.00", platform_fee_fixed_cents: 100 },
      { label: "flotte 2 € fixes", dispatch_model: "fleet", platform_fee_percent: "0.00", platform_fee_fixed_cents: 200 },
      {
        label: "centrale 15 % / 10 %", dispatch_model: "centrale", platform_fee_percent: "10.00", platform_fee_fixed_cents: 0,
        driver_commission_percent: "15.00", driver_commission_fixed_cents: 0,
      },
      {
        label: "centrale 12,35 % + 1 € / 2,5 % + 0,50 €", dispatch_model: "centrale", platform_fee_percent: "2.50",
        platform_fee_fixed_cents: 50, driver_commission_percent: "12.35", driver_commission_fixed_cents: 100,
      },
      {
        label: "centrale 20 % sans frais", dispatch_model: "centrale", platform_fee_percent: "0.00", platform_fee_fixed_cents: 0,
        driver_commission_percent: "20.00", driver_commission_fixed_cents: null,
      },
    ];
    const prices = [0, 1, 99, 1001, 3000, 4999, 5000, 7333, 123457];
    const methods = ["cash", "card", "online", "invoice", "account"] as const;
    let compared = 0;
    for (const g of givers) {
      const A = await createOrg(`Montants ${tag()}`);
      await sql(
        `update public.organizations set dispatch_model = $2, platform_fee_percent = $3, platform_fee_fixed_cents = $4 where id = $1`,
        [A.id, g.dispatch_model, g.platform_fee_percent, g.platform_fee_fixed_cents],
      );
      await sql(
        `update public.organization_settings set driver_commission_percent = $2, driver_commission_fixed_cents = $3 where organization_id = $1`,
        [A.id, g.driver_commission_percent ?? null, g.driver_commission_fixed_cents ?? null],
      );
      for (const price of prices) {
        for (const method of methods) {
          const rideId = await insertRideBypass(A, { status: "CANCELLED", price_cents: price, payment_method: method });
          const [row] = await sql(
            `select private.network_terms(r) as terms, r.commission_cents, r.platform_fee_cents from public.rides r where r.id = $1`,
            [rideId],
          );
          const ts = networkTerms(
            { price_cents: price, payment_method: method, commission_cents: row.commission_cents, platform_fee_cents: row.platform_fee_cents },
            g,
          );
          if (ts.ok) expect(row.terms, `${g.label} · ${price} · ${method}`).toEqual(ts.terms);
          else expect(row.terms, `${g.label} · ${price} · ${method}`).toBeNull();
          compared++;
        }
      }
    }
    expect(compared).toBe(givers.length * prices.length * methods.length);
  });

  it("commission saisie (centrale), course passée de centrale à flotte, prix absent : mêmes règles que le miroir", async () => {
    const A = await createOrg(`Montants saisis ${tag()}`);
    await sql(`update public.organizations set dispatch_model = 'centrale', platform_fee_percent = 10 where id = $1`, [A.id]);
    await sql(`update public.organization_settings set driver_commission_percent = 15 where organization_id = $1`, [A.id]);
    const manual = await insertRideBypass(A, { status: "CANCELLED", price_cents: 5000, payment_method: "cash", commission_cents: 1000 });
    const inherited = await insertRideBypass(A, { status: "CANCELLED", price_cents: 5000, payment_method: "online" });
    const noPrice = await insertRideBypass(A, { status: "CANCELLED", price_cents: null, payment_method: "cash" });
    const terms = async (id: string) => (await sql(`select private.network_terms(r) as t from public.rides r where r.id = $1`, [id]))[0].t;

    // Commission saisie à la course : l'emporte sur les réglages (giver_cut = 10 € + 5 €)
    expect(await terms(manual)).toEqual(networkTermsJson({ price: 5000, method: "cash", commission: 1000, fee: 500 }));
    // Passage en flotte : règle des flottes (rides.platform_fee_cents hérité non lu, commission 0)
    await sql(`update public.organizations set dispatch_model = 'fleet' where id = $1`, [A.id]);
    expect(await terms(inherited)).toEqual(networkTermsJson({ price: 5000, method: "online", fee: 500 }));
    // Sans prix : non partageable, raison no_price (organisation non adhérente : sa raison passe d'abord)
    expect(await terms(noPrice)).toBeNull();
    await enableNetwork({ id: A.id, slug: "", ownerId: A.ownerId } as Org, { out: true });
    await approveNetwork({ id: A.id, slug: "", ownerId: A.ownerId } as Org);
    const [reason] = await sql(`select private.network_ride_reason(r) as r from public.rides r where r.id = $1`, [noPrice]);
    expect(reason.r).toBe("no_price");
    // Part du chauffeur nulle : no_payout
    await sql(`update public.organizations set platform_fee_fixed_cents = 6000 where id = $1`, [A.id]);
    const [reason2] = await sql(`select private.network_ride_reason(r) as r from public.rides r where r.id = $1`, [inherited]);
    expect(reason2.r).toBe("no_payout");
  });
});

// =============================================================================
// n° 6 — Immédiate : réseau après les vagues propres
// =============================================================================
describe("Immédiate : réseau après les vagues propres (§14.1 n° 6)", () => {
  it("6 vagues propres, dispatch.network, offre partenaire sans adresse précise, NO_DRIVER_FOUND après les vagues réseau", async () => {
    const p = await networkPair();
    const [aOrg] = await sql(`select name from public.organizations where id = $1`, [p.A.id]);
    const ride = await rideOf(p);

    // Vagues propres : 4 → 8 → 12 → 16 km puis relance 4 → 8 km, jamais de partenaire
    for (let wave = 1; wave <= 6; wave++) {
      const st = await rideState(ride.id);
      expect(st.ride.dispatch_wave).toBe(wave);
      expect(st.ride.network_at).toBeNull();
      expect(st.offers).toHaveLength(0);
      if (wave < 6) await nextWave(ride.id);
    }

    // Fin des vagues propres (180 s) : ouverture du réseau + première vague réseau (4 km)
    await nextWave(ride.id);
    let st = await rideState(ride.id);
    expect(st.ride.status).toBe("OFFERED");
    expect(st.ride.dispatch_wave).toBe(7);
    expect(st.ride.dispatch_radius_m).toBe(4000);
    expect(st.ride.network_at).not.toBeNull();
    const opened = st.events.filter((e) => e.type === "dispatch.network");
    expect(opened).toHaveLength(1);
    expect(opened[0].message).toBe("Aucun de vos chauffeurs n'a accepté — course proposée au réseau partagé");
    expect(opened[0].data).toEqual({ partners_nearby: 1, stage: "instant", cycle: 1 });
    // dispatch.network remplace le journal « rayon élargi » de la vague 7
    expect(st.events.filter((e) => e.type === "dispatch.next" && e.data.wave === 7)).toHaveLength(0);
    expect(st.events.find((e) => e.type === "dispatch.search" && e.data.wave === 7)?.message).toBe("Réseau partagé — rayon 4 km (vague 7)");

    expect(st.offers).toHaveLength(1);
    const offer = st.offers[0];
    expect(offer).toMatchObject({
      driver_id: p.partner.id, driver_org_id: p.B.id, is_network: true, status: "pending", mode: "geo", wave: 7, radius_m: 4000,
    });
    expect(offer.distance_m % 100).toBe(0);
    // A flotte à 10 % : part de A = 7,20 € de frais Rydar, le chauffeur encaisse la carte à bord
    expect(offer.network_terms).toEqual(networkTermsJson({ price: 7200, method: "card", fee: 720 }));

    const [share] = await sql(`select * from public.ride_network_shares where ride_id = $1`, [ride.id]);
    expect(share).toMatchObject({ status: "open", cycle: 1, opened_stage: "instant", partners_offered: 1, organization_id: p.A.id });

    // Notification : « COURSE PARTENAIRE », communes seulement, ni montant interne ni coordonnées
    const [n] = await sql(`select * from public.notifications where offer_id = $1`, [offer.id]);
    expect(n).toMatchObject({ type: "ride_offer", title: "COURSE PARTENAIRE", organization_id: p.A.id, driver_org_id: p.B.id });
    expect(n.body).toBe(`${aOrg.name} · 75008 Paris → arrivée communiquée après acceptation · 800 m du départ · 72 €`);
    expect(n.body).not.toContain("Champs");
    expect(n.data).toMatchObject({ network: true, pickup: "75008 Paris", giver: aOrg.name, price_cents: 7200 });
    // Contrat NetworkOfferNotificationData : clés exactes
    expect(Object.keys(n.data).sort()).toEqual([...NETWORK_OFFER_NOTIFICATION_KEYS].sort());
    for (const key of ["commission_cents", "platform_fee_cents", "driver_payout_cents", "pickup_lat", "pickup_lng"]) {
      expect(n.data).not.toHaveProperty(key);
    }
    expect(JSON.stringify(n.data)).not.toContain("Champs");

    // Le partenaire n'est pas « sollicité » (son organisation peut toujours le solliciter)
    const [presence] = await sql(`select presence from public.drivers where id = $1`, [p.partner.id]);
    expect(presence.presence).toBe("available");
    // Membres de A : aucune offre réseau ; journal sans identifiant du partenaire
    const seen = await as({ sub: p.A.ownerId }, (q) => q(`select id from public.ride_offers where ride_id = $1`, [ride.id]));
    expect(seen).toHaveLength(0);
    expect(JSON.stringify(st.events)).not.toContain(p.partner.id);

    // Vagues réseau 8 → 12 → 16 km (offre prolongée sans nouvelle sonnerie), puis fin du plan
    await nextWave(ride.id, 3);
    st = await rideState(ride.id);
    expect(st.ride.dispatch_wave).toBe(10);
    expect(st.ride.status).toBe("OFFERED");
    expect(st.offers.filter((o) => o.is_network)).toHaveLength(1);
    await nextWave(ride.id);
    st = await rideState(ride.id);
    expect(st.ride.status).toBe("NO_DRIVER_FOUND");
    expect(st.ride.network_at).toBeNull();
    const end = st.events.find((e) => e.type === "dispatch.no_driver");
    expect(end.message).toBe(
      "Personne n'a accepté la course (4 km → 8 km → 12 km → 16 km, relance 4 km → 8 km, réseau partagé : 1 chauffeur partenaire sollicité) — attribuez-la ou relancez",
    );
    expect(end.data).toMatchObject({ network: true, partners_offered: 1, waves: 10 });
    const [closed] = await sql(`select status, closed_reason from public.ride_network_shares where ride_id = $1`, [ride.id]);
    expect(closed).toEqual({ status: "closed", closed_reason: "no_driver" });
    const [o] = await sql(`select status, closed_reason from public.ride_offers where id = $1`, [offer.id]);
    expect(o).toEqual({ status: "expired", closed_reason: "timeout" });
    // Notification d'offre fermée supprimée (le push déjà parti ne contient pas d'adresse précise)
    expect(await sql(`select 1 from public.notifications where offer_id = $1`, [offer.id])).toHaveLength(0);
  });

  it("un chauffeur de A libéré pendant la phase réseau passe avant les partenaires (quota de la vague)", async () => {
    const p = await networkPair();
    await sql(`update public.organization_settings set max_offers_per_wave = 1 where organization_id = $1`, [p.A.id]);
    const farid = await readyPartner(p.B, { firstName: "Farid", at: north(p.site, 6000) });
    const ride = await rideOf(p);
    await toNetworkStage(ride.id);
    expect((await rideState(ride.id)).offers.map((o) => o.driver_id)).toEqual([p.partner.id]);

    // Un chauffeur de A redevient disponible près du départ : vague réseau suivante (8 km, quota 1) → lui d'abord
    const own = await createDriver(p.A, { firstName: "Ahmed", at: north(p.site, 500) });
    await nextWave(ride.id);
    let st = await rideState(ride.id);
    const wave8 = st.offers.filter((o) => o.wave === 8);
    expect(wave8.map((o) => [o.driver_id, o.is_network])).toEqual([[own.id, false]]);
    expect(await pendingOffer(ride.id, farid.id)).toBeUndefined();
    const candidates = st.events.find((e) => e.type === "dispatch.candidates" && e.data.wave === 8);
    expect(candidates.data).toMatchObject({ candidates: 1, network_offered: 0, driver_ids: [own.id], network: true });
    const [ownPresence] = await sql(`select presence from public.drivers where id = $1`, [own.id]);
    expect(ownPresence.presence).toBe("offered");

    // Vague suivante (12 km) : plus de chauffeur de A nouveau, le partenaire suivant
    await nextWave(ride.id);
    st = await rideState(ride.id);
    expect(st.offers.filter((o) => o.wave === 9).map((o) => o.driver_id)).toEqual([farid.id]);
    const c9 = st.events.find((e) => e.type === "dispatch.candidates" && e.data.wave === 9);
    expect(c9.data).toMatchObject({ candidates: 0, network_offered: 1, driver_ids: [] });
    expect(c9.message).toBe("0 chauffeur à moins de 12 km · réseau partagé : 1 chauffeur partenaire sollicité");
  });

  it("vu de B, son chauffeur sollicité par le réseau reste disponible pour ses propres courses", async () => {
    const p = await networkPair();
    const ride = await rideOf(p);
    await toNetworkStage(ride.id);
    expect(await pendingOffer(ride.id, p.partner.id)).toBeTruthy();
    // Course propre de B au même endroit : son chauffeur est sollicité tout de suite
    const own = await ownRide(p.B, p);
    const ownOffer = await pendingOffer(own.id, p.partner.id);
    expect(ownOffer).toBeTruthy();
    // Puis refusée : il redevient disponible malgré l'offre réseau toujours en attente
    expect(await decline(p.partner, ownOffer!.id)).toMatchObject({ ok: true });
    const [presence] = await sql(`select presence from public.drivers where id = $1`, [p.partner.id]);
    expect(presence.presence).toBe("available");
    expect(await pendingOffer(ride.id, p.partner.id)).toBeTruthy();
  });
});

// =============================================================================
// Offre réseau : départ et arrivée approximatifs (S7, matrice §11.1 : commune ou quartier seulement avant acceptation)
// =============================================================================
describe("Offre réseau : adresses approximatives (S7, §11.1)", () => {
  it("commune (forme d'un nom de commune) seulement après le code postal et avant une virgule ou la fin ; sinon le code postal seul", async () => {
    const cases: Array<[string | null, string | null, string | null]> = [
      ["12 Avenue des Champs-Élysées, 75008 Paris", "75008 Paris", "Paris"],
      ["12 Avenue des Champs-Élysées 75008 Paris", "75008 Paris", "Paris"],
      ["12 Av. des Champs-Élysées, 75008 Paris, France", "75008 Paris", "Paris"],
      ["Aéroport Paris-Charles de Gaulle, Terminal 2E, 95700 Roissy-en-France", "95700 Roissy-en-France", "Roissy-en-France"],
      ["3 rue de la Paix, 94240 L'Haÿ-les-Roses, France", "94240 L'Haÿ-les-Roses", "L'Haÿ-les-Roses"],
      ["Gare, 78100 Saint-Germain-en-Laye  ", "78100 Saint-Germain-en-Laye", "Saint-Germain-en-Laye"],
      ["Gare, 78100 Saint Germain en Laye", "78100 Saint Germain en Laye", "Saint Germain en Laye"],
      ["1 rue X, 92200 Neuilly sur Seine", "92200 Neuilly sur Seine", "Neuilly sur Seine"],
      ["1 rue X, 72000 Le Mans", "72000 Le Mans", "Le Mans"],
      ["1 rue X, 59650 Villeneuve d'Ascq", "59650 Villeneuve d'Ascq", "Villeneuve d'Ascq"],
      ["1 rue X 75008 PARIS", "75008 PARIS", "PARIS"],
      // Texte libre après la commune (nom du client, code d'accès, n° de chambre ou de rue) : jamais repris
      ["5 rue X 75011 Paris - interphone DUPONT code 4589B", "75011", null],
      ["5 rue X 75011 Paris - interphone DUPONT", "75011", null],
      ["5 rue X 75011 Paris interphone DUPONT", "75011", null],
      ["5 rue X 75011 Paris chez M. Dupont", "75011", null],
      ["5 rue X 75011 Paris Dupont", "75011", null],
      ["5 rue X 75011 Paris (Mme Martin)", "75011", null],
      ["75011 Paris 14 rue Oberkampf, interphone Dupont", "75011", null],
      ["Hôtel Lutetia 45 boulevard Raspail 75006 Paris chambre 312 M. Martin", "75006", null],
      ["75008 Paris 8e Arrondissement", "75008", null],
      // Cinq chiffres pris dans un numéro plus long : ce n'est pas un code postal
      ["Code 0612345678 Dupont, 75011 Paris", "75011 Paris", "Paris"],
      ["Aéroport Paris-Charles de Gaulle, Terminal 2E", null, null],
      [null, null, null],
    ];
    for (const [address, area, city] of cases) {
      const [row] = await sql(`select private.address_area($1) as area, private.address_city($1) as city`, [address]);
      expect(row, String(address)).toEqual({ area, city });
    }
  });

  it("notification d'offre partenaire : ni le texte libre ni le nom du client qui suivent le code postal", async () => {
    const p = await networkPair();
    const ride = await rideOf(p, {
      pickup_address: "5 rue X 75011 Paris - interphone DUPONT code 4589B",
      dropoff_address: "Hôtel Lutetia 45 boulevard Raspail 75006 Paris chez M. Martin",
    });
    await toNetworkStage(ride.id);
    const offer = await pendingOffer(ride.id, p.partner.id);
    expect(offer).toBeTruthy();
    const [n] = await sql(`select title, body, data from public.notifications where offer_id = $1`, [offer!.id]);
    expect(n.data).toMatchObject({ pickup: "75011", dropoff: "arrivée communiquée après acceptation" });
    for (const secret of ["DUPONT", "interphone", "4589B", "Martin", "chez", "Raspail"]) {
      expect(JSON.stringify(n), secret).not.toContain(secret);
    }
  });
});

// =============================================================================
// n° 7 — Réseau impossible : NO_DRIVER_FOUND au même moment qu'aujourd'hui
// =============================================================================
describe("Réseau impossible : dispatch.network_skipped et NO_DRIVER_FOUND à 180 s (§14.1 n° 7)", () => {
  /** 6 vagues propres, puis le 7e passage conclut tout de suite (aucune vague réseau). */
  async function expectSkipped(p: Pick<Pair, "A" | "site">, reason: string | null, overrides: Record<string, unknown> = {}) {
    const ride = await createRideAsOwner(p.A, { pickup_lat: p.site[0], pickup_lng: p.site[1], ...overrides });
    await nextWave(ride.id, 5);
    expect((await rideState(ride.id)).ride.dispatch_wave).toBe(6);
    await nextWave(ride.id);
    const st = await rideState(ride.id);
    expect(st.ride.status).toBe("NO_DRIVER_FOUND");
    expect(st.ride.dispatch_wave).toBe(6);
    expect(st.ride.network_at).toBeNull();
    expect(st.offers.filter((o) => o.is_network)).toHaveLength(0);
    expect(st.events.filter((e) => e.type === "dispatch.network")).toHaveLength(0);
    const skipped = st.events.filter((e) => e.type === "dispatch.network_skipped");
    if (reason) {
      expect(skipped.map((e) => e.data.reason)).toEqual([reason]);
    } else {
      expect(skipped).toHaveLength(0);
    }
    expect(st.events.find((e) => e.type === "dispatch.no_driver").message).toBe(
      "Personne n'a accepté la course (4 km → 8 km → 12 km → 16 km, relance 4 km → 8 km) — attribuez-la ou relancez",
    );
    expect(await sql(`select 1 from public.ride_network_shares where ride_id = $1`, [ride.id])).toHaveLength(0);
    return st;
  }

  it("course sans prix → no_price (« Course sans prix : non proposée au réseau partagé »)", async () => {
    const p = await networkPair();
    const st = await expectSkipped(p, "no_price", { price_cents: null });
    expect(st.events.find((e) => e.type === "dispatch.network_skipped").message).toBe(
      "Course sans prix : non proposée au réseau partagé",
    );
  });

  it("part du chauffeur nulle → no_payout", async () => {
    const p = await networkPair();
    await sql(`update public.organizations set platform_fee_fixed_cents = 8000 where id = $1`, [p.A.id]);
    await expectSkipped(p, "no_payout");
  });

  it("aucun partenaire à proximité → no_partner_nearby", async () => {
    const p = await networkPair();
    const far = north(p.site, 30000);
    await sql(`update public.driver_locations set lat = $2, lng = $3 where driver_id = $1`, [p.partner.id, far[0], far[1]]);
    const st = await expectSkipped(p, "no_partner_nearby");
    expect(st.events.find((e) => e.type === "dispatch.network_skipped").message).toBe(
      "Non proposée au réseau partagé : aucun chauffeur partenaire à proximité",
    );
  });

  it("interrupteur coupé : aucun événement réseau, comportement d'avant", async () => {
    const p = await networkPair();
    await setSharedNetwork(false);
    await expectSkipped(p, null);
  });

  it("A non validée / suspendue du réseau / frais Rydar à 0 sans dérogation / convention périmée hors grâce", async () => {
    const pending = await networkPair();
    await sql(`update public.network_memberships set approved_at = null where organization_id = $1`, [pending.A.id]);
    await expectSkipped(pending, "approval_pending");

    const suspended = await networkPair();
    await sql(`update public.network_memberships set suspended_at = now(), suspended_reason = 'test' where organization_id = $1`, [
      suspended.A.id,
    ]);
    await expectSkipped(suspended, "suspended");

    const free = await networkPair();
    await sql(`update public.organizations set platform_fee_percent = 0, platform_fee_fixed_cents = 0 where id = $1`, [free.A.id]);
    await expectSkipped(free, "platform_fee");
    // Dérogation cochée à la validation : partage possible
    await sql(`update public.network_memberships set fee_waiver = true where organization_id = $1`, [free.A.id]);
    const waived = await rideOf(free);
    await toNetworkStage(waived.id);
    expect((await rideState(waived.id)).ride.network_at).not.toBeNull();

    const outdated = await networkPair();
    await sql(`update public.network_memberships set terms_version = '2020-01-01' where organization_id = $1`, [outdated.A.id]);
    await expectSkipped(outdated, "terms");
  });

  it("versement réseau en retard de plus de 7 jours → payouts_overdue ; B exclue par A → no_partner_nearby", async () => {
    const p = await networkPair();
    const payee = await readyPartner(p.B, { firstName: "Paul", at: north(p.site, 800) });
    await sql(`update public.driver_network_settings set enabled = false where driver_id = $1`, [p.partner.id]);
    const { ride, execution } = await partnerAccepts(p, payee, { payment_method: "online" });
    await networkSettlement(p, payee, ride.id, execution.id, {
      direction: "centrale_owes", amount: 6480, dueAt: new Date(Date.now() - 8 * 86_400_000).toISOString(),
    });
    await expectSkipped(p, "payouts_overdue");

    const q = await networkPair();
    await sql(`insert into public.network_exclusions (organization_id, excluded_org_id) values ($1, $2)`, [q.A.id, q.B.id]);
    await expectSkipped(q, "no_partner_nearby");
  });

  it("organisation qui ne partage pas : aucun événement réseau", async () => {
    const A = await createOrg(`Sans partage ${tag()}`);
    await expectSkipped({ A, site: nextSite() }, null);
  });
});

// =============================================================================
// n° 8 — Arrêt anticipé
// =============================================================================
describe("Arrêt anticipé (§14.1 n° 8)", () => {
  it("le seul partenaire refuse : fin immédiate, refus journalisé sans nom ni identifiant", async () => {
    const p = await networkPair();
    const ride = await rideOf(p);
    await toNetworkStage(ride.id);
    const offer = await pendingOffer(ride.id, p.partner.id);
    expect(await decline(p.partner, offer!.id)).toMatchObject({ ok: true, code: "DECLINED" });
    // Le refus de toutes les offres avance la vague : le passage suivant conclut sans attendre les vagues 8 à 10
    await sql("select private.dispatch_tick()");
    const st = await rideState(ride.id);
    expect(st.ride.status).toBe("NO_DRIVER_FOUND");
    expect(st.ride.dispatch_wave).toBe(7);
    const end = st.events.find((e) => e.type === "dispatch.no_driver");
    expect(end.data).toMatchObject({ network: true, partners_offered: 1 });
    const declined = st.events.find((e) => e.type === "offer.declined");
    expect(declined).toMatchObject({ message: "Un chauffeur du réseau partagé refuse la course", actor_type: "driver", actor_id: null });
    expect(declined.data).toEqual({ offer_id: offer!.id, network: true });
    expect(JSON.stringify(st.events)).not.toContain(p.partner.id);
    expect(JSON.stringify(st.events)).not.toContain("Tazi");
  });

  it("partenaire encore en attente : pas d'arrêt ; un autre partenaire à solliciter plus loin : pas d'arrêt", async () => {
    const p = await networkPair();
    const farid = await readyPartner(p.B, { firstName: "Farid", at: north(p.site, 10000) });
    const ride = await rideOf(p);
    await toNetworkStage(ride.id);
    const offer = await pendingOffer(ride.id, p.partner.id);
    await decline(p.partner, offer!.id);
    await sql("select private.dispatch_tick()");
    let st = await rideState(ride.id);
    // Farid (10 km) reste sollicitable : vague 8 (8 km) sans lui, la recherche continue
    expect(st.ride.status).toBe("SEARCHING_DRIVER");
    expect(st.ride.dispatch_wave).toBe(8);
    await nextWave(ride.id);
    st = await rideState(ride.id);
    expect(st.ride.status).toBe("OFFERED");
    expect((await pendingOffer(ride.id, farid.id))?.wave).toBe(9);
  });
});

// =============================================================================
// n° 9 — Partenaire non sollicité
// =============================================================================
describe("Partenaire non sollicité (§14.1 n° 9)", () => {
  it("chaque raison d'inéligibilité du chauffeur, et jamais dans les candidats", async () => {
    const p = await networkPair();
    const ride = await rideOf(p);
    const cases: Array<[string, (d: Driver) => Promise<void>, string]> = [
      ["sans accord", async (d) => {
        await sql(`update public.driver_network_settings set enabled = false where driver_id = $1`, [d.id]);
      }, "consent"],
      ["non autorisé par B", async (d) => {
        await sql(`update public.driver_network_settings set org_allowed = false where driver_id = $1`, [d.id]);
      }, "consent"],
      ["conditions d'une ancienne version", async (d) => {
        await sql(`update public.driver_network_settings set accepted_version = '2020-01-01' where driver_id = $1`, [d.id]);
      }, "consent"],
      ["application ancienne", async (d) => {
        await sql(`update public.driver_network_settings set capable_at = now() - interval '8 days' where driver_id = $1`, [d.id]);
      }, "app_update"],
      ["assurance expirée", async (d) => {
        await sql(`update public.driver_documents set expires_at = current_date - 1 where driver_id = $1 and type = 'insurance'`, [d.id]);
      }, "documents"],
      ["carte grise non validée", async (d) => {
        await sql(`update public.driver_documents set status = 'pending' where driver_id = $1 and type = 'vehicle_registration'`, [d.id]);
      }, "documents"],
      ["n° de carte VTC absent", async (d) => {
        await sql(`update public.drivers set vtc_card_number = null where id = $1`, [d.id]);
      }, "documents"],
      ["banni par A (fiche de B non cochée)", async (d) => {
        await sql(
          `insert into public.banned_identities (scope, organization_id, kind, value_hash, reason) values ('org', $1, 'phone', $2, 'test')`,
          [p.A.id, await phoneHash(d.id)],
        );
      }, "banned"],
      ["banni de la plateforme", async (d) => {
        await sql(`insert into public.banned_identities (scope, kind, value_hash, reason) values ('platform', 'phone', $1, 'test')`, [
          await phoneHash(d.id),
        ]);
      }, "banned"],
      ["plaque bannie par A", async (d) => {
        const [v] = await sql(`select v.plate from public.vehicles v join public.drivers x on x.vehicle_id = v.id where x.id = $1`, [d.id]);
        await sql(
          `insert into public.banned_identities (scope, organization_id, kind, value_hash, reason)
           values ('org', $1, 'plate', private.identity_hash('plate', $2), 'test')`,
          [p.A.id, v.plate],
        );
      }, "banned"],
      ["ancienne fiche de A suspendue", async (d) => {
        await giverFiche(p.A, d, "suspended");
      }, "giver_driver"],
      ["ancienne fiche de A active", async (d) => {
        await giverFiche(p.A, d, "active");
      }, "giver_driver"],
      ["ancienne fiche de A archivée mais endettée", async (d) => {
        const fiche = await giverFiche(p.A, d, "inactive");
        await ownDebt(p.A, fiche.id);
      }, "giver_driver"],
      ["compte supprimé chez A avec une dette propre", async (d) => {
        const fiche = await createDriver(p.A, { firstName: "Supprime", status: "inactive" });
        await ownDebt(p.A, fiche.id);
        await sql(
          `insert into private.debtor_identities (organization_id, driver_id, driver_number, kind, value_hash)
           values ($1, $2, $3, 'phone', $4)`,
          [p.A.id, fiche.id, fiche.number, await phoneHash(d.id)],
        );
      }, "debtor"],
      ["exclu par A", async (d) => {
        await sql(
          `insert into private.network_driver_exclusions (giver_org_id, label, kinds, value_hashes) values ($1, 'Karim T.', '{phone}', $2)`,
          [p.A.id, [await phoneHash(d.id)]],
        );
      }, "excluded"],
      ["exclu automatiquement (retraits répétés)", async (d) => {
        await sql(`update public.driver_network_settings set excluded_until = now() + interval '30 days' where driver_id = $1`, [d.id]);
      }, "excluded_until"],
      ["plafond de B atteint", async () => {
        await sql(`update public.network_memberships set executor_credit_limit_cents = 0 where organization_id = $1`, [p.B.id]);
      }, "executor_limit"],
    ];
    for (const [label, setup, reason] of cases) {
      const d = await readyPartner(p.B, { firstName: `Cas${tag()}`, at: north(p.site, 800) });
      expect(await driverReason(d.id, ride.id), `${label} (avant)`).toBeNull();
      await setup(d);
      expect(await driverReason(d.id, ride.id), label).toBe(reason);
      expect(await candidateIds(ride.id), label).not.toContain(d.id);
      if (reason === "executor_limit") {
        await sql(`update public.network_memberships set executor_credit_limit_cents = 15000 where organization_id = $1`, [p.B.id]);
      }
    }
    // Les partenaires « propres » restent candidats
    expect(await candidateIds(ride.id)).toContain(p.partner.id);
  });

  it("documents valables aujourd'hui mais pas à la date de prise en charge (planifiée)", async () => {
    const p = await networkPair();
    const ride = await rideOf(p, { pickup_at: inMinutes(3 * 24 * 60) });
    expect(await driverReason(p.partner.id, ride.id)).toBeNull();
    await sql(`update public.driver_documents set expires_at = current_date + 1 where driver_id = $1 and type = 'driving_license'`, [
      p.partner.id,
    ]);
    expect(await driverReason(p.partner.id, ride.id)).toBe("documents");
  });

  it("B centrale : n° d'exploitant VTC du chauffeur exigé", async () => {
    const p = await networkPair();
    await sql(`update public.organizations set dispatch_model = 'centrale' where id = $1`, [p.B.id]);
    const ride = await rideOf(p);
    expect(await driverReason(p.partner.id, ride.id)).toBe("operator_registration");
    await sql(`update public.drivers set vtc_operator_registration = 'EVTC075990001' where id = $1`, [p.partner.id]);
    expect(await driverReason(p.partner.id, ride.id)).toBeNull();
  });

  it("débiteur réseau de A au compte supprimé : bloqué sous sa nouvelle fiche", async () => {
    const p = await networkPair();
    const old = await readyPartner(p.B, { firstName: "Ancien", at: north(p.site, 800) });
    await sql(`update public.driver_network_settings set enabled = false where driver_id = $1`, [p.partner.id]);
    const { ride, execution } = await partnerAccepts(p, old, { payment_method: "cash" });
    await networkSettlement(p, old, ride.id, execution.id, { direction: "driver_owes", amount: 720 });
    // Compte supprimé (fiche figée) : empreinte gardée pour A tant que la dette est ouverte
    await sql(
      `insert into private.network_debtor_identities (creditor_org_id, driver_id, kind, value_hash) values ($1, $2, 'phone', $3)`,
      [p.A.id, old.id, await phoneHash(old.id)],
    );
    // Il revient par une autre organisation C avec le même téléphone
    const C = await createOrg(`Executante C ${tag()}`);
    await enableNetwork(C, { in: true });
    await approveNetwork(C);
    const again = await readyPartner(C, { firstName: "Revenu", at: north(p.site, 800) });
    await sql(`update public.drivers set phone = (select phone from public.drivers where id = $2) where id = $1`, [again.id, old.id]);
    const next = await rideOf(p);
    expect(await driverReason(again.id, next.id)).toBe("debtor");
    // Dette réglée : plus bloqué
    await sql(`update public.ride_settlements set status = 'paid', settled_at = now() where ride_id = $1`, [ride.id]);
    expect(await driverReason(again.id, next.id)).toBeNull();
  });

  it("créneau pris (course qui chevauche) et blocages de A (impayé, plafond)", async () => {
    const p = await networkPair();
    const ride = await rideOf(p, { pickup_at: inMinutes(180) });
    // Course propre de B acceptée qui chevauche : busy
    const busy = await readyPartner(p.B, { firstName: "Occupe", at: north(p.site, 800) });
    const own = await insertRideBypass(p.B, {
      status: "ACCEPTED", type: "scheduled", driver_id: busy.id, pickup_at: new Date(Date.now() + 200 * 60_000),
    });
    expect(await driverReason(busy.id, ride.id)).toBe("busy");
    expect(await candidateIds(ride.id, 16000, true)).not.toContain(busy.id);
    // Hors de l'intervalle (4 h plus tard) : libre
    await sql(`update public.rides set pickup_at = now() + interval '8 hours' where id = $1`, [own]);
    expect(await driverReason(busy.id, ride.id)).toBeNull();

    // Impayé envers A (règle de A, courses de A seulement)
    const debtor = await readyPartner(p.B, { firstName: "Retard", at: north(p.site, 800) });
    await sql(`update public.driver_network_settings set enabled = false where driver_id = $1`, [p.partner.id]);
    const accepted = await partnerAccepts(p, debtor, { payment_method: "cash" });
    await networkSettlement(p, debtor, accepted.ride.id, accepted.execution.id, { direction: "driver_owes", amount: 720 });
    const later = await rideOf(p, { pickup_at: inMinutes(24 * 60) });
    expect(await driverReason(debtor.id, later.id)).toBe("giver_unpaid");
    // … mais pas pour une autre donneuse C
    const C = await createOrg(`Donneuse C ${tag()}`);
    await enableNetwork(C, { out: true });
    await approveNetwork(C);
    const fromC = await ownRide(C, p, { pickup_at: inMinutes(24 * 60) });
    expect(await driverReason(debtor.id, fromC.id)).toBeNull();
    // Plafond de A : encours + part de A de cette course
    await sql(`update public.organization_settings set block_unpaid = false, settlement_credit_limit_cents = 1000 where organization_id = $1`, [
      p.A.id,
    ]);
    expect(await driverReason(debtor.id, later.id)).toBe("giver_credit_limit");
    await sql(`update public.organization_settings set settlement_credit_limit_cents = 100000 where organization_id = $1`, [p.A.id]);
    expect(await driverReason(debtor.id, later.id)).toBeNull();
  });

  it("dette propre chez B (centrale) : plus aucune offre réseau (own_unpaid)", async () => {
    const p = await networkPair();
    await sql(`update public.organizations set dispatch_model = 'centrale' where id = $1`, [p.B.id]);
    await sql(`update public.drivers set vtc_operator_registration = 'EVTC075990002' where id = $1`, [p.partner.id]);
    const ride = await rideOf(p);
    expect(await driverReason(p.partner.id, ride.id)).toBeNull();
    await ownDebt(p.B, p.partner.id);
    expect(await driverReason(p.partner.id, ride.id)).toBe("own_unpaid");
  });
});

// =============================================================================
// n° 10 — Planifiées : fenêtre réseau 2 h avant
// =============================================================================
describe("Planifiée : fenêtre réseau à prise en charge − 2 h (§14.1 n° 10)", () => {
  it("flotte de A seule avant la fenêtre, partenaires dedans, fermée à T-lead puis rouverte après les vagues GPS propres", async () => {
    const p = await networkPair();
    const ride = await rideOf(p, { pickup_at: inMinutes(100) });
    let st = await rideState(ride.id);
    expect(st.ride.type).toBe("scheduled");
    expect(st.ride.dispatch_mode).toBe("fleet");
    // Réveil au plus tard à l'ouverture de la fenêtre (début + 15 min ici) : 5 min d'abord
    const [due] = await sql(
      `select next_dispatch_at <= now() + interval '5 minutes' + interval '2 seconds' as soon from public.rides where id = $1`,
      [ride.id],
    );
    expect(due.soon).toBe(true);

    // Avant la fenêtre (2 h avant, mais jamais moins de 15 min après le début) : chauffeurs de A seulement
    await nextWave(ride.id);
    st = await rideState(ride.id);
    expect(st.ride.network_at).toBeNull();
    expect(st.offers).toHaveLength(0);

    // Dans la fenêtre : réseau ouvert, offre « planifiée » au partenaire (sans présence exigée)
    await sql(`update public.drivers set presence = 'offline' where id = $1`, [p.partner.id]);
    await sql(`update public.rides set dispatch_started_at = now() - interval '20 minutes' where id = $1`, [ride.id]);
    await nextWave(ride.id);
    st = await rideState(ride.id);
    expect(st.ride.network_at).not.toBeNull();
    expect(st.ride.status).toBe("OFFERED");
    expect(st.ride.dispatch_mode).toBe("fleet");
    const opened = st.events.find((e) => e.type === "dispatch.network");
    expect(opened.data).toMatchObject({ stage: "scheduled_window", cycle: 1, partners_nearby: 1 });
    expect(opened.message).toBe("Course planifiée toujours sans chauffeur — proposée aussi au réseau partagé");
    // Pas d'explication « chauffeurs en ligne » pour la fenêtre (la flotte n'est pas sollicitée par position)
    expect(st.events.filter((e) => e.type === "dispatch.excluded")).toHaveLength(0);
    const offer = await pendingOffer(ride.id, p.partner.id);
    expect(offer).toMatchObject({ mode: "fleet", wave: 1 });
    const [n] = await sql(`select type, title, body from public.notifications where offer_id = $1`, [offer!.id]);
    expect(n.type).toBe("ride_offer_scheduled");
    expect(n.title).toBe("COURSE PARTENAIRE PLANIFIÉE");
    expect(n.body).not.toContain("Champs");
    const [share] = await sql(`select * from public.ride_network_shares where ride_id = $1`, [ride.id]);
    expect(share).toMatchObject({ status: "open", opened_stage: "scheduled_window", partners_offered: 1 });
    // Passage suivant dans la fenêtre : pas de seconde offre au même partenaire
    await nextWave(ride.id);
    expect((await rideState(ride.id)).offers.filter((o) => o.is_network)).toHaveLength(1);

    // T-lead : offres partenaires fermées, partage clos (« window_elapsed »), vagues GPS avec les seuls chauffeurs de A
    await sql(`update public.drivers set presence = 'available' where id = $1`, [p.partner.id]);
    await sql(`update public.organization_settings set scheduled_dispatch_lead_minutes = 120 where organization_id = $1`, [p.A.id]);
    await nextWave(ride.id);
    st = await rideState(ride.id);
    expect(st.ride.dispatch_mode).toBe("geo");
    expect(st.ride.network_at).toBeNull();
    expect(st.ride.dispatch_wave).toBe(1);
    const [old] = await sql(`select status, closed_reason from public.ride_offers where id = $1`, [offer!.id]);
    expect(old).toEqual({ status: "expired", closed_reason: "fleet_window_elapsed" });
    const [closed] = await sql(`select status, closed_reason from public.ride_network_shares where ride_id = $1`, [ride.id]);
    expect(closed).toEqual({ status: "closed", closed_reason: "window_elapsed" });
    for (let wave = 2; wave <= 6; wave++) {
      await nextWave(ride.id);
      st = await rideState(ride.id);
      expect(st.ride.dispatch_wave).toBe(wave);
      expect(st.offers.filter((o) => o.is_network && o.status === "pending")).toHaveLength(0);
    }

    // Après les vagues GPS propres : réouverture (« scheduled_geo », cycle 2), le partenaire est de nouveau sollicité
    await nextWave(ride.id);
    st = await rideState(ride.id);
    expect(st.ride.network_at).not.toBeNull();
    const reopened = st.events.filter((e) => e.type === "dispatch.network");
    expect(reopened.at(-1).data).toMatchObject({ stage: "scheduled_geo", cycle: 2 });
    expect(await pendingOffer(ride.id, p.partner.id)).toMatchObject({ mode: "geo", wave: 7 });
    const [share2] = await sql(`select status, cycle, opened_stage from public.ride_network_shares where ride_id = $1`, [ride.id]);
    expect(share2).toEqual({ status: "open", cycle: 2, opened_stage: "scheduled_geo" });
  });

  it("fenêtre sans partenaire à proximité : raison journalisée une fois, nouvel essai à chaque passage", async () => {
    const p = await networkPair();
    const far = north(p.site, 30000);
    await sql(`update public.driver_locations set lat = $2, lng = $3 where driver_id = $1`, [p.partner.id, far[0], far[1]]);
    const ride = await rideOf(p, { pickup_at: inMinutes(100) });
    await sql(`update public.rides set dispatch_started_at = now() - interval '20 minutes' where id = $1`, [ride.id]);
    await nextWave(ride.id, 2);
    let st = await rideState(ride.id);
    expect(st.ride.network_at).toBeNull();
    expect(st.events.filter((e) => e.type === "dispatch.network_skipped").map((e) => e.data.reason)).toEqual(["no_partner_nearby"]);
    // Partenaire revenu à proximité : partage ouvert au passage suivant
    const near = north(p.site, 800);
    await sql(`update public.driver_locations set lat = $2, lng = $3, updated_at = now() where driver_id = $1`, [
      p.partner.id, near[0], near[1],
    ]);
    await nextWave(ride.id);
    st = await rideState(ride.id);
    expect(st.ride.network_at).not.toBeNull();
    expect(await pendingOffer(ride.id, p.partner.id)).toMatchObject({ mode: "fleet" });
  });

  it("fenêtre après T-lead (course créée 70 min avant) : flotte de A, puis vagues GPS propres, puis réseau « scheduled_geo »", async () => {
    const p = await networkPair();
    const ride = await rideOf(p, { pickup_at: inMinutes(70) });
    let st = await rideState(ride.id);
    expect(st.ride).toMatchObject({ type: "scheduled", dispatch_mode: "fleet" });
    // Fenêtre réseau (début + 15 min) au-delà de T-lead (prise en charge − 60 min) : jamais ouverte pendant la flotte
    const [w] = await sql(
      `select private.network_window_at(r) >= r.pickup_at - interval '60 minutes' as after_lead from public.rides r where r.id = $1`,
      [ride.id],
    );
    expect(w.after_lead).toBe(true);
    await nextWave(ride.id);
    st = await rideState(ride.id);
    expect(st.ride).toMatchObject({ dispatch_mode: "fleet", network_at: null });
    expect(st.offers.filter((o) => o.is_network)).toHaveLength(0);

    // 11 min plus tard : T-lead dépassée (fenêtre réseau jamais atteinte) → bascule GPS, chauffeurs de A seuls
    await sql(
      `update public.rides set pickup_at = now() + interval '59 minutes', dispatch_started_at = now() - interval '11 minutes' where id = $1`,
      [ride.id],
    );
    await nextWave(ride.id);
    st = await rideState(ride.id);
    expect(st.ride).toMatchObject({ dispatch_mode: "geo", dispatch_wave: 1, network_at: null });
    for (let wave = 2; wave <= 6; wave++) {
      await nextWave(ride.id);
      st = await rideState(ride.id);
      expect(st.ride.dispatch_wave).toBe(wave);
      expect(st.ride.network_at).toBeNull();
      expect(st.offers.filter((o) => o.is_network)).toHaveLength(0);
    }

    // Après les vagues GPS propres : partage ouvert (« scheduled_geo », premier cycle), offre GPS au partenaire
    await nextWave(ride.id);
    st = await rideState(ride.id);
    expect(st.ride.network_at).not.toBeNull();
    expect(st.events.filter((e) => e.type === "dispatch.network").map((e) => e.data)).toEqual([
      { partners_nearby: 1, stage: "scheduled_geo", cycle: 1 },
    ]);
    expect(await pendingOffer(ride.id, p.partner.id)).toMatchObject({ mode: "geo", wave: 7 });
  });

  it("course devenue non partageable dans la fenêtre : offres partenaires fermées (C15)", async () => {
    const p = await networkPair();
    const ride = await rideOf(p, { pickup_at: inMinutes(100) });
    await sql(`update public.rides set dispatch_started_at = now() - interval '20 minutes' where id = $1`, [ride.id]);
    await nextWave(ride.id);
    const offer = await pendingOffer(ride.id, p.partner.id);
    expect(offer).toBeTruthy();
    await sql(`update public.network_memberships set suspended_at = now(), suspended_reason = 'test' where organization_id = $1`, [p.A.id]);
    await nextWave(ride.id);
    const [o] = await sql(`select status, closed_reason from public.ride_offers where id = $1`, [offer!.id]);
    expect(o).toEqual({ status: "closed", closed_reason: "network_unavailable" });
  });
});

// =============================================================================
// n° 11 — Acceptation
// =============================================================================
describe("Acceptation (§14.1 n° 11)", () => {
  it("le partenaire accepte : course, attribution, exécution figée, journaux de A sans identifiant", async () => {
    const p = await networkPair();
    const [bOrg] = await sql(`select name from public.organizations where id = $1`, [p.B.id]);
    const ride = await rideOf(p);
    await toNetworkStage(ride.id);
    const offer = await pendingOffer(ride.id, p.partner.id);
    // Ancienne app : driver_offers() n'a jamais d'offre réseau
    const old = await as({ sub: p.partner.userId }, (q) => q(`select public.driver_offers() as o`));
    expect(old[0].o).toEqual([]);

    expect(await accept(p.partner, offer!.id)).toMatchObject({ ok: true, code: "ACCEPTED", ride_id: ride.id });
    const st = await rideState(ride.id);
    expect(st.ride).toMatchObject({ status: "ACCEPTED", driver_id: p.partner.id, driver_org_id: p.B.id, vehicle_id: p.partner.vehicleId });
    const [d] = await sql(`select presence, current_ride_id from public.drivers where id = $1`, [p.partner.id]);
    expect(d).toEqual({ presence: "en_route", current_ride_id: ride.id });
    const [share] = await sql(`select status from public.ride_network_shares where ride_id = $1`, [ride.id]);
    expect(share.status).toBe("accepted");

    const [e] = await sql(`select * from public.ride_network_executions where ride_id = $1`, [ride.id]);
    expect(e).toMatchObject({
      organization_id: p.A.id, executor_org_id: p.B.id, executor_driver_id: p.partner.id, offer_id: offer!.id,
      counterparty: "driver", driver_label: "Karim T.", ended_at: null,
    });
    expect(e.terms).toEqual(offer!.network_terms);
    expect(e.operator).toMatchObject({
      organization_id: p.B.id, name: bOrg.name, legal_name: `${bOrg.name} SAS`, siret: "12345678901234",
      vtc_registration: "EVTC075230001", dispatch_model: "fleet", driver_operator_registration: null,
    });
    expect(e.vehicle).toMatchObject({ model: "Classe E", category: "business", seats: 4 });
    expect(e.checks.vtc_card_number).toMatch(/^VTC/);
    expect(e.checks.insurance_expires_on).toBeTruthy();
    expect(e.checks.verified_at).toBeTruthy();
    const [versions] = await sql(`select network_terms_version as v from public.platform_settings where id`);
    expect([e.giver_terms_version, e.executor_terms_version, e.driver_terms_version]).toEqual([versions.v, versions.v, versions.v]);

    const accepted = st.events.find((x) => x.type === "offer.accepted");
    expect(accepted).toMatchObject({
      message: `Karim T. (${bOrg.name}) accepte — chauffeur du réseau partagé`, actor_type: "driver", actor_id: null,
    });
    expect(accepted.data).toMatchObject({ network: true, execution_id: e.id });
    expect(accepted.data).not.toHaveProperty("driver_id");
    expect(st.events.find((x) => x.type === "dispatch.assigned").message).not.toContain("#");
    expect(JSON.stringify(st.events.map((x) => [x.message, x.data, x.actor_id]))).not.toContain(p.partner.id);
  });

  it("acceptation simultanée par le partenaire et un chauffeur de A : un seul gagnant", async () => {
    for (let round = 0; round < 3; round++) {
      const p = await networkPair();
      const ride = await rideOf(p);
      await toNetworkStage(ride.id);
      const own = await createDriver(p.A, { firstName: "Ahmed", at: north(p.site, 300) });
      await nextWave(ride.id);
      const ownOffer = await pendingOffer(ride.id, own.id);
      const partnerOffer = await pendingOffer(ride.id, p.partner.id);
      expect(ownOffer && partnerOffer).toBeTruthy();
      const results = await Promise.all([accept(own, ownOffer!.id), accept(p.partner, partnerOffer!.id)]);
      expect(results.filter((x) => x.ok)).toHaveLength(1);
      expect(results.filter((x) => !x.ok).map((x) => x.code)).toEqual(["RIDE_ALREADY_ASSIGNED"]);
      const assignments = await sql(`select driver_id from public.ride_assignments where ride_id = $1 and is_active`, [ride.id]);
      expect(assignments).toHaveLength(1);
      const executions = await sql(`select executor_driver_id from public.ride_network_executions where ride_id = $1`, [ride.id]);
      if (results[1].ok) {
        expect(executions.map((x) => x.executor_driver_id)).toEqual([p.partner.id]);
      } else {
        expect(executions).toHaveLength(0);
        // Le partenaire non retenu n'apparaît pas dans le journal de A
        const st = await rideState(ride.id);
        const late = st.events.find((x) => x.type === "offer.rejected_late");
        expect(late).toMatchObject({ message: "Un chauffeur du réseau partagé a tenté d'accepter — course déjà attribuée", actor_id: null });
        expect(JSON.stringify(st.events)).not.toContain(p.partner.id);
      }
    }
  });

  it("partenariat coupé entre l'offre et l'acceptation → OFFER_CLOSED (offre fermée « network_unavailable »)", async () => {
    const cuts: Array<[string, (p: Pair) => Promise<void>]> = [
      ["réception coupée par B", async (p) => {
        await sql(`update public.network_memberships set share_in = false where organization_id = $1`, [p.B.id]);
      }],
      ["B exclue par A", async (p) => {
        await sql(`insert into public.network_exclusions (organization_id, excluded_org_id) values ($1, $2)`, [p.A.id, p.B.id]);
      }],
      ["interrupteur coupé", async () => {
        await setSharedNetwork(false);
      }],
      ["chauffeur retiré du réseau par B", async (p) => {
        await sql(`update public.driver_network_settings set org_allowed = false where driver_id = $1`, [p.partner.id]);
      }],
    ];
    for (const [label, cut] of cuts) {
      await setSharedNetwork(true);
      const p = await networkPair();
      const ride = await rideOf(p);
      await toNetworkStage(ride.id);
      const offer = await pendingOffer(ride.id, p.partner.id);
      await cut(p);
      const res = await accept(p.partner, offer!.id);
      expect(res, label).toMatchObject({ ok: false, code: "OFFER_CLOSED" });
      const [o] = await sql(`select status, closed_reason from public.ride_offers where id = $1`, [offer!.id]);
      expect(o, label).toEqual({ status: "closed", closed_reason: "network_unavailable" });
      expect((await rideState(ride.id)).ride.driver_id, label).toBeNull();
    }
  });

  it("prix modifié : offres fermées « terms_changed » (OFFER_CHANGED), reproposées avec les nouveaux termes", async () => {
    const p = await networkPair();
    const ride = await rideOf(p);
    await toNetworkStage(ride.id);
    const offer = await pendingOffer(ride.id, p.partner.id);
    await as({ sub: p.A.ownerId }, (q) => q(`update public.rides set price_cents = 8000 where id = $1`, [ride.id]));
    const [closed] = await sql(`select status, closed_reason from public.ride_offers where id = $1`, [offer!.id]);
    expect(closed).toEqual({ status: "closed", closed_reason: "terms_changed" });
    expect(await accept(p.partner, offer!.id)).toMatchObject({
      ok: false, code: "OFFER_CHANGED", message: "La course a été modifiée : elle vous sera reproposée si elle est encore disponible.",
    });
    // Vague suivante : reproposée avec les nouveaux termes (une offre « terms_changed » n'exclut pas le chauffeur)
    await nextWave(ride.id);
    const again = await pendingOffer(ride.id, p.partner.id);
    expect(again?.network_terms).toEqual(networkTermsJson({ price: 8000, method: "card", fee: 800 }));
    expect(await accept(p.partner, again!.id)).toMatchObject({ ok: true });
  });

  it("taux de A changés sans toucher la course : offre périmée → OFFER_CHANGED", async () => {
    const p = await networkPair();
    const ride = await rideOf(p);
    await toNetworkStage(ride.id);
    const offer = await pendingOffer(ride.id, p.partner.id);
    await sql(`update public.organizations set platform_fee_percent = 12 where id = $1`, [p.A.id]);
    expect(await accept(p.partner, offer!.id)).toMatchObject({ ok: false, code: "OFFER_CHANGED" });
    const [o] = await sql(`select status, closed_reason from public.ride_offers where id = $1`, [offer!.id]);
    expect(o).toEqual({ status: "closed", closed_reason: "terms_changed" });
    expect((await rideState(ride.id)).ride.driver_id).toBeNull();
  });

  it("blocage du chauffeur : DRIVER_BLOCKED avec le message de la règle locale, offre laissée ouverte", async () => {
    const p = await networkPair();
    const [bOrg] = await sql(`select name from public.organizations where id = $1`, [p.B.id]);
    const ride = await rideOf(p);
    await toNetworkStage(ride.id);
    const offer = await pendingOffer(ride.id, p.partner.id);
    await sql(`update public.network_memberships set executor_credit_limit_cents = 0 where organization_id = $1`, [p.B.id]);
    expect(await accept(p.partner, offer!.id)).toEqual({
      ok: false, code: "DRIVER_BLOCKED", reason: "executor_limit",
      message: `Plafond de ${bOrg.name} atteint : réglez d'abord vos courses partenaires.`,
    });
    const [o] = await sql(`select status from public.ride_offers where id = $1`, [offer!.id]);
    expect(o.status).toBe("pending");
    await sql(`update public.network_memberships set executor_credit_limit_cents = 15000 where organization_id = $1`, [p.B.id]);
    expect(await accept(p.partner, offer!.id)).toMatchObject({ ok: true });
  });

  it("offre d'un cycle de partage précédent : OFFER_CLOSED", async () => {
    const p = await networkPair();
    const ride = await rideOf(p);
    await toNetworkStage(ride.id);
    const offer = await pendingOffer(ride.id, p.partner.id);
    // Nouveau cycle (réouverture) sans fermer l'ancienne offre : elle n'est plus du cycle courant
    await sql(`update public.rides set network_at = now() + interval '1 second' where id = $1`, [ride.id]);
    expect(await accept(p.partner, offer!.id)).toMatchObject({ ok: false, code: "OFFER_CLOSED" });
  });
});

// =============================================================================
// n° 12 — Créneau pris dans les deux sens
// =============================================================================
describe("DRIVER_BUSY_AT_TIME dans les deux sens (§14.1 n° 12)", () => {
  /** Course planifiée de A dans sa fenêtre réseau, offerte au partenaire. */
  async function scheduledNetworkOffer(p: Pair, minutes: number) {
    const ride = await rideOf(p, { pickup_at: inMinutes(minutes) });
    await sql(`update public.rides set dispatch_started_at = now() - interval '20 minutes' where id = $1`, [ride.id]);
    await nextWave(ride.id);
    const offer = await pendingOffer(ride.id, p.partner.id);
    expect(offer, "offre réseau planifiée").toBeTruthy();
    return { ride, offer: offer! };
  }

  it("acceptation réseau refusée quand une course propre de B chevauche (offre fermée « driver_busy »)", async () => {
    const p = await networkPair();
    const { ride, offer } = await scheduledNetworkOffer(p, 100);
    // Course propre de B à la même heure, acceptée par le chauffeur
    const own = await ownRide(p.B, p, { pickup_at: inMinutes(110) });
    const ownOffer = await pendingOffer(own.id, p.partner.id);
    expect(await accept(p.partner, ownOffer!.id)).toMatchObject({ ok: true });
    expect(await accept(p.partner, offer.id)).toMatchObject({
      ok: false, code: "DRIVER_BUSY_AT_TIME", message: "Créneau déjà pris : une autre course de ce chauffeur chevauche celle-ci.",
    });
    const [o] = await sql(`select status, closed_reason from public.ride_offers where id = $1`, [offer.id]);
    expect(o).toEqual({ status: "closed", closed_reason: "driver_busy" });
    expect((await rideState(ride.id)).ride.driver_id).toBeNull();
  });

  it("course partenaire acceptée : course propre de B refusée à l'acceptation et à l'attribution (assign_ride)", async () => {
    const p = await networkPair();
    const { offer } = await scheduledNetworkOffer(p, 100);
    expect(await accept(p.partner, offer.id)).toMatchObject({ ok: true });

    const own = await ownRide(p.B, p, { pickup_at: inMinutes(120) });
    const ownOffer = await pendingOffer(own.id, p.partner.id);
    expect(await accept(p.partner, ownOffer!.id)).toMatchObject({ ok: false, code: "DRIVER_BUSY_AT_TIME" });
    // Offre propre laissée ouverte (le chauffeur peut se libérer de la course partenaire)
    const [o] = await sql(`select status from public.ride_offers where id = $1`, [ownOffer!.id]);
    expect(o.status).toBe("pending");

    const dispatcher = await createMember(p.B, "dispatcher");
    const res = await as({ sub: dispatcher }, async (q) =>
      (await q(`select public.assign_ride($1, $2) as r`, [own.id, p.partner.id]))[0].r);
    expect(res).toMatchObject({ ok: false, code: "DRIVER_BUSY_AT_TIME" });
    expect((await rideState(own.id)).ride.driver_id).toBeNull();

    // Hors du créneau (4 h plus tard) : acceptée comme avant
    const later = await ownRide(p.B, p, { pickup_at: inMinutes(400) });
    const laterOffer = await pendingOffer(later.id, p.partner.id);
    expect(await accept(p.partner, laterOffer!.id)).toMatchObject({ ok: true });
  });

  it("entre ses propres courses, rien ne change (aucune course d'une autre organisation)", async () => {
    const org = await createOrg(`Sans reseau ${tag()}`);
    const d = await createDriver(org, { at: north(CHAMPS_ELYSEES, 500) });
    const first = await createRideAsOwner(org, { pickup_at: inMinutes(100) });
    const second = await createRideAsOwner(org, { pickup_at: inMinutes(110) });
    expect(await accept(d, (await pendingOffer(first.id, d.id))!.id)).toMatchObject({ ok: true });
    expect(await accept(d, (await pendingOffer(second.id, d.id))!.id)).toMatchObject({ ok: true });
  });
});

// =============================================================================
// Isolement (C8) : une erreur dans l'étape réseau ne bloque que sa course
// =============================================================================
describe("Erreur dans l'étape réseau (C8)", () => {
  it("course repoussée et erreur comptée, autres courses servies ; 3 erreurs → fin de la recherche", async () => {
    const p = await networkPair();
    const ride = await rideOf(p);
    // Course voisine (autre organisation, sans réseau) due au même passage
    const other = await createOrg(`Voisine ${tag()}`);
    await createDriver(other, { at: north(CHAMPS_ELYSEES, 600) });
    const otherRide = await createRideAsOwner(other);
    const client = await pool.connect();
    try {
      await client.query("begin");
      // Panne simulée des offres réseau (annulée avec la transaction)
      await client.query(`create or replace function private.network_offer(r public.rides, p_mode public.dispatch_mode,
          p_wave integer, p_radius integer, p_limit integer, p_expires timestamptz) returns integer language plpgsql
          set search_path = '' as $$ begin raise exception 'panne simulée'; end; $$`);
      await client.query(`update public.rides set dispatch_wave = 6 where id = $1`, [ride.id]);
      for (let attempt = 1; attempt <= 3; attempt++) {
        await client.query(`update public.rides set next_dispatch_at = now() - interval '1 second' where id = any($1)`, [
          [ride.id, otherRide.id],
        ]);
        const { rows: [tick] } = await client.query(`select private.dispatch_tick() as t`);
        expect(tick.t.waves).toBeGreaterThanOrEqual(1);
        const { rows: [r] } = await client.query(
          `select status, network_at, dispatch_wave, next_dispatch_at > now() as later from public.rides where id = $1`, [ride.id]);
        const { rows: errors } = await client.query(
          `select data, level from public.ride_events where ride_id = $1 and type = 'dispatch.network_error' order by id`, [ride.id]);
        expect(errors.map((e) => e.data.errors)).toEqual(Array.from({ length: attempt }, (_, i) => i + 1));
        expect(errors.every((e) => e.level === "warning")).toBe(true);
        if (attempt < 3) {
          // Étape annulée (réseau non ouvert, aucune offre), course repoussée d'un délai
          expect(r).toMatchObject({ status: "SEARCHING_DRIVER", network_at: null, dispatch_wave: 6, later: true });
        } else {
          expect(r).toMatchObject({ status: "NO_DRIVER_FOUND", network_at: null });
        }
        // La course voisine avance à chaque passage
        const { rows: [o] } = await client.query(`select dispatch_wave from public.rides where id = $1`, [otherRide.id]);
        expect(o.dispatch_wave).toBe(1 + attempt);
      }
      const { rows: [net] } = await client.query(
        `select count(*)::int as offers, (select count(*)::int from public.ride_events where ride_id = $1 and type = 'dispatch.network') as opened
           from public.ride_offers where ride_id = $1 and is_network`, [ride.id]);
      expect(net).toEqual({ offers: 0, opened: 0 });
      const { rows: [end] } = await client.query(
        `select message, data from public.ride_events where ride_id = $1 and type = 'dispatch.no_driver'`, [ride.id]);
      expect(end.data).toMatchObject({ network: true });
    } finally {
      await client.query("rollback").catch(() => undefined);
      client.release();
    }
  });

  it("3 erreurs pendant les vagues réseau, partage déjà ouvert : partage clos « error », fin de la recherche", async () => {
    const p = await networkPair();
    const ride = await rideOf(p);
    const client = await pool.connect();
    try {
      await client.query("begin");
      const tick = async () => {
        await client.query(`update public.rides set next_dispatch_at = now() - interval '1 second' where id = $1`, [ride.id]);
        await client.query("select private.dispatch_tick()");
      };
      const share = async () => (await client.query(
        `select status, closed_reason, errors, cycle from public.ride_network_shares where ride_id = $1`, [ride.id])).rows[0];
      // Vague 7 : partage ouvert, partenaire sollicité
      await client.query(`update public.rides set dispatch_wave = 6 where id = $1`, [ride.id]);
      await tick();
      expect(await share()).toEqual({ status: "open", closed_reason: null, errors: 0, cycle: 1 });
      // Panne des offres réseau à partir de la vague 8 (annulée avec la transaction)
      await client.query(`create or replace function private.network_offer(r public.rides, p_mode public.dispatch_mode,
          p_wave integer, p_radius integer, p_limit integer, p_expires timestamptz) returns integer language plpgsql
          set search_path = '' as $$ begin raise exception 'panne simulée'; end; $$`);
      await tick();
      await tick();
      expect(await share()).toMatchObject({ status: "open", errors: 2 });
      await tick();
      const { rows: [r] } = await client.query(`select status, network_at from public.rides where id = $1`, [ride.id]);
      expect(r).toEqual({ status: "NO_DRIVER_FOUND", network_at: null });
      expect(await share()).toEqual({ status: "closed", closed_reason: "error", errors: 3, cycle: 1 });
    } finally {
      await client.query("rollback").catch(() => undefined);
      client.release();
    }
  });
});

// =============================================================================
// Partie 3b — après l'acceptation : verrou, retraits, chien de garde, clôture, contrôles de fin
// =============================================================================
const AIRPORT = "Aéroport Paris-Charles de Gaulle, Terminal 2E, 95700 Roissy-en-France";
const paris = (at: Date, opts: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat("fr-FR", { ...opts, timeZone: "Europe/Paris" }).format(at);
/** « JJ/MM à HH:MM » à l'heure de Paris, comme les notifications du réseau. */
const when = (at: string | Date) =>
  `${paris(new Date(at), { day: "2-digit", month: "2-digit" })} à ${paris(new Date(at), { hour: "2-digit", minute: "2-digit" })}`;
/** Instant arrondi à la minute (heures recalées par le suivi de vol). */
const minuteFromNow = (minutes: number) => new Date(Math.ceil((Date.now() + minutes * 60_000) / 60_000) * 60_000);

async function orgName(org: Org): Promise<string> {
  const [o] = await sql(`select name from public.organizations where id = $1`, [org.id]);
  return o.name;
}

/** Planifiée de A (prise en charge dans `minutes`) dans sa fenêtre réseau, acceptée par le partenaire. */
async function scheduledPartnerAccepts(p: Pair, partner: Driver, minutes = 100, overrides: Record<string, unknown> = {}) {
  const ride = await rideOf(p, { pickup_at: inMinutes(minutes), ...overrides });
  await sql(`update public.rides set dispatch_started_at = now() - interval '20 minutes' where id = $1`, [ride.id]);
  await nextWave(ride.id);
  const offer = await pendingOffer(ride.id, partner.id);
  expect(offer, "offre réseau planifiée").toBeTruthy();
  expect(await accept(partner, offer!.id)).toMatchObject({ ok: true, code: "ACCEPTED" });
  const [execution] = await sql(`select * from public.ride_network_executions where ride_id = $1 and ended_at is null`, [ride.id]);
  return { ride, execution };
}

/** Étape déclarée par le chauffeur (application). */
async function stepAs(driver: Driver, rideId: string, status: string): Promise<Result & { status?: string }> {
  return as({ sub: driver.userId }, async (q) => (await q("select public.driver_update_ride_status($1, $2) as r", [rideId, status]))[0].r);
}

/** Position du chauffeur (reçue il y a ageSeconds). */
async function moveTo(driverId: string, at: [number, number], ageSeconds = 0) {
  await sql(
    `update public.driver_locations
        set lat = $2, lng = $3, recorded_at = now() - make_interval(secs => $4), updated_at = now() - make_interval(secs => $4)
      where driver_id = $1`,
    [driverId, at[0], at[1], ageSeconds],
  );
}

/** Surveillance du worker (private.watch_rides, chien de garde du réseau compris). */
async function watch(): Promise<Record<string, any>> {
  return (await sql("select private.watch_rides() as r"))[0].r;
}

const executionsOf = (rideId: string) =>
  sql(`select * from public.ride_network_executions where ride_id = $1 order by accepted_at`, [rideId]);
const shareOf = async (rideId: string) =>
  (await sql(`select status, closed_reason, cycle from public.ride_network_shares where ride_id = $1`, [rideId]))[0];
const notificationsOf = (rideId: string, driverId: string) =>
  sql(`select type, title, body, data, status from public.notifications where ride_id = $1 and driver_id = $2 order by created_at, id`, [
    rideId, driverId,
  ]);
const callAs = async (who: string, fn: string, args: unknown[]) =>
  as({ sub: who }, async (q) => (await q(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as r`, args))[0].r);

// =============================================================================
// n° 13 — Course confiée verrouillée (G6) ; vol retardé et retrait : permis
// =============================================================================
describe("Course confiée verrouillée (§14.1 n° 13)", () => {
  it("prix, paiement, commission, adresse, heure → NETWORK_RIDE_LOCKED (owner et dispatcher) ; retirée au partenaire : permis", async () => {
    const p = await networkPair({ model: "centrale" });
    const { ride } = await partnerAccepts(p, p.partner);
    const dispatcher = await createMember(p.A, "dispatcher");
    const edits: Array<[string, string]> = [
      ["prix", "update public.rides set price_cents = 9000 where id = $1"],
      ["paiement", "update public.rides set payment_method = 'cash' where id = $1"],
      ["commission", "update public.rides set commission_cents = 2000 where id = $1"],
      ["adresse", "update public.rides set pickup_address = '1 Rue de Rivoli, 75001 Paris', pickup_lat = pickup_lat + 0.001 where id = $1"],
    ];
    for (const who of [p.A.ownerId, dispatcher]) {
      for (const [label, text] of edits) {
        const err = await expectPgError(as({ sub: who }, (q) => q(text, [ride.id])));
        expect([label, err.code, err.message], label).toEqual([label, "55000", expect.stringContaining("NETWORK_RIDE_LOCKED")]);
      }
    }
    // L'heure (écrite par le serveur) aussi ; un commentaire reste modifiable (visible du partenaire après acceptation)
    expect((await expectPgError(sql(`update public.rides set pickup_at = pickup_at + interval '10 minutes' where id = $1`, [ride.id]))).code)
      .toBe("55000");
    await as({ sub: dispatcher }, (q) => q(`update public.rides set comment = 'Code portail 1234' where id = $1`, [ride.id]));

    // Retirée au partenaire (« Retirer ») : de nouveau modifiable
    expect(await callAs(p.A.ownerId, "reassign_ride", [ride.id, null, p.partner.id])).toMatchObject({ ok: true, code: "RELAUNCHED" });
    await as({ sub: dispatcher }, (q) => q(`update public.rides set price_cents = 9000, payment_method = 'cash' where id = $1`, [ride.id]));
    const [after] = await sql(`select price_cents, payment_method from public.rides where id = $1`, [ride.id]);
    expect(after).toEqual({ price_cents: 9000, payment_method: "cash" });
  });

  it("vol retardé d'une course tenue par un partenaire : l'heure suit le vol malgré le verrou, partenaire prévenu", async () => {
    const p = await networkPair();
    const pickup = minuteFromNow(100);
    const { ride } = await scheduledPartnerAccepts(p, p.partner, 100, {
      pickup_address: AIRPORT, flight_number: "AF 1234", pickup_at: pickup.toISOString(),
    });
    const [res] = await sql("select private.apply_flight_status($1, 'delayed', $2, $3) as r", [
      ride.id, pickup, new Date(pickup.getTime() + 40 * 60_000),
    ]);
    expect(res.r).toMatchObject({ ok: true, pickup_changed: true, delay_minutes: 40 });
    const st = await rideState(ride.id);
    expect(new Date(st.ride.pickup_at).getTime()).toBe(pickup.getTime() + 40 * 60_000);
    expect(st.ride).toMatchObject({ driver_id: p.partner.id, status: "ACCEPTED", flight_number: "AF 1234" });
    const [e] = await executionsOf(ride.id);
    expect(e.ended_at).toBeNull();
    const notes = await notificationsOf(ride.id, p.partner.id);
    expect(notes.find((n) => n.type === "flight_update")).toMatchObject({ title: "VOL RETARDÉ" });
    // Rappels recalés sur la nouvelle heure (prise en charge à +140 min : rappels 60 et 30 min avant)
    expect(notes.filter((n) => n.type === "ride_reminder" && n.status === "queued")).toHaveLength(2);
    // Hors suivi de vol, l'heure reste verrouillée
    expect((await expectPgError(sql(`update public.rides set pickup_at = pickup_at + interval '5 minutes' where id = $1`, [ride.id]))).code)
      .toBe("55000");
  });
});

// =============================================================================
// n° 10 (suite) — Vol retardé pendant la fenêtre réseau d'une planifiée (C13)
// =============================================================================
describe("Planifiée : vol retardé pendant la fenêtre réseau (§14.1 n° 10, C13)", () => {
  async function windowOffer(p: Pair, pickup: Date) {
    const ride = await rideOf(p, { pickup_address: AIRPORT, flight_number: "AF 1234", pickup_at: pickup.toISOString() });
    await sql(`update public.rides set dispatch_started_at = now() - interval '20 minutes' where id = $1`, [ride.id]);
    await nextWave(ride.id);
    const offer = await pendingOffer(ride.id, p.partner.id);
    expect(offer, "offre réseau planifiée").toBeTruthy();
    return { ride, offer: offer! };
  }

  it("nouvelle fenêtre pas encore ouverte : offres partenaires fermées « flight_rescheduled », partage clos, rouvert ensuite", async () => {
    const p = await networkPair();
    const pickup = minuteFromNow(100);
    const { ride, offer } = await windowOffer(p, pickup);
    // Retard de 60 min : prise en charge à +160 min, fenêtre réseau dans 40 min
    const [res] = await sql("select private.apply_flight_status($1, 'delayed', $2, $3) as r", [
      ride.id, pickup, new Date(pickup.getTime() + 60 * 60_000),
    ]);
    expect(res.r).toMatchObject({ ok: true, pickup_changed: true });
    let st = await rideState(ride.id);
    expect(st.ride).toMatchObject({ network_at: null, dispatch_mode: "fleet", driver_id: null });
    const [due] = await sql(`select next_dispatch_at <= now() + interval '5 minutes' as soon from public.rides where id = $1`, [ride.id]);
    expect(due.soon).toBe(true);
    const [o] = await sql(`select status, closed_reason from public.ride_offers where id = $1`, [offer.id]);
    expect(o).toEqual({ status: "closed", closed_reason: "flight_rescheduled" });
    expect(await sql(`select 1 from public.notifications where offer_id = $1`, [offer.id])).toHaveLength(0);
    expect(await shareOf(ride.id)).toMatchObject({ status: "closed", closed_reason: "flight_rescheduled" });

    // Passage suivant avant la nouvelle fenêtre : flotte de A seule
    await nextWave(ride.id);
    st = await rideState(ride.id);
    expect(st.ride.network_at).toBeNull();
    expect(st.offers.filter((x) => x.is_network && x.status === "pending")).toHaveLength(0);
    // Nouvelle fenêtre atteinte : partage rouvert (cycle 2), le partenaire est de nouveau sollicité
    await sql(`update public.rides set pickup_at = now() + interval '110 minutes' where id = $1`, [ride.id]);
    await nextWave(ride.id);
    st = await rideState(ride.id);
    expect(st.ride.network_at).not.toBeNull();
    expect(await shareOf(ride.id)).toMatchObject({ status: "open", cycle: 2 });
    expect(await pendingOffer(ride.id, p.partner.id)).toMatchObject({ mode: "fleet" });
  });

  it("fenêtre toujours ouverte (petit retard) : offres fermées « terms_changed » puis reproposées à la nouvelle heure", async () => {
    const p = await networkPair();
    const pickup = minuteFromNow(100);
    const { ride, offer } = await windowOffer(p, pickup);
    await sql("select private.apply_flight_status($1, 'delayed', $2, $3)", [ride.id, pickup, new Date(pickup.getTime() + 10 * 60_000)]);
    const st = await rideState(ride.id);
    expect(st.ride.network_at).not.toBeNull();
    const [o] = await sql(`select status, closed_reason from public.ride_offers where id = $1`, [offer.id]);
    expect(o).toEqual({ status: "closed", closed_reason: "terms_changed" });
    await nextWave(ride.id);
    const again = await pendingOffer(ride.id, p.partner.id);
    expect(again).toBeTruthy();
    expect(again!.id).not.toBe(offer.id);
    expect(await accept(p.partner, again!.id)).toMatchObject({ ok: true });
  });
});

// =============================================================================
// n° 14 — Retraits, chien de garde, organisations indisponibles, clôture
// =============================================================================
describe("Retraits et chien de garde (§14.1 n° 14)", () => {
  it("bannissement par B : course rendue à A (vague 0), rappels et notifications du partenaire supprimés sauf « COURSE RETIRÉE »", async () => {
    const p = await networkPair();
    const [aName, bName] = [await orgName(p.A), await orgName(p.B)];
    const { ride, execution } = await scheduledPartnerAccepts(p, p.partner, 100);
    const before = await notificationsOf(ride.id, p.partner.id);
    expect(before.filter((n) => n.type === "ride_reminder" && n.status === "queued")).toHaveLength(2);
    const [{ pickup_at: pickupAt }] = await sql(`select pickup_at from public.rides where id = $1`, [ride.id]);

    const res = await callAs(p.B.ownerId, "ban_driver", [p.partner.id, "Fraude constatée", "fraud"]);
    expect(res).toMatchObject({ ok: true, code: "BANNED", reassigned_rides: 1 });

    const st = await rideState(ride.id);
    expect(st.ride).toMatchObject({
      status: "SEARCHING_DRIVER", driver_id: null, driver_org_id: null, vehicle_id: null, network_at: null, dispatch_wave: 0,
      type: "scheduled", dispatch_mode: "fleet", accepted_at: null,
    });
    expect(new Date(st.ride.next_dispatch_at).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    const [e] = await executionsOf(ride.id);
    expect(e).toMatchObject({ id: execution.id, end_reason: "executor_released" });
    expect(await shareOf(ride.id)).toMatchObject({ status: "closed", closed_reason: "executor_released" });
    const [assignment] = await sql(`select is_active, release_reason from public.ride_assignments where ride_id = $1`, [ride.id]);
    expect(assignment).toEqual({ is_active: false, release_reason: "executor_released" });
    // Marqueur « retiré » (termes de l'exécution) : plus jamais sollicité pour cette course
    const marker = st.offers.find((o) => o.closed_reason === "removed_by_dispatch");
    expect(marker).toMatchObject({ driver_id: p.partner.id, is_network: true, status: "closed" });
    expect(marker.network_terms).toEqual(execution.terms);
    // Notifications du partenaire pour cette course : seulement « COURSE RETIRÉE — {A} », sans adresse
    expect(await notificationsOf(ride.id, p.partner.id)).toEqual([{
      type: "ride_unassigned",
      title: `COURSE RETIRÉE — ${aName}`,
      body: `${bName} vous a retiré la course de ${aName} du ${when(pickupAt)}.`,
      data: { type: "ride_unassigned", ride_id: ride.id, network: true, giver: aName, reason: "executor_released" },
      status: "queued",
    }]);
    // Journal de A : ni l'identifiant du partenaire, ni celui du membre de B qui a agi
    const ev = st.events.find((x) => x.type === "ride.network_unassigned");
    expect(ev).toMatchObject({
      actor_type: "system", actor_id: null, level: "warning",
      message: `${bName} a retiré la course à son chauffeur (Karim T.) — recherche relancée, vos chauffeurs d'abord`,
    });
    expect(ev.data).toMatchObject({ network: true, reason: "executor_released", execution_id: execution.id, previous_status: "ACCEPTED" });
    const journal = JSON.stringify(st.events.map((x) => [x.message, x.data, x.actor_id]));
    expect(journal).not.toContain(p.partner.id);
    expect(journal).not.toContain(p.B.ownerId);

    // La recherche repart chez A (flotte de A ; le partage ne rouvre qu'après 15 min) : il n'y est jamais resollicité
    await nextWave(ride.id);
    const again = await rideState(ride.id);
    expect(again.ride.network_at).toBeNull();
    expect(again.offers.filter((o) => o.driver_id === p.partner.id && o.status === "pending")).toHaveLength(0);
  });

  it("statut changé par B : course immédiate rendue, relancée chez A au passage suivant, partenaire exclu de cette course", async () => {
    const p = await networkPair();
    const { ride } = await partnerAccepts(p, p.partner);
    const res = await callAs(p.B.ownerId, "set_driver_status", [p.partner.id, "inactive", null]);
    expect(res).toMatchObject({ ok: true, code: "STATUS_CHANGED", reassigned_rides: 1 });
    let st = await rideState(ride.id);
    expect(st.ride).toMatchObject({ status: "SEARCHING_DRIVER", driver_id: null, dispatch_wave: 0, type: "instant", dispatch_mode: "geo" });
    const [d] = await sql(`select presence, current_ride_id from public.drivers where id = $1`, [p.partner.id]);
    expect(d).toEqual({ presence: "offline", current_ride_id: null });
    expect((await executionsOf(ride.id))[0].end_reason).toBe("executor_released");

    // Passage suivant : vague 1 chez A, ses chauffeurs d'abord
    const own = await createDriver(p.A, { firstName: "Ahmed", at: north(p.site, 300) });
    await nextWave(ride.id);
    st = await rideState(ride.id);
    expect(st.ride.dispatch_wave).toBe(1);
    expect(await pendingOffer(ride.id, own.id)).toBeTruthy();
    // Réactivé et disponible : jamais resollicité pour cette course
    await callAs(p.B.ownerId, "set_driver_status", [p.partner.id, "active", null]);
    await sql(`update public.drivers set presence = 'available' where id = $1`, [p.partner.id]);
    expect(await candidateIds(ride.id)).not.toContain(p.partner.id);
  });

  it("3 retraits en 30 jours → exclu du réseau 30 jours (offres fermées, alerte du super admin)", async () => {
    const p = await networkPair();
    const later = await rideOf(p, { pickup_at: inMinutes(110) });
    for (let round = 1; round <= 3; round++) {
      await sql(`update public.driver_locations set updated_at = now() where driver_id = $1`, [p.partner.id]);
      const { ride } = await partnerAccepts(p, p.partner);
      if (round < 3) {
        // B le suspend puis le réactive
        expect(await callAs(p.B.ownerId, "set_driver_status", [p.partner.id, "suspended", "Contrôle"])).toMatchObject({ reassigned_rides: 1 });
        await callAs(p.B.ownerId, "set_driver_status", [p.partner.id, "active", null]);
        await sql(`update public.drivers set presence = 'available' where id = $1`, [p.partner.id]);
        const [n] = await sql(`select excluded_until from public.driver_network_settings where driver_id = $1`, [p.partner.id]);
        expect(n.excluded_until, `retrait ${round}`).toBeNull();
      } else {
        // Une offre planifiée en attente ailleurs ; B le retire du réseau, le chien de garde rend la course
        await sql(`update public.rides set dispatch_started_at = now() - interval '20 minutes' where id = $1`, [later.id]);
        await nextWave(later.id);
        const pending = await pendingOffer(later.id, p.partner.id);
        expect(pending, "offre planifiée en attente").toBeTruthy();
        await sql(`update public.driver_network_settings set org_allowed = false where driver_id = $1`, [p.partner.id]);
        const w = await watch();
        expect(w.network.released).toBeGreaterThanOrEqual(1);
        expect((await executionsOf(ride.id))[0].end_reason).toBe("executor_released");
        const [o] = await sql(`select status, closed_reason from public.ride_offers where id = $1`, [pending!.id]);
        expect(o).toEqual({ status: "closed", closed_reason: "network_unavailable" });
      }
    }
    const [n] = await sql(
      `select excluded_until > now() + interval '29 days' and excluded_until < now() + interval '31 days' as ok
         from public.driver_network_settings where driver_id = $1`,
      [p.partner.id],
    );
    expect(n.ok).toBe(true);
    const audits = await sql(`select organization_id, actor_type, severity, metadata from public.audit_logs
                               where action = 'network.driver_auto_excluded' and entity_id = $1`, [p.partner.id]);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ organization_id: p.B.id, actor_type: "system", severity: "warning", metadata: { releases_30d: 3 } });
    // Autorisé de nouveau par B : toujours exclu (raison de lisibilité « excluded_until »)
    await sql(`update public.driver_network_settings set org_allowed = true where driver_id = $1`, [p.partner.id]);
    expect(await driverReason(p.partner.id, (await rideOf(p)).id)).toBe("excluded_until");
  });

  it("B suspendue : courses non commencées rendues à A par le chien de garde ; client à bord : alerte chez A et le chauffeur termine", async () => {
    const p = await networkPair();
    const bName = await orgName(p.B);
    const samir = await readyPartner(p.B, { firstName: "Samir", at: north(p.site, 900) });
    const notStarted = await partnerAccepts(p, p.partner);
    const onboard = await partnerAccepts(p, samir);
    for (const s of ["DRIVER_EN_ROUTE", "DRIVER_ARRIVED", "PASSENGER_ONBOARD"]) {
      await moveTo(samir.id, p.site);
      expect(await stepAs(samir, onboard.ride.id, s), s).toMatchObject({ ok: true });
    }
    await sql(`update public.organizations set status = 'suspended', suspended_at = now() where id = $1`, [p.B.id]);
    const w = await watch();
    expect(w.network).toMatchObject({ released: expect.any(Number), alerts: expect.any(Number) });
    expect(w.network.released).toBeGreaterThanOrEqual(1);

    // Non commencée : rendue à A (« executor_unavailable »)
    expect((await rideState(notStarted.ride.id)).ride).toMatchObject({ driver_id: null, status: "SEARCHING_DRIVER", network_at: null });
    expect((await executionsOf(notStarted.ride.id))[0].end_reason).toBe("executor_unavailable");
    const released = (await rideState(notStarted.ride.id)).events.find((x) => x.type === "ride.network_unassigned");
    expect(released.message).toBe(`Chauffeur partenaire indisponible (Karim T., ${bName}) — recherche relancée, vos chauffeurs d'abord`);
    // Client à bord : toujours tenue, une seule alerte chez A
    await watch();
    let st = await rideState(onboard.ride.id);
    expect(st.ride).toMatchObject({ driver_id: samir.id, status: "PASSENGER_ONBOARD" });
    const alerts = st.events.filter((x) => x.type === "network.executor_unavailable");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      level: "warning", actor_id: null,
      message: `Chauffeur partenaire indisponible, client à bord (Samir T., ${bName} : organisation suspendue) — il peut terminer la course ; sinon, clôturez-la`,
    });
    expect(alerts[0].data).toMatchObject({ network: true, execution_id: onboard.execution.id, cause: "executor_inactive" });

    // Le chauffeur termine malgré la suspension de son organisation (démarrage et fin seulement)
    expect(await stepAs(samir, onboard.ride.id, "IN_PROGRESS")).toMatchObject({ ok: true, status: "IN_PROGRESS" });
    expect(await stepAs(samir, onboard.ride.id, "COMPLETED")).toMatchObject({ ok: true, status: "COMPLETED" });
    st = await rideState(onboard.ride.id);
    expect(st.ride.status).toBe("COMPLETED");
    expect((await executionsOf(onboard.ride.id))[0].end_reason).toBe("completed");
    const [d] = await sql(`select presence, current_ride_id from public.drivers where id = $1`, [samir.id]);
    expect(d).toEqual({ presence: "offline", current_ride_id: null });
    // Hors de ce cas (course d'une autre étape, autre transition), l'organisation suspendue bloque comme avant
    const err = await expectPgError(stepAs(samir, notStarted.ride.id, "DRIVER_EN_ROUTE"));
    expect(err.code).toBe("42501");
  });

  it("client à bord : B ne peut ni bannir ni suspendre son chauffeur (message sans « annulez-la »), le chauffeur termine", async () => {
    const p = await networkPair();
    const { ride } = await partnerAccepts(p, p.partner);
    for (const s of ["DRIVER_EN_ROUTE", "DRIVER_ARRIVED", "PASSENGER_ONBOARD"]) {
      await moveTo(p.partner.id, p.site);
      expect(await stepAs(p.partner, ride.id, s)).toMatchObject({ ok: true });
    }
    expect(await callAs(p.B.ownerId, "set_driver_status", [p.partner.id, "suspended", "Contrôle"])).toEqual({
      ok: false, code: "DRIVER_ON_RIDE",
      message: "Client à bord d'une course partenaire : attendez la fin de la course avant de suspendre ce chauffeur.",
    });
    expect(await callAs(p.B.ownerId, "ban_driver", [p.partner.id, "Fraude constatée", "fraud"])).toEqual({
      ok: false, code: "DRIVER_ON_RIDE",
      message: "Client à bord d'une course partenaire : attendez la fin de la course avant de bannir ce chauffeur.",
    });
    // Écriture directe du statut par B : refusée aussi (droit retiré par l'audit 20260924006650 ; G7 en défense)
    const err = await expectPgError(as({ sub: p.B.ownerId }, (q) => q(`update public.drivers set status = 'inactive' where id = $1`, [p.partner.id])));
    expect(err.code).toBe("42501");
    expect((await rideState(ride.id)).ride).toMatchObject({ driver_id: p.partner.id, status: "PASSENGER_ONBOARD" });
  });

  it("offres réseau en attente devenues inacceptables (B suspendue, interrupteur coupé) : fermées par le chien de garde", async () => {
    const p = await networkPair();
    const ride = await rideOf(p, { pickup_at: inMinutes(100) });
    await sql(`update public.rides set dispatch_started_at = now() - interval '20 minutes' where id = $1`, [ride.id]);
    await nextWave(ride.id);
    const offer = await pendingOffer(ride.id, p.partner.id);
    expect(offer).toBeTruthy();
    // Encore acceptable : rien ne change
    await watch();
    expect(await pendingOffer(ride.id, p.partner.id)).toBeTruthy();
    // B suspendue par Rydar (statut de l'organisation) : offre fermée, notification d'offre supprimée
    await sql(`update public.organizations set status = 'suspended', suspended_at = now() where id = $1`, [p.B.id]);
    const w = await watch();
    expect(w.network.closed_offers).toBeGreaterThanOrEqual(1);
    const [o] = await sql(`select status, closed_reason from public.ride_offers where id = $1`, [offer!.id]);
    expect(o).toEqual({ status: "closed", closed_reason: "network_unavailable" });
    expect(await sql(`select 1 from public.notifications where offer_id = $1`, [offer!.id])).toHaveLength(0);

    // Interrupteur coupé : offres en attente fermées au passage suivant
    const q = await networkPair();
    const other = await rideOf(q, { pickup_at: inMinutes(100) });
    await sql(`update public.rides set dispatch_started_at = now() - interval '20 minutes' where id = $1`, [other.id]);
    await nextWave(other.id);
    const pending = await pendingOffer(other.id, q.partner.id);
    expect(pending).toBeTruthy();
    await setSharedNetwork(false);
    await watch();
    const [o2] = await sql(`select status, closed_reason from public.ride_offers where id = $1`, [pending!.id]);
    expect(o2).toEqual({ status: "closed", closed_reason: "network_unavailable" });
  });

  it("close_network_ride : refusée si le partenaire est actif et localisé (et aux dispatchers), permise sinon", async () => {
    const p = await networkPair();
    const samir = await readyPartner(p.B, { firstName: "Samir", at: north(p.site, 900) });
    const close = (who: string, rideId: string) => callAs(who, "close_network_ride", [rideId]);
    const first = await partnerAccepts(p, p.partner, { payment_method: "online" });
    const second = await partnerAccepts(p, samir);
    for (const [driver, rideId] of [[p.partner, first.ride.id], [samir, second.ride.id]] as const) {
      for (const s of ["DRIVER_EN_ROUTE", "DRIVER_ARRIVED", "PASSENGER_ONBOARD", "IN_PROGRESS"]) {
        await moveTo(driver.id, p.site);
        expect(await stepAs(driver, rideId, s), s).toMatchObject({ ok: true });
      }
    }
    // Chauffeur actif, position récente : refusée
    let err = await expectPgError(close(p.A.ownerId, first.ride.id));
    expect([err.code, err.message]).toEqual(["55000", expect.stringContaining("NETWORK_CLOSE_NOT_ALLOWED")]);
    // Dispatcher de A, membre de B : refusée (owner / admin de A seulement)
    const dispatcher = await createMember(p.A, "dispatcher");
    expect((await expectPgError(close(dispatcher, first.ride.id))).code).toBe("42501");
    expect((await expectPgError(close(p.B.ownerId, first.ride.id))).code).toBe("42501");

    // Plus de position depuis 35 min : permise, « à vérifier », versement prépayé retenu 72 h
    await moveTo(p.partner.id, p.site, 35 * 60);
    expect(await close(p.A.ownerId, first.ride.id)).toEqual({ ok: true, ride_id: first.ride.id, status: "COMPLETED" });
    const st = await rideState(first.ride.id);
    expect(st.ride.status).toBe("COMPLETED");
    const [e] = await executionsOf(first.ride.id);
    expect(e).toMatchObject({ end_reason: "completed", suspect_reasons: ["closed_by_giver"] });
    const [hold] = await sql(
      `select hold_until between now() + interval '71 hours' and now() + interval '73 hours' as ok from public.ride_network_executions where id = $1`,
      [e.id],
    );
    expect(hold.ok).toBe(true);
    const ev = st.events.find((x) => x.type === "ride.network_closed");
    expect(ev).toMatchObject({
      actor_type: "user", actor_id: p.A.ownerId, level: "warning",
      message: "Course clôturée par l'organisation (chauffeur partenaire Karim T. sans position depuis 30 min) — à vérifier",
    });
    const [audit] = await sql(`select organization_id, metadata from public.audit_logs where action = 'network.ride_closed' and entity_id = $1`, [
      first.ride.id,
    ]);
    expect(audit).toMatchObject({ organization_id: p.A.id, metadata: { cause: "no_position", execution_id: e.id } });
    const [d] = await sql(`select presence, current_ride_id from public.drivers where id = $1`, [p.partner.id]);
    expect(d).toEqual({ presence: "available", current_ride_id: null });

    // Second partenaire localisé : refusée, puis permise quand son organisation est suspendue ; payée à bord : sans retenue
    err = await expectPgError(close(p.A.ownerId, second.ride.id));
    expect(err.code).toBe("55000");
    await sql(`update public.organizations set status = 'suspended', suspended_at = now() where id = $1`, [p.B.id]);
    expect(await close(p.A.ownerId, second.ride.id)).toMatchObject({ ok: true, status: "COMPLETED" });
    const [e2] = await executionsOf(second.ride.id);
    expect(e2).toMatchObject({ end_reason: "completed", suspect_reasons: ["closed_by_giver"], hold_until: null });
    const [s2] = await sql(`select presence from public.drivers where id = $1`, [samir.id]);
    expect(s2.presence).toBe("offline");

    // Course propre de A : jamais
    const own = await createDriver(p.A, { firstName: "Ahmed", at: north(p.site, 300) });
    const mine = await rideOf(p);
    expect(await accept(own, (await pendingOffer(mine.id, own.id))!.id)).toMatchObject({ ok: true });
    for (const s of ["DRIVER_EN_ROUTE", "DRIVER_ARRIVED", "PASSENGER_ONBOARD"]) await stepAs(own, mine.id, s);
    expect((await expectPgError(close(p.A.ownerId, mine.id))).code).toBe("55000");
  });

  it("A suspendue : courses acceptées au bout, partenaires prévenus une fois", async () => {
    const p = await networkPair();
    const aName = await orgName(p.A);
    const { ride } = await scheduledPartnerAccepts(p, p.partner, 100);
    await sql(`update public.organizations set status = 'suspended', suspended_at = now() where id = $1`, [p.A.id]);
    await watch();
    await watch();
    const notes = await sql(
      `select ride_id, title, body, data, priority from public.notifications where driver_id = $1 and type = 'network_giver_suspended'`,
      [p.partner.id],
    );
    expect(notes).toEqual([{
      ride_id: ride.id,
      title: `ORGANISATION SUSPENDUE — ${aName}`,
      body: `${aName} est suspendue : vos courses déjà acceptées restent à faire, vos règlements avec elle restent dus ou attendus.`,
      data: { type: "network_giver_suspended", network: true, giver: aName, ride_id: ride.id },
      priority: "normal",
    }]);
    expect((await rideState(ride.id)).ride).toMatchObject({ driver_id: p.partner.id, status: "ACCEPTED" });
  });

  it("« Retirer » (A) : nouvelle recherche lancée tout de suite, ses chauffeurs d'abord ; partenaire prévenu, jamais resollicité", async () => {
    const p = await networkPair();
    const [aName, bName] = [await orgName(p.A), await orgName(p.B)];
    const samir = await readyPartner(p.B, { firstName: "Samir", at: north(p.site, 900) });
    const { ride, execution } = await partnerAccepts(p, p.partner);
    const [{ pickup_at: pickupAt }] = await sql(`select pickup_at from public.rides where id = $1`, [ride.id]);
    // Autre chauffeur affiché à l'écran : refus
    expect(await callAs(p.A.ownerId, "reassign_ride", [ride.id, null, samir.id])).toMatchObject({ ok: false, code: "DRIVER_CHANGED" });

    const res = await callAs(p.A.ownerId, "reassign_ride", [ride.id, "Client injoignable", p.partner.id]);
    expect(res).toMatchObject({
      ok: true, code: "RELAUNCHED", previous_driver_id: null, type: "instant", status: "SEARCHING_DRIVER", notified: 0, network: true,
    });
    let st = await rideState(ride.id);
    expect(st.ride).toMatchObject({ driver_id: null, network_at: null, dispatch_wave: 1, status: "SEARCHING_DRIVER" });
    expect((await executionsOf(ride.id))[0]).toMatchObject({ id: execution.id, end_reason: "removed_by_giver" });
    expect(await shareOf(ride.id)).toMatchObject({ status: "closed", closed_reason: "removed_by_giver" });
    expect(await notificationsOf(ride.id, p.partner.id)).toEqual([{
      type: "ride_unassigned",
      title: `COURSE RETIRÉE — ${aName}`,
      body: `${aName} a repris la course du ${when(pickupAt)} : elle ne figure plus dans votre planning.`,
      data: { type: "ride_unassigned", ride_id: ride.id, network: true, giver: aName, reason: "removed_by_giver" },
      status: "queued",
    }]);
    const ev = st.events.find((x) => x.type === "ride.network_unassigned");
    expect(ev).toMatchObject({
      actor_type: "user", actor_id: p.A.ownerId,
      message: `Course retirée au chauffeur partenaire Karim T. (${bName}) : Client injoignable — recherche relancée, vos chauffeurs d'abord`,
    });
    expect(ev.data).toMatchObject({ reason: "removed_by_giver", note: "Client injoignable", type: "instant", auto: true });
    expect(JSON.stringify(st.events.map((x) => [x.message, x.data, x.actor_id]))).not.toContain(p.partner.id);
    const [d] = await sql(`select presence, current_ride_id from public.drivers where id = $1`, [p.partner.id]);
    expect(d).toEqual({ presence: "available", current_ride_id: null });

    // Après les vagues propres : partage rouvert (cycle 2) avec Samir, jamais avec Karim
    await toNetworkStage(ride.id);
    st = await rideState(ride.id);
    expect(st.ride.network_at).not.toBeNull();
    expect(await shareOf(ride.id)).toMatchObject({ status: "open", cycle: 2 });
    expect(await pendingOffer(ride.id, samir.id)).toBeTruthy();
    expect(await pendingOffer(ride.id, p.partner.id)).toBeUndefined();
  });

  it("attribuée à un chauffeur de A : partenaire libéré « reassigned_own », partage clos, journal sans son identifiant", async () => {
    const p = await networkPair();
    const aName = await orgName(p.A);
    const { ride } = await partnerAccepts(p, p.partner);
    const [{ pickup_at: pickupAt }] = await sql(`select pickup_at from public.rides where id = $1`, [ride.id]);
    const own = await createDriver(p.A, { firstName: "Ahmed", at: north(p.site, 300) });
    expect(await callAs(p.A.ownerId, "assign_ride", [ride.id, own.id])).toMatchObject({ ok: true, code: "ASSIGNED" });
    const st = await rideState(ride.id);
    expect(st.ride).toMatchObject({ driver_id: own.id, driver_org_id: p.A.id, network_at: null, status: "ACCEPTED" });
    expect((await executionsOf(ride.id))[0].end_reason).toBe("reassigned_own");
    expect(await shareOf(ride.id)).toMatchObject({ status: "closed", closed_reason: "reassigned_own" });
    expect(await notificationsOf(ride.id, p.partner.id)).toEqual([{
      type: "ride_unassigned",
      title: `COURSE RETIRÉE — ${aName}`,
      body: `${aName} a confié la course du ${when(pickupAt)} à l'un de ses chauffeurs : elle ne figure plus dans votre planning.`,
      data: { type: "ride_unassigned", ride_id: ride.id, network: true, giver: aName, reason: "reassigned_own" },
      status: "queued",
    }]);
    const ev = st.events.find((x) => x.type === "ride.assigned_manually");
    expect(ev.data).toMatchObject({ driver_id: own.id, previous_driver_id: null, network: true, previous_status: "ACCEPTED" });
    expect(JSON.stringify(st.events.map((x) => [x.message, x.data, x.actor_id]))).not.toContain(p.partner.id);
    const [d] = await sql(`select presence, current_ride_id from public.drivers where id = $1`, [p.partner.id]);
    expect(d).toEqual({ presence: "available", current_ride_id: null });

    // Pendant la recherche réseau (offre partenaire en attente) : partage clos « reassigned_own », offres fermées
    const next = await rideOf(p);
    await toNetworkStage(next.id);
    const offer = await pendingOffer(next.id, p.partner.id);
    expect(offer).toBeTruthy();
    const other = await createDriver(p.A, { firstName: "Yanis", at: north(p.site, 400) });
    expect(await callAs(p.A.ownerId, "assign_ride", [next.id, other.id])).toMatchObject({ ok: true, code: "ASSIGNED" });
    expect((await rideState(next.id)).ride.network_at).toBeNull();
    expect(await shareOf(next.id)).toMatchObject({ status: "closed", closed_reason: "reassigned_own" });
    const [o] = await sql(`select status, closed_reason from public.ride_offers where id = $1`, [offer!.id]);
    expect(o).toEqual({ status: "closed", closed_reason: "manual_assignment" });
    expect(await sql(`select 1 from public.notifications where offer_id = $1`, [offer!.id])).toHaveLength(0);
  });

  it("annulée par A : exécution close « cancelled_by_giver », partenaire prévenu et libéré", async () => {
    const p = await networkPair();
    const { ride, execution } = await partnerAccepts(p, p.partner);
    expect(await callAs(p.A.ownerId, "cancel_ride", [ride.id, "Client absent"])).toMatchObject({ ok: true, code: "CANCELLED" });
    expect((await executionsOf(ride.id))[0]).toMatchObject({ id: execution.id, end_reason: "cancelled_by_giver" });
    expect(await shareOf(ride.id)).toMatchObject({ status: "closed", closed_reason: "cancelled" });
    // Lot 5b (§11.5) : message du partenaire au nom de A, sans n° ni adresse ; ses notifications précédentes de la course
    // (offre acceptée) retirées de son historique
    const [{ name: aName }] = await sql(`select name from public.organizations where id = $1`, [p.A.id]);
    const notes = await notificationsOf(ride.id, p.partner.id);
    expect(notes.map((n) => n.type)).toEqual(["ride_cancelled"]);
    expect(notes[0]).toMatchObject({ type: "ride_cancelled", title: `COURSE ANNULÉE — ${aName}`, data: { network: true, giver: aName } });
    expect(notes[0].body).not.toMatch(/Champs|Élysées|#\d/);
    const [d] = await sql(`select presence, current_ride_id from public.drivers where id = $1`, [p.partner.id]);
    expect(d).toEqual({ presence: "available", current_ride_id: null });
  });

  it("suppression du compte du partenaire : refusée tant qu'il tient une course de A (même B suspendue), message adapté", async () => {
    const p = await networkPair();
    const { ride } = await scheduledPartnerAccepts(p, p.partner, 100);
    const remove = () =>
      as({ role: "service_role" }, async (q) => (await q("select public.svc_delete_driver_account($1) as r", [p.partner.userId]))[0].r);
    expect(await remove()).toMatchObject({
      ok: false, code: "RIDES_ASSIGNED",
      message: "Vous avez une course confiée par une autre organisation : terminez-la ou demandez à l'organisation qui vous a confié la course de la retirer, puis supprimez votre compte.",
    });
    // B suspendue : jamais libérée par ce chemin (« organisation inactive ») — elle l'est par A ou le chien de garde
    await sql(`update public.organizations set status = 'suspended', suspended_at = now() where id = $1`, [p.B.id]);
    expect(await remove()).toMatchObject({ ok: false, code: "RIDES_ASSIGNED" });
    expect((await rideState(ride.id)).ride).toMatchObject({ driver_id: p.partner.id, status: "ACCEPTED", network_at: expect.anything() });
    await watch();
    expect((await rideState(ride.id)).ride).toMatchObject({ driver_id: null, status: "SEARCHING_DRIVER" });
    expect(await remove()).toMatchObject({ ok: true, code: "DELETED" });
  });

  it("« Relancer » pendant le partage : partage clos « redispatch », offres partenaires fermées, ses chauffeurs d'abord", async () => {
    const p = await networkPair();
    const ride = await rideOf(p);
    await toNetworkStage(ride.id);
    const offer = await pendingOffer(ride.id, p.partner.id);
    expect(offer).toBeTruthy();
    // La recherche continue en phase réseau : une relance est possible (statut OFFERED, sans chauffeur)
    expect(await callAs(p.A.ownerId, "redispatch_ride", [ride.id])).toMatchObject({ ok: true, code: "RELAUNCHED" });
    const st = await rideState(ride.id);
    expect(st.ride).toMatchObject({ network_at: null, dispatch_wave: 1 });
    expect(await shareOf(ride.id)).toMatchObject({ status: "closed", closed_reason: "redispatch" });
    const [o] = await sql(`select status, closed_reason from public.ride_offers where id = $1`, [offer!.id]);
    expect(o).toEqual({ status: "expired", closed_reason: "redispatch" });
    expect(await sql(`select 1 from public.notifications where offer_id = $1`, [offer!.id])).toHaveLength(0);
  });

  it("client à bord d'un chauffeur partenaire : annulation refusée à tous (à bord comme prépayée) ; avant, permise", async () => {
    const p = await networkPair();
    const dispatcher = await createMember(p.A, "dispatcher");
    const samir = await readyPartner(p.B, { firstName: "Samir", at: north(p.site, 900) });
    const card = await partnerAccepts(p, p.partner);
    const online = await partnerAccepts(p, samir, { payment_method: "online" });
    const refused = { ok: false, code: "NETWORK_RIDE_IN_PROGRESS", message: ERROR_MESSAGES.NETWORK_RIDE_IN_PROGRESS };
    for (const [driver, rideId] of [[p.partner, card.ride.id], [samir, online.ride.id]] as const) {
      for (const s of ["DRIVER_EN_ROUTE", "DRIVER_ARRIVED", "PASSENGER_ONBOARD"]) {
        await moveTo(driver.id, p.site);
        expect(await stepAs(driver, rideId, s), s).toMatchObject({ ok: true });
      }
      expect(await callAs(dispatcher, "cancel_ride", [rideId, "Client absent"])).toEqual(refused);
      expect(await callAs(p.A.ownerId, "cancel_ride", [rideId, "Client absent"])).toEqual(refused);
      expect(await stepAs(driver, rideId, "IN_PROGRESS")).toMatchObject({ ok: true });
      expect(await callAs(p.A.ownerId, "cancel_ride", [rideId, null])).toEqual(refused);
      expect((await rideState(rideId)).ride).toMatchObject({ status: "IN_PROGRESS", driver_id: driver.id });
      expect((await executionsOf(rideId))[0]).toMatchObject({ ended_at: null, end_reason: null });
    }
    // Le partenaire termine normalement (exécution « completed »)
    await moveTo(p.partner.id, north(CDG, 300));
    expect(await stepAs(p.partner, card.ride.id, "COMPLETED")).toMatchObject({ ok: true, status: "COMPLETED" });
    expect((await executionsOf(card.ride.id))[0].end_reason).toBe("completed");

    // Arrivé, client pas à bord (absent) : l'annulation reste permise, dispatcher compris
    await moveTo(p.partner.id, north(p.site, 800));
    const absent = await partnerAccepts(p, p.partner);
    for (const s of ["DRIVER_EN_ROUTE", "DRIVER_ARRIVED"]) {
      await moveTo(p.partner.id, p.site);
      expect(await stepAs(p.partner, absent.ride.id, s), s).toMatchObject({ ok: true });
    }
    expect(await callAs(dispatcher, "cancel_ride", [absent.ride.id, "Client absent"])).toMatchObject({ ok: true, code: "CANCELLED" });
    expect((await executionsOf(absent.ride.id))[0]).toMatchObject({ id: absent.execution.id, end_reason: "cancelled_by_giver" });
  });

  it("close_network_ride : jamais avant la prise en charge (arrivé, client pas à bord) — à retirer, ou annuler si le client est absent", async () => {
    const p = await networkPair();
    const { ride, execution } = await partnerAccepts(p, p.partner);
    for (const s of ["DRIVER_EN_ROUTE", "DRIVER_ARRIVED"]) {
      await moveTo(p.partner.id, p.site);
      expect(await stepAs(p.partner, ride.id, s), s).toMatchObject({ ok: true });
    }
    // Plus de position depuis 35 min (coupure GPS) : clôture refusée, rien n'est dû
    await moveTo(p.partner.id, p.site, 35 * 60);
    const err = await expectPgError(callAs(p.A.ownerId, "close_network_ride", [ride.id]));
    expect([err.code, err.message]).toEqual(["55000", expect.stringContaining("NETWORK_CLOSE_NOT_ALLOWED")]);
    expect(err.message).toContain("retirez-la");
    expect((await rideState(ride.id)).ride).toMatchObject({ status: "DRIVER_ARRIVED", driver_id: p.partner.id, completed_at: null });
    expect((await executionsOf(ride.id))[0]).toMatchObject({ id: execution.id, ended_at: null, suspect_reasons: [], hold_until: null });
    // « Retirer » : course rendue à A sans argent
    expect(await callAs(p.A.ownerId, "reassign_ride", [ride.id, "Injoignable", p.partner.id])).toMatchObject({ ok: true, network: true });
    expect((await executionsOf(ride.id))[0].end_reason).toBe("removed_by_giver");
  });

  it("fiche suspendue côté serveur, client à bord d'une course de A et une autre acceptée : seule la seconde est rendue (Q5)", async () => {
    const p = await networkPair();
    const later = await scheduledPartnerAccepts(p, p.partner, 100);
    const current = await partnerAccepts(p, p.partner);
    for (const s of ["DRIVER_EN_ROUTE", "DRIVER_ARRIVED", "PASSENGER_ONBOARD"]) {
      await moveTo(p.partner.id, p.site);
      expect(await stepAs(p.partner, current.ride.id, s), s).toMatchObject({ ok: true });
    }
    // Pendant la course partenaire, B ne voit pas la position de son chauffeur (Q5)
    const seenByB = () => as({ sub: p.B.ownerId }, (q) => q(`select driver_id from public.driver_locations where driver_id = $1`, [p.partner.id]));
    expect(await seenByB()).toHaveLength(0);

    // Suspension par un chemin serveur (bannissement plateforme, identité bannie : hors du garde G7)
    await sql(`update public.drivers set status = 'suspended' where id = $1`, [p.partner.id]);
    const w = await watch();
    expect(w.network).toMatchObject({ released: 1, alerts: 1 });
    expect((await rideState(later.ride.id)).ride).toMatchObject({ driver_id: null, status: "SEARCHING_DRIVER" });
    // La course en cours reste la sienne : présence et course en cours inchangées, position toujours masquée à B
    const [d] = await sql(`select presence, current_ride_id from public.drivers where id = $1`, [p.partner.id]);
    expect(d).toEqual({ presence: "on_trip", current_ride_id: current.ride.id });
    expect(await seenByB()).toHaveLength(0);

    // Il termine (C3), puis passe hors ligne
    expect(await stepAs(p.partner, current.ride.id, "IN_PROGRESS")).toMatchObject({ ok: true });
    expect(await stepAs(p.partner, current.ride.id, "COMPLETED")).toMatchObject({ ok: true });
    const [after] = await sql(`select presence, current_ride_id from public.drivers where id = $1`, [p.partner.id]);
    expect(after).toEqual({ presence: "offline", current_ride_id: null });
  });

  it("chauffeur de A qui accepte pendant les vagues réseau : network_at remis à NULL ; « Retirer » puis réouverture normale (cycle 2)", async () => {
    const p = await networkPair();
    const ride = await rideOf(p);
    await toNetworkStage(ride.id);
    expect(await pendingOffer(ride.id, p.partner.id)).toBeTruthy();
    const own = await createDriver(p.A, { firstName: "Ahmed", at: north(p.site, 300) });
    await nextWave(ride.id);
    const ownOffer = await pendingOffer(ride.id, own.id);
    expect(await accept(own, ownOffer!.id)).toMatchObject({ ok: true });
    let st = await rideState(ride.id);
    expect(st.ride).toMatchObject({ driver_id: own.id, driver_org_id: p.A.id, network_at: null });
    expect(await shareOf(ride.id)).toEqual({ status: "closed", closed_reason: "reassigned_own", cycle: 1 });

    // « Retirer » au chauffeur de A : la recherche repart, ses chauffeurs d'abord (aucune vague réseau)
    expect(await callAs(p.A.ownerId, "reassign_ride", [ride.id, null, own.id])).toMatchObject({ ok: true, code: "RELAUNCHED" });
    for (let wave = 2; wave <= 6; wave++) {
      await nextWave(ride.id);
      st = await rideState(ride.id);
      expect(st.ride).toMatchObject({ dispatch_wave: wave, network_at: null });
      expect(st.offers.filter((o) => o.is_network && o.status === "pending")).toHaveLength(0);
    }
    // Après elles : partage rouvert (dispatch.network, cycle 2), le partenaire accepte, partage « accepted »
    await nextWave(ride.id);
    st = await rideState(ride.id);
    expect(st.ride.network_at).not.toBeNull();
    expect(st.events.filter((e) => e.type === "dispatch.network").map((e) => e.data.cycle)).toEqual([1, 2]);
    expect(await shareOf(ride.id)).toEqual({ status: "open", closed_reason: null, cycle: 2 });
    const again = await pendingOffer(ride.id, p.partner.id);
    expect(await accept(p.partner, again!.id)).toMatchObject({ ok: true });
    expect(await shareOf(ride.id)).toEqual({ status: "accepted", closed_reason: null, cycle: 2 });
  });

  it("planifiée prise par un chauffeur de A pendant la fenêtre, repoussée puis retirée : aucune offre partenaire avant la nouvelle fenêtre", async () => {
    const p = await networkPair();
    const own = await createDriver(p.A, { firstName: "Ahmed", at: north(p.site, 300) });
    const ride = await rideOf(p, { pickup_at: inMinutes(100) });
    await sql(`update public.rides set dispatch_started_at = now() - interval '20 minutes' where id = $1`, [ride.id]);
    await nextWave(ride.id);
    expect(await pendingOffer(ride.id, p.partner.id)).toBeTruthy();
    expect(await accept(own, (await pendingOffer(ride.id, own.id))!.id)).toMatchObject({ ok: true });
    expect((await rideState(ride.id)).ride.network_at).toBeNull();
    // Prise en charge repoussée (nouvelle fenêtre réseau dans 80 min), puis course retirée au chauffeur de A
    await sql(`update public.rides set pickup_at = now() + interval '200 minutes' where id = $1`, [ride.id]);
    expect(await callAs(p.A.ownerId, "reassign_ride", [ride.id, null, own.id])).toMatchObject({ ok: true });
    await nextWave(ride.id);
    const st = await rideState(ride.id);
    expect(st.ride).toMatchObject({ dispatch_mode: "fleet", network_at: null });
    expect(st.offers.filter((o) => o.is_network && o.status === "pending")).toHaveLength(0);
  });

  it("défenses : network_at resté posé d'avant la correction (partage clos) — remis à NULL par « Retirer » et par la fenêtre flotte", async () => {
    /** État d'avant la correction d'accept_ride_offer : network_at posé, partage clos (déclencheurs coupés). */
    const staleNetworkAt = async (rideId: string) => {
      const client = await pool.connect();
      try {
        await client.query("set session_replication_role = replica");
        await client.query(`update public.rides set network_at = now() - interval '1 minute' where id = $1`, [rideId]);
      } finally {
        await client.query("reset session_replication_role");
        client.release();
      }
    };
    const p = await networkPair();
    const own = await createDriver(p.A, { firstName: "Ahmed", at: north(p.site, 300) });

    // Immédiate : « Retirer » au chauffeur de A remet network_at à NULL (vagues propres d'abord, partage rouvert après)
    const ride = await rideOf(p);
    await toNetworkStage(ride.id);
    await nextWave(ride.id);
    expect(await accept(own, (await pendingOffer(ride.id, own.id))!.id)).toMatchObject({ ok: true });
    await staleNetworkAt(ride.id);
    expect(await callAs(p.A.ownerId, "reassign_ride", [ride.id, null, own.id])).toMatchObject({ ok: true, code: "RELAUNCHED" });
    expect((await rideState(ride.id)).ride).toMatchObject({ network_at: null, dispatch_wave: 1 });
    expect(await shareOf(ride.id)).toEqual({ status: "closed", closed_reason: "reassigned_own", cycle: 1 });

    // Planifiée retirée (nouvelle fenêtre réseau 15 min après la relance) : aucune offre partenaire avant elle,
    // network_at remis à NULL au passage suivant ; rouvert (cycle 2) à la fenêtre
    const sched = await rideOf(p, { pickup_at: inMinutes(100) });
    await sql(`update public.rides set dispatch_started_at = now() - interval '20 minutes' where id = $1`, [sched.id]);
    await nextWave(sched.id);
    expect(await pendingOffer(sched.id, p.partner.id)).toBeTruthy();
    const fleetOffer = await pendingOffer(sched.id, own.id);
    expect(await accept(own, fleetOffer!.id)).toMatchObject({ ok: true });
    expect(await callAs(p.A.ownerId, "reassign_ride", [sched.id, null, own.id])).toMatchObject({ ok: true });
    await staleNetworkAt(sched.id);
    await nextWave(sched.id);
    let st = await rideState(sched.id);
    expect(st.ride).toMatchObject({ dispatch_mode: "fleet", network_at: null });
    expect(st.offers.filter((o) => o.is_network && o.status === "pending")).toHaveLength(0);
    await sql(`update public.rides set dispatch_started_at = now() - interval '20 minutes' where id = $1`, [sched.id]);
    await nextWave(sched.id);
    st = await rideState(sched.id);
    expect(st.ride.network_at).not.toBeNull();
    expect(await shareOf(sched.id)).toEqual({ status: "open", closed_reason: null, cycle: 2 });
    expect(await pendingOffer(sched.id, p.partner.id)).toMatchObject({ mode: "fleet" });
  });

  it("prise en charge repoussée par A pendant la fenêtre réseau : partage clos jusqu'à la nouvelle fenêtre, puis rouvert", async () => {
    const p = await networkPair();
    const ride = await rideOf(p, { pickup_at: inMinutes(100) });
    await sql(`update public.rides set dispatch_started_at = now() - interval '20 minutes' where id = $1`, [ride.id]);
    await nextWave(ride.id);
    const offer = await pendingOffer(ride.id, p.partner.id);
    expect(offer).toBeTruthy();
    // Nouvelle heure : fenêtre réseau dans 3 h (G9 ferme l'offre « terms_changed »)
    await sql(`update public.rides set pickup_at = now() + interval '300 minutes' where id = $1`, [ride.id]);
    await nextWave(ride.id);
    let st = await rideState(ride.id);
    expect(st.ride).toMatchObject({ dispatch_mode: "fleet", network_at: null });
    expect(st.offers.filter((o) => o.is_network && o.status === "pending")).toHaveLength(0);
    expect(await shareOf(ride.id)).toEqual({ status: "closed", closed_reason: "window_elapsed", cycle: 1 });
    // Nouvelle fenêtre atteinte : partage rouvert (cycle 2), le partenaire de nouveau sollicité
    await sql(`update public.rides set pickup_at = now() + interval '110 minutes' where id = $1`, [ride.id]);
    await nextWave(ride.id);
    st = await rideState(ride.id);
    expect(st.ride.network_at).not.toBeNull();
    expect(await shareOf(ride.id)).toEqual({ status: "open", closed_reason: null, cycle: 2 });
    expect(await pendingOffer(ride.id, p.partner.id)).toMatchObject({ mode: "fleet" });
  });
});

// =============================================================================
// n° 15 — Contrôles de fin : course « à vérifier », jamais de refus
// =============================================================================
describe("Contrôles de fin de course (§14.1 n° 15)", () => {
  it("arrivé loin du départ, sans GPS à la fin, durée trop courte → à vérifier ; prépayée : versement retenu 72 h", async () => {
    const p = await networkPair();
    const { ride } = await partnerAccepts(p, p.partner, { payment_method: "online", estimated_duration_s: 3600 });
    expect(await stepAs(p.partner, ride.id, "DRIVER_EN_ROUTE")).toMatchObject({ ok: true });
    await moveTo(p.partner.id, north(p.site, 2000));
    expect(await stepAs(p.partner, ride.id, "DRIVER_ARRIVED")).toMatchObject({ ok: true, status: "DRIVER_ARRIVED" });
    expect((await executionsOf(ride.id))[0].suspect_reasons).toEqual(["far_from_pickup"]);
    expect(await stepAs(p.partner, ride.id, "PASSENGER_ONBOARD")).toMatchObject({ ok: true });
    expect(await stepAs(p.partner, ride.id, "IN_PROGRESS")).toMatchObject({ ok: true });
    // Dernière position il y a 10 min, fin 1 s après le départ (durée estimée 1 h)
    await moveTo(p.partner.id, p.site, 600);
    expect(await stepAs(p.partner, ride.id, "COMPLETED")).toMatchObject({ ok: true, status: "COMPLETED" });
    const [e] = await executionsOf(ride.id);
    expect(e).toMatchObject({ end_reason: "completed", suspect_reasons: ["far_from_pickup", "no_gps", "too_fast"] });
    const [hold] = await sql(
      `select e.hold_until between r.completed_at + interval '71 hours' and r.completed_at + interval '73 hours' as ok
         from public.ride_network_executions e join public.rides r on r.id = e.ride_id where e.id = $1`,
      [e.id],
    );
    expect(hold.ok).toBe(true);
    // Journal de A : étapes du partenaire sans son identifiant
    const steps = (await rideState(ride.id)).events.filter((x) => x.type.startsWith("ride.") && x.actor_type === "driver");
    expect(steps.map((x) => x.type)).toEqual(["ride.driver_en_route", "ride.driver_arrived", "ride.passenger_onboard", "ride.in_progress", "ride.completed"]);
    expect(steps.every((x) => x.actor_id === null)).toBe(true);
  });

  it("course propre : rien à vérifier ; terminée loin de l'arrivée : far_from_dropoff ; payée à bord : jamais de retenue", async () => {
    const p = await networkPair();
    const clean = await partnerAccepts(p, p.partner);
    for (const s of ["DRIVER_EN_ROUTE", "DRIVER_ARRIVED", "PASSENGER_ONBOARD", "IN_PROGRESS"]) {
      await moveTo(p.partner.id, north(p.site, 100));
      expect(await stepAs(p.partner, clean.ride.id, s)).toMatchObject({ ok: true });
    }
    await moveTo(p.partner.id, north(CDG, 300));
    expect(await stepAs(p.partner, clean.ride.id, "COMPLETED")).toMatchObject({ ok: true });
    expect((await executionsOf(clean.ride.id))[0]).toMatchObject({ end_reason: "completed", suspect_reasons: [], hold_until: null });

    await moveTo(p.partner.id, north(p.site, 800));
    const far = await partnerAccepts(p, p.partner);
    for (const s of ["DRIVER_EN_ROUTE", "DRIVER_ARRIVED", "PASSENGER_ONBOARD", "IN_PROGRESS"]) {
      await moveTo(p.partner.id, north(p.site, 100));
      await stepAs(p.partner, far.ride.id, s);
    }
    expect(await stepAs(p.partner, far.ride.id, "COMPLETED")).toMatchObject({ ok: true });
    expect((await executionsOf(far.ride.id))[0]).toMatchObject({ suspect_reasons: ["far_from_dropoff"], hold_until: null });
  });

  it("contrôles en erreur : l'étape passe quand même", async () => {
    const p = await networkPair();
    const { ride } = await partnerAccepts(p, p.partner);
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(`create or replace function private.network_completion_checks(r public.rides, p_status public.ride_status)
          returns text[] language plpgsql set search_path = '' as $$ begin raise exception 'panne simulée'; end; $$`);
      await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: p.partner.userId, role: "authenticated" })]);
      await client.query("set local role authenticated");
      for (const s of ["DRIVER_EN_ROUTE", "DRIVER_ARRIVED"]) {
        const { rows: [r] } = await client.query("select public.driver_update_ride_status($1, $2) as r", [ride.id, s]);
        expect(r.r, s).toMatchObject({ ok: true, status: s });
      }
    } finally {
      await client.query("rollback").catch(() => undefined);
      client.release();
    }
  });
});
