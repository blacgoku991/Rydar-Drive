// Réseau partagé, lot 3 — dispatch (20260924006800_shared_network_dispatch) : scénarios §14.1 n° 6 à 12 de la
// spécification (étape réseau des immédiates et des planifiées, éligibilité, acceptation), plus les montants
// (private.network_terms = networkTerms() de @rydar/shared au centime) et l'isolement des erreurs (C8).
// Réglages du réseau écrits directement (helpers de tests/db/helpers.ts) : les RPC d'administration arrivent au lot
// 20260924007100. L'interrupteur est rouvert avant chaque test et recoupé à la fin du fichier.
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { networkTerms, type NetworkTermsGiverInput } from "../../packages/shared/src/network";
import {
  acceptDriverTerms, approveNetwork, as, CHAMPS_ELYSEES, createDriver, createMember, createOrg, createRideAsOwner,
  enableNetwork, inMinutes, insertRideBypass, networkTermsJson, nextWave, north, pingApp, pool, rideState,
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

  it("fenêtre après T-lead (course créée 70 min avant) : réseau seulement après les vagues GPS propres", async () => {
    const p = await networkPair();
    const ride = await rideOf(p, { pickup_at: inMinutes(70) });
    expect((await rideState(ride.id)).ride.type).toBe("scheduled");
    await sql(`update public.rides set next_dispatch_at = now() - interval '1 second' where id = $1`, [ride.id]);
    await sql("select private.dispatch_tick()");
    const st = await rideState(ride.id);
    expect(st.ride.network_at).toBeNull();
    expect(st.offers.filter((o) => o.is_network)).toHaveLength(0);
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
});
