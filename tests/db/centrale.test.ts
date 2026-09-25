import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import {
  as, CHAMPS_ELYSEES, createAuthUser, createMember, createOrg, createRideAsOwner, expectPgError, north, pool, sql,
  type Org,
} from "./helpers";

afterAll(async () => {
  await pool.end();
});

// -----------------------------------------------------------------------------
// Outils
// -----------------------------------------------------------------------------
type CDriver = { id: string; userId: string; vehicleId: string; number: number; phone: string; email: string; plate: string };

/** Numéro unique : les bannissements portent sur l'identité, jamais de valeur partagée entre tests. */
const uniquePhone = () => `06${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
const uniquePlate = () => `${randomUUID().slice(0, 2)}-${randomUUID().slice(0, 3)}-${randomUUID().slice(0, 2)}`.toUpperCase();
const NEAR = north(CHAMPS_ELYSEES, 500);

/** Centrale (mode commission) : réglages de répartition / encaissement + options organisation. */
async function centrale(name: string, settings: Record<string, unknown> = {}, orgFields: Record<string, unknown> = {}) {
  const org = await createOrg(name, {
    settings: {
      settlement_link: "https://revolut.me/centrale/{montant}?ref={reference}",
      settlement_methods: "{link,cash,transfer}",
      ...settings,
    },
  });
  const fields = { dispatch_model: "centrale", platform_fee_fixed_cents: 500, ...orgFields };
  const keys = Object.keys(fields);
  await sql(`update public.organizations set ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")} where id = $1`, [
    org.id, ...Object.values(fields),
  ]);
  return org;
}

async function setLocation(org: Org, driverId: string, point: [number, number]) {
  await sql(
    `insert into public.driver_locations (driver_id, organization_id, lat, lng, recorded_at, updated_at)
     values ($1, $2, $3, $4, now(), now())
     on conflict (driver_id) do update set lat = excluded.lat, lng = excluded.lng, recorded_at = now(), updated_at = now()`,
    [driverId, org.id, point[0], point[1]],
  );
}

async function driverIn(
  org: Org,
  opts: { phone?: string; email?: string; plate?: string; vtc?: string; at?: [number, number]; trust?: "new" | "trusted"; status?: string } = {},
): Promise<CDriver> {
  const phone = opts.phone ?? uniquePhone();
  const email = opts.email ?? `chauffeur-${randomUUID().slice(0, 8)}@test.dev`;
  const plate = opts.plate ?? uniquePlate();
  const userId = await createAuthUser(email, "Chauffeur Centrale");
  const [v] = await sql(
    `insert into public.vehicles (organization_id, model, plate, category, seats) values ($1, 'Classe E', $2, 'business', 4) returning id`,
    [org.id, plate],
  );
  const [d] = await sql(
    `insert into public.drivers (organization_id, user_id, first_name, last_name, phone, email, vtc_card_number, status, presence, vehicle_id, trust_level)
     values ($1, $2, 'Karim', 'Test', $3, $4, $5, $6, 'available', $7, $8) returning id, number`,
    [org.id, userId, phone, email, opts.vtc ?? null, opts.status ?? "active", v.id, opts.trust ?? "trusted"],
  );
  if (opts.at) await setLocation(org, d.id, opts.at);
  return { id: d.id, userId, vehicleId: v.id, number: d.number, phone, email, plate };
}

const rpc = async (sub: string, fn: string, args: unknown[] = []) => {
  const params = args.map((_, i) => `$${i + 1}`).join(", ");
  const [row] = await as({ sub }, (q) => q(`select public.${fn}(${params}) as r`, args));
  return row.r as Record<string, any>;
};
const svc = async (fn: string, args: unknown[] = []) => {
  const params = args.map((_, i) => `$${i + 1}`).join(", ");
  const [row] = await as({ role: "service_role" }, (q) => q(`select public.${fn}(${params}) as r`, args));
  return row.r as Record<string, any>;
};

const pendingOffer = async (rideId: string, driverId: string) =>
  (await sql(`select id from public.ride_offers where ride_id = $1 and driver_id = $2 and status = 'pending'`, [rideId, driverId]))[0]?.id as
    | string
    | undefined;

async function acceptAndComplete(d: CDriver, rideId: string) {
  const offer = await pendingOffer(rideId, d.id);
  expect(offer, "offre en attente").toBeTruthy();
  const acc = await rpc(d.userId, "accept_ride_offer", [offer]);
  expect(acc.code).toBe("ACCEPTED");
  for (const s of ["DRIVER_EN_ROUTE", "DRIVER_ARRIVED", "PASSENGER_ONBOARD", "IN_PROGRESS", "COMPLETED"]) {
    const r = await rpc(d.userId, "driver_update_ride_status", [rideId, s]);
    expect(r.ok, `${s} : ${JSON.stringify(r)}`).toBe(true);
  }
}

const settlementOf = async (rideId: string) => (await sql(`select * from public.ride_settlements where ride_id = $1`, [rideId]))[0];

/** Course « 59 € » de l'exemple : 14 € de commission saisie, 5 € de frais plateforme → 40 € chauffeur. */
const ride59 = (org: Org, extra: Record<string, unknown> = {}) =>
  createRideAsOwner(org, { price_cents: 5900, commission_cents: 1400, payment_method: "cash", ...extra });

// -----------------------------------------------------------------------------
describe("Répartition du prix (mode centrale)", () => {
  it("59 € = 40 € chauffeur + 14 € commission + 5 € plateforme ; commission automatique % + fixe", async () => {
    const org = await centrale("Centrale Split", { driver_commission_percent: 20, driver_commission_fixed_cents: 100 });
    const manual = await ride59(org);
    const [m] = await sql(`select commission_cents, platform_fee_cents, driver_payout_cents, commission_manual from public.rides where id = $1`, [manual.id]);
    expect(m).toEqual({ commission_cents: 1400, platform_fee_cents: 500, driver_payout_cents: 4000, commission_manual: true });

    const auto = await createRideAsOwner(org, { price_cents: 5900 });
    const [a] = await sql(`select commission_cents, platform_fee_cents, driver_payout_cents, commission_manual from public.rides where id = $1`, [auto.id]);
    // 20 % de 59 € = 11,80 € + 1 € fixe
    expect(a).toEqual({ commission_cents: 1280, platform_fee_cents: 500, driver_payout_cents: 4120, commission_manual: false });

    // Prix modifié : automatique recalculé, saisie conservée
    await as({ sub: org.ownerId }, (q) => q(`update public.rides set price_cents = 6900 where id = any ($1::uuid[])`, [[auto.id, manual.id]]));
    const rows = await sql(`select id, commission_cents, driver_payout_cents from public.rides where id = any ($1::uuid[])`, [[auto.id, manual.id]]);
    expect(rows.find((r) => r.id === auto.id)).toMatchObject({ commission_cents: 1480, driver_payout_cents: 4920 });
    expect(rows.find((r) => r.id === manual.id)).toMatchObject({ commission_cents: 1400, driver_payout_cents: 5000 });

    // Retour au calcul automatique : commission remise à null
    await as({ sub: org.ownerId }, (q) => q(`update public.rides set commission_cents = null where id = $1`, [manual.id]));
    const [back] = await sql(`select commission_cents, commission_manual from public.rides where id = $1`, [manual.id]);
    expect(back).toEqual({ commission_cents: 1480, commission_manual: false });

    const preview = await rpc(org.ownerId, "preview_ride_split", [org.id, 5900, 1400]);
    expect(preview).toMatchObject({ model: "centrale", commission_cents: 1400, platform_fee_cents: 500, driver_payout_cents: 4000, error: null });
    const tooHigh = await rpc(org.ownerId, "preview_ride_split", [org.id, 5900, 5500]);
    expect(tooHigh.error).toBe("COMMISSION_TOO_HIGH");
  });

  it("refuse une commission qui dépasse le prix, et une course sans prix saisie au tableau de bord", async () => {
    const org = await centrale("Centrale Garde");
    const high = await expectPgError(ride59(org, { commission_cents: 5500 }));
    expect(high.message).toMatch(/COMMISSION_TOO_HIGH/);
    const noPrice = await expectPgError(createRideAsOwner(org, { price_cents: null }));
    expect(noPrice.message).toMatch(/PRICE_REQUIRED/);

    // API / mini-site : toléré, répartition calculée quand la centrale fixe le prix
    const [api] = await as({ role: "service_role" }, (q) =>
      q(
        `insert into public.rides (organization_id, source, pickup_address, pickup_lat, pickup_lng, dropoff_address, customer_name, customer_phone, vehicle_category)
         values ($1, 'api', '1 Rue de Rivoli, 75001 Paris', 48.8606, 2.3376, 'Gare du Nord, 75010 Paris', 'Client API', '+33600000009', 'business')
         returning id, driver_payout_cents`,
        [org.id],
      ),
    );
    expect(api.driver_payout_cents).toBeNull();
    await as({ sub: org.ownerId }, (q) => q(`update public.rides set price_cents = 3000 where id = $1`, [api.id]));
    const [priced] = await sql(`select driver_payout_cents from public.rides where id = $1`, [api.id]);
    expect(priced.driver_payout_cents).toBe(2500);
  });

  it("mode flotte : aucune répartition, même avec une commission saisie", async () => {
    const org = await createOrg("Flotte Classique");
    const ride = await createRideAsOwner(org, { commission_cents: 1400 });
    const [r] = await sql(`select commission_cents, platform_fee_cents, driver_payout_cents from public.rides where id = $1`, [ride.id]);
    expect(r).toEqual({ commission_cents: null, platform_fee_cents: null, driver_payout_cents: null });
    expect(await rpc(org.ownerId, "preview_ride_split", [org.id, 5900, null])).toEqual({ model: "fleet" });
  });
});

// -----------------------------------------------------------------------------
describe("Offre et règlement de fin de course", () => {
  it("l'offre affiche la part chauffeur ; la course terminée crée la commission à régler", async () => {
    const org = await centrale("Centrale Offre", { settlement_grace_hours: 24 });
    const d = await driverIn(org, { at: NEAR });
    const ride = await ride59(org);

    const [notif] = await sql(`select body, data from public.notifications where ride_id = $1 and type = 'ride_offer'`, [ride.id]);
    expect(notif.body).toContain("Vous gagnez 40 € (course 59 €)");
    expect(notif.data.driver_payout_cents).toBe(4000);

    const [{ r: offers }] = await as({ sub: d.userId }, (q) => q(`select public.driver_offers() as r`));
    expect(offers[0]).toMatchObject({
      dispatch_model: "centrale", price_cents: 5900, commission_cents: 1400, platform_fee_cents: 500,
      driver_payout_cents: 4000, driver_collects: true, blocked: null,
    });

    await acceptAndComplete(d, ride.id);
    const s = await settlementOf(ride.id);
    expect(s).toMatchObject({
      direction: "driver_owes", amount_cents: 1900, price_cents: 5900, commission_cents: 1400, platform_fee_cents: 500,
      driver_payout_cents: 4000, status: "due", reference: `C${ride.number}`, driver_id: d.id,
    });
    const hours = (new Date(s.due_at).getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(23.5);
    expect(hours).toBeLessThan(24.5);

    const [push] = await sql(`select title, body from public.notifications where driver_id = $1 and type = 'settlement_due'`, [d.id]);
    expect(push.title).toBe("COMMISSION À RÉGLER");
    expect(push.body).toContain("19 € à régler");
    const [event] = await sql(`select message from public.ride_events where ride_id = $1 and type = 'settlement.due'`, [ride.id]);
    expect(event.message).toContain("Commission de 19 € due par Karim Test");
    const topics = (await sql(`select topic from public.ride_settlements x, realtime.messages m
      where x.ride_id = $1 and m.event = 'settlement.updated' and m.payload->'settlement'->>'id' = x.id::text`, [ride.id])).map((m) => m.topic);
    expect(topics).toEqual(expect.arrayContaining([`org:${org.id}`, `driver:${d.id}`]));

    // Chauffeur : lien prérempli, gains nets du jour
    const mine = await rpc(d.userId, "driver_settlements");
    expect(mine.pay).toMatchObject({ amount_cents: 1900, count: 1, reference: `C${ride.number}` });
    expect(mine.pay.link).toBe(`https://revolut.me/centrale/19.00?ref=C${ride.number}`);
    expect(mine.pay.methods).toEqual(["link", "cash", "transfer"]);
    const home = await rpc(d.userId, "driver_home");
    expect(home.model).toBe("centrale");
    expect(home.today.net_cents).toBe(4000);
    expect(home.settlement).toMatchObject({ owed_cents: 1900, overdue_cents: 0, blocked: null });
    const earnings = await rpc(d.userId, "driver_earnings", [7]);
    expect(earnings.today).toMatchObject({ revenue_cents: 5900, net_cents: 4000, commission_cents: 1900 });
    expect(earnings.recent[0]).toMatchObject({ net_cents: 4000, settlement_status: "due" });
  });

  it("client payé à la centrale (en ligne) : la centrale doit la part chauffeur", async () => {
    const org = await centrale("Centrale En Ligne");
    const d = await driverIn(org, { at: NEAR });
    const ride = await ride59(org, { payment_method: "online" });
    await acceptAndComplete(d, ride.id);
    expect(await settlementOf(ride.id)).toMatchObject({ direction: "centrale_owes", amount_cents: 4000, status: "due" });
    const [push] = await sql(`select body from public.notifications where driver_id = $1 and type = 'settlement_payout'`, [d.id]);
    expect(push.body).toContain("40 € vous seront versés");

    const paid = await rpc(org.ownerId, "confirm_settlements", [[(await settlementOf(ride.id)).id], "transfer", null]);
    expect(paid.code).toBe("CONFIRMED");
    const [sent] = await sql(`select title from public.notifications where driver_id = $1 and type = 'settlement_payout_sent'`, [d.id]);
    expect(sent.title).toBe("VERSEMENT EFFECTUÉ");
  });

  it("prix corrigé après la course : recalcul tant que « à régler », verrouillé une fois déclaré", async () => {
    const org = await centrale("Centrale Correction");
    const d = await driverIn(org, { at: NEAR });
    const ride = await ride59(org);
    await acceptAndComplete(d, ride.id);

    await as({ sub: org.ownerId }, (q) => q(`update public.rides set price_cents = 6900 where id = $1`, [ride.id]));
    expect(await settlementOf(ride.id)).toMatchObject({ amount_cents: 1900, price_cents: 6900, driver_payout_cents: 5000 });
    await as({ sub: org.ownerId }, (q) => q(`update public.rides set commission_cents = 2000 where id = $1`, [ride.id]));
    expect(await settlementOf(ride.id)).toMatchObject({ amount_cents: 2500, driver_payout_cents: 4400 });

    const s = await settlementOf(ride.id);
    expect((await rpc(d.userId, "driver_declare_payment", [[s.id], "cash", "Donné à Mehdi"])).code).toBe("DECLARED");
    const locked = await expectPgError(as({ sub: org.ownerId }, (q) => q(`update public.rides set price_cents = 1000 where id = $1`, [ride.id])));
    expect(locked.message).toMatch(/SETTLEMENT_LOCKED/);
  });
});

// -----------------------------------------------------------------------------
describe("Blocages : commission en retard, encours, nouveaux chauffeurs", () => {
  it("retard → plus d'offre ni d'acceptation ; « J'ai payé » débloque ; contestation rebloque ; « Reçu » solde", async () => {
    const org = await centrale("Centrale Blocage");
    const d = await driverIn(org, { at: NEAR });
    const a = await ride59(org);
    await acceptAndComplete(d, a.id);
    const s = await settlementOf(a.id);
    await sql(`update public.ride_settlements set due_at = now() - interval '1 minute' where id = $1`, [s.id]);

    const c = await ride59(org);
    expect(await pendingOffer(c.id, d.id)).toBeUndefined();
    const [eligible] = await sql(`select message, data from public.ride_events where ride_id = $1 and type = 'dispatch.eligible' order by id limit 1`, [c.id]);
    expect(eligible.data.blocked).toBe(1);
    expect(eligible.message).toContain("1 exclu par les règles de la centrale");
    const home = await rpc(d.userId, "driver_home");
    expect(home.settlement).toMatchObject({ blocked: "unpaid", overdue_cents: 1900 });
    expect(home.settlement.blocked_message).toMatch(/réglez-la/);

    // Moyen non accepté / règlement d'un autre : refusés
    expect((await rpc(d.userId, "driver_declare_payment", [[s.id], "cheque", null])).code).toBe("INVALID_METHOD");
    const other = await driverIn(org);
    expect((await rpc(other.userId, "driver_declare_payment", [[s.id], "cash", null])).code).toBe("NOTHING_TO_DECLARE");

    expect((await rpc(d.userId, "driver_declare_payment", [[s.id], "link", null])).code).toBe("DECLARED");
    expect((await rpc(d.userId, "driver_home")).settlement.blocked).toBeNull();
    await sql(`select private.run_geo_wave($1)`, [c.id]);
    const offer = await pendingOffer(c.id, d.id);
    expect(offer).toBeTruthy();

    // La centrale n'a rien reçu : contestation → bloqué, l'offre reste ouverte mais l'acceptation est refusée
    expect((await rpc(org.ownerId, "dispute_settlement", [s.id, "Rien reçu sur Revolut"])).code).toBe("DISPUTED");
    const blocked = await rpc(d.userId, "accept_ride_offer", [offer]);
    expect(blocked).toMatchObject({ ok: false, code: "DRIVER_BLOCKED", reason: "unpaid" });
    const [{ r: offers }] = await as({ sub: d.userId }, (q) => q(`select public.driver_offers() as r`));
    expect(offers.find((o: any) => o.offer_id === offer).blocked).toBe("unpaid");
    const [disputedPush] = await sql(`select body from public.notifications where driver_id = $1 and type = 'settlement_disputed'`, [d.id]);
    expect(disputedPush.body).toContain("Rien reçu sur Revolut");

    const confirmed = await rpc(org.ownerId, "confirm_settlements", [[s.id], "cash", null]);
    expect(confirmed).toMatchObject({ ok: true, code: "CONFIRMED", count: 1, amount_cents: 1900 });
    expect((await rpc(d.userId, "accept_ride_offer", [offer])).code).toBe("ACCEPTED");
    const [paidPush] = await sql(`select body from public.notifications where driver_id = $1 and type = 'settlement_paid'`, [d.id]);
    expect(paidPush.body).toContain("a bien reçu 19 €");
  });

  it("plafond d'encours et plafond de prix des nouveaux chauffeurs ; passage automatique « confirmé »", async () => {
    const org = await centrale("Centrale Plafonds", { settlement_credit_limit_cents: 1000, new_driver_max_price_cents: 3000, trust_after_rides: 1 });
    const d = await driverIn(org, { at: NEAR, trust: "new" });

    // Nouveau chauffeur : course à 59 € au-dessus du plafond (30 €) → pas proposée
    const big = await ride59(org);
    expect(await pendingOffer(big.id, d.id)).toBeUndefined();
    await sql(`update public.rides set status = 'CANCELLED', next_dispatch_at = null where id = $1`, [big.id]);

    const small = await createRideAsOwner(org, { price_cents: 2500, commission_cents: 500, payment_method: "cash" });
    await acceptAndComplete(d, small.id);
    const s = await settlementOf(small.id);
    expect(s.amount_cents).toBe(1000);
    // 10 € dus, plafond 10 € : pas encore au-delà
    expect((await rpc(d.userId, "driver_home")).settlement.blocked).toBeNull();
    await sql(`update public.organization_settings set settlement_credit_limit_cents = 900 where organization_id = $1`, [org.id]);
    expect((await rpc(d.userId, "driver_home")).settlement.blocked).toBe("credit_limit");

    // Réglé : 1 course réglée → chauffeur confirmé, plus de plafond de prix
    await rpc(org.ownerId, "confirm_settlements", [[s.id], null, null]);
    const [trust] = await sql(`select trust_level from public.drivers where id = $1`, [d.id]);
    expect(trust.trust_level).toBe("trusted");
    const [promo] = await sql(`select title from public.notifications where driver_id = $1 and type = 'driver_trusted'`, [d.id]);
    expect(promo.title).toBe("CHAUFFEUR CONFIRMÉ");
    const again = await ride59(org);
    expect(await pendingOffer(again.id, d.id)).toBeTruthy();
  });

  it("relances : automatique (worker) une fois par 24 h, manuelle limitée à une toutes les 30 min", async () => {
    const org = await centrale("Centrale Relances");
    const d = await driverIn(org, { at: NEAR });
    const ride = await ride59(org);
    await acceptAndComplete(d, ride.id);
    const s = await settlementOf(ride.id);

    expect((await rpc(org.ownerId, "remind_driver_settlements", [d.id])).code).toBe("REMINDED");
    expect((await rpc(org.ownerId, "remind_driver_settlements", [d.id])).code).toBe("RATE_LIMITED");

    await sql(`update public.ride_settlements set due_at = now() - interval '2 hours', last_reminded_at = null where id = $1`, [s.id]);
    await sql(`select private.settlement_reminders()`);
    await sql(`select private.settlement_reminders()`);
    const auto = await sql(`select body from public.notifications where driver_id = $1 and type = 'settlement_reminder' and title = 'COMMISSION EN RETARD'`, [d.id]);
    expect(auto).toHaveLength(1);
    expect(auto[0].body).toContain("19 € à régler");
  });
});

// -----------------------------------------------------------------------------
describe("Règlements : droits et isolation", () => {
  it("isolation des centrales, rôles et lecture chauffeur limitée à ses lignes", async () => {
    const org = await centrale("Centrale Droits A");
    const orgB = await centrale("Centrale Droits B");
    const d = await driverIn(org, { at: NEAR });
    const ride = await ride59(org);
    await acceptAndComplete(d, ride.id);
    const s = await settlementOf(ride.id);

    const cross = await expectPgError(rpc(orgB.ownerId, "confirm_settlements", [[s.id], "cash", null]));
    expect(cross.code).toBe("42501");
    expect(await as({ sub: orgB.ownerId }, (q) => q(`select id from public.ride_settlements where id = $1`, [s.id]))).toHaveLength(0);
    await expectPgError(rpc(orgB.ownerId, "org_settlement_overview", [org.id]));
    // Le chauffeur ne confirme pas lui-même
    expect((await expectPgError(rpc(d.userId, "confirm_settlements", [[s.id], "cash", null]))).code).toBe("42501");
    const other = await driverIn(org);
    expect(await as({ sub: other.userId }, (q) => q(`select id from public.ride_settlements`))).toHaveLength(0);
    expect(await as({ sub: d.userId }, (q) => q(`select id from public.ride_settlements`))).toHaveLength(1);

    // Dispatcher : confirme, mais n'annule pas (owner / admin)
    const dispatcher = await createMember(org, "dispatcher");
    expect((await expectPgError(rpc(dispatcher, "waive_settlement", [s.id, "Geste commercial"]))).code).toBe("42501");
    expect((await rpc(org.ownerId, "waive_settlement", [s.id, "Geste commercial"])).code).toBe("WAIVED");
    expect((await rpc(org.ownerId, "reopen_settlement", [s.id])).code).toBe("REOPENED");
    expect((await rpc(dispatcher, "confirm_settlements", [[s.id], "cash", null])).code).toBe("CONFIRMED");

    const overview = await rpc(org.ownerId, "org_settlement_overview", [org.id]);
    expect(overview.totals.collected_month_cents).toBe(1900);
    expect(overview.month).toMatchObject({ rides: 1, volume_cents: 5900, commission_cents: 1400, platform_fee_cents: 500 });
    const list = await rpc(org.ownerId, "org_settlements", [org.id, "paid", null, 50, null]);
    expect(list.items[0]).toMatchObject({ id: s.id, status: "paid", settled_method: "cash", ride: { number: Number(ride.number) } });
  });

  it("modèle et frais plateforme : réservés au super admin ; lien de paiement en https", async () => {
    const org = await centrale("Centrale Grants");
    const model = await expectPgError(as({ sub: org.ownerId }, (q) => q(`update public.organizations set dispatch_model = 'fleet' where id = $1`, [org.id])));
    expect(model.code).toBe("42501");
    const fee = await expectPgError(as({ sub: org.ownerId }, (q) => q(`update public.organizations set platform_fee_fixed_cents = 0 where id = $1`, [org.id])));
    expect(fee.code).toBe("42501");
    const badLink = await expectPgError(
      as({ sub: org.ownerId }, (q) => q(`update public.organization_settings set settlement_link = 'http://paypal.me/x' where organization_id = $1`, [org.id])),
    );
    expect(badLink.code).toBe("23514");
    await as({ sub: org.ownerId }, (q) =>
      q(`update public.organization_settings set settlement_link = 'https://paypal.me/centrale/{montant}EUR', settlement_grace_hours = 0 where organization_id = $1`, [org.id]),
    );

    const superAdmin = await createAuthUser(`super-${randomUUID().slice(0, 6)}@rydar.dev`, "Super Admin");
    await sql(`update public.users set is_super_admin = true where id = $1`, [superAdmin]);
    expect((await expectPgError(rpc(org.ownerId, "admin_centrale_overview", [null]))).code).toBe("42501");
    const overview = await rpc(superAdmin, "admin_centrale_overview", [null]);
    expect(overview.organizations.find((o: any) => o.id === org.id)).toMatchObject({ platform_fee_fixed_cents: 500 });
  });
});

// -----------------------------------------------------------------------------
describe("Bannissement définitif", () => {
  it("identités hachées refusées dans la centrale (formats différents), pas ailleurs ; réactivation impossible", async () => {
    const org = await centrale("Centrale Ban");
    const orgB = await centrale("Centrale Voisine");
    const tag = randomUUID().slice(0, 6);
    const digits = uniquePhone();
    const d = await driverIn(org, { at: NEAR, phone: digits.replace(/(\d{2})(?=\d)/g, "$1 "), email: `k.a.r.i.m.${tag}@gmail.com` });
    await rpc(d.userId, "driver_register_device", [`install-${tag}-ban`, "android"]);

    const dispatcher = await createMember(org, "dispatcher");
    expect((await expectPgError(rpc(dispatcher, "ban_driver", [d.id, "Arnaque", "fraud", false, false]))).code).toBe("42501");
    const res = await rpc(org.ownerId, "ban_driver", [d.id, "Commission jamais payée", "unpaid", true, false]);
    expect(res).toMatchObject({ ok: true, code: "BANNED" });
    expect(res.identities).toBeGreaterThanOrEqual(3);

    const [row] = await sql(`select status, banned_at, ban_scope, presence from public.drivers where id = $1`, [d.id]);
    expect(row).toMatchObject({ status: "suspended", ban_scope: "org", presence: "offline" });
    expect(row.banned_at).not.toBeNull();
    const kinds = (await sql(`select kind from public.banned_identities where driver_id = $1 and scope = 'org' order by kind`, [d.id])).map((k) => k.kind);
    expect(kinds).toEqual(expect.arrayContaining(["device", "email", "phone"]));
    expect(kinds).not.toContain("plate");
    const [{ raw }] = await sql(`select count(*)::int as raw from public.banned_identities where driver_id = $1 and (hint like '%' || $2 || '%')`, [d.id, d.email]);
    expect(raw).toBe(0);

    // Plus d'accès (compte inactif) ; réactivation refusée tant que le bannissement tient
    expect((await expectPgError(rpc(d.userId, "driver_home"))).code).toBe("42501");
    const react = await expectPgError(as({ sub: org.ownerId }, (q) => q(`update public.drivers set status = 'active' where id = $1`, [d.id])));
    expect(react.message).toMatch(/DRIVER_BANNED/);
    expect((await rpc(d.userId, "driver_account_state")).state).toBe("banned");

    // Nouveau compte : même numéro écrit autrement, e-mail Gmail « déguisé »
    const samePhone = await expectPgError(driverIn(org, { phone: `+33 ${digits.slice(1, 2)} ${digits.slice(2)}` }));
    expect(samePhone.message).toMatch(/IDENTITY_BANNED/);
    const sameMail = await expectPgError(driverIn(org, { email: `karim${tag}+vtc@googlemail.com` }));
    expect(sameMail.message).toMatch(/IDENTITY_BANNED/);
    // Autre centrale : bannissement limité à la centrale
    const elsewhere = await driverIn(orgB, { phone: d.phone });
    expect(elsewhere.id).toBeTruthy();

    // Signalement plateforme : identités hachées uniquement
    const [report] = await sql(`select * from public.fraud_reports where driver_id = $1`, [d.id]);
    expect(report).toMatchObject({ status: "open", category: "unpaid" });
    expect(JSON.stringify(report.identities)).not.toContain(digits.slice(-6));

    // Lecture : admins de la centrale seulement
    expect(await as({ sub: dispatcher }, (q) => q(`select id from public.banned_identities`))).toHaveLength(0);
    expect((await as({ sub: org.ownerId }, (q) => q(`select id from public.banned_identities`))).length).toBeGreaterThanOrEqual(3);
    expect(await as({ sub: orgB.ownerId }, (q) => q(`select id from public.banned_identities where driver_id = $1`, [d.id]))).toHaveLength(0);
    expect(await as({ sub: orgB.ownerId }, (q) => q(`select id from public.fraud_reports`))).toHaveLength(0);
  });

  it("appareil d'un banni : nouveau compte suspendu ; course acceptée remise en recherche ; client à bord → refus", async () => {
    const org = await centrale("Centrale Appareil");
    const tag = randomUUID().slice(0, 8);
    const d = await driverIn(org, { at: NEAR });
    await rpc(d.userId, "driver_register_device", [`install-${tag}`, "ios"]);

    // Client à bord : pas de bannissement en pleine course
    const onboard = await ride59(org);
    const offer = await pendingOffer(onboard.id, d.id);
    await rpc(d.userId, "accept_ride_offer", [offer]);
    for (const s of ["DRIVER_EN_ROUTE", "DRIVER_ARRIVED", "PASSENGER_ONBOARD"]) await rpc(d.userId, "driver_update_ride_status", [onboard.id, s]);
    expect((await rpc(org.ownerId, "ban_driver", [d.id, "Arnaque", "fraud", false, false])).code).toBe("DRIVER_ON_RIDE");
    for (const s of ["IN_PROGRESS", "COMPLETED"]) await rpc(d.userId, "driver_update_ride_status", [onboard.id, s]);

    // Course planifiée acceptée : remise en recherche au bannissement
    await setLocation(org, d.id, NEAR);
    const later = await ride59(org, { pickup_at: new Date(Date.now() + 3 * 3600_000).toISOString() });
    const fleetOffer = await pendingOffer(later.id, d.id);
    expect((await rpc(d.userId, "accept_ride_offer", [fleetOffer])).code).toBe("ACCEPTED");
    const res = await rpc(org.ownerId, "ban_driver", [d.id, "Arnaque au client", "fraud", false, true]);
    expect(res).toMatchObject({ code: "BANNED", reassigned_rides: 1 });
    const [again] = await sql(`select driver_id, status from public.rides where id = $1`, [later.id]);
    expect(again.driver_id).toBeNull();
    expect(["SEARCHING_DRIVER", "OFFERED"]).toContain(again.status);
    // Plaque bannie (option) : la même voiture ne revient pas
    expect((await expectPgError(driverIn(org, { plate: d.plate }))).message).toMatch(/IDENTITY_BANNED/);

    // Nouveau compte sur le même téléphone : suspendu dès l'enregistrement de l'appareil
    const fresh = await driverIn(org);
    await rpc(fresh.userId, "driver_register_device", [`install-${tag}`, "ios"]);
    const [f] = await sql(`select status, suspended_reason from public.drivers where id = $1`, [fresh.id]);
    expect(f.status).toBe("suspended");
    expect(f.suspended_reason).toMatch(/compte banni/);
    const [audit] = await sql(`select severity from public.audit_logs where action = 'driver.banned_device' and entity_id = $1`, [fresh.id]);
    expect(audit.severity).toBe("critical");
  });

  it("bannissement plateforme (super admin) : toutes les centrales, puis levée", async () => {
    const orgA = await centrale("Centrale Signal A");
    const orgB = await centrale("Centrale Signal B");
    const orgC = await centrale("Centrale Signal C");
    const phone = uniquePhone();
    const vtc = `EVTC 075 ${Math.floor(Math.random() * 1e6)}`;
    const bad = await driverIn(orgA, { phone, vtc });
    const twin = await driverIn(orgB, { phone });
    const res = await rpc(orgA.ownerId, "ban_driver", [bad.id, "Faux paiements répétés", "fraud", true, false]);
    const reportId = res.report_id as string;
    expect(reportId).toBeTruthy();

    // Réservé au service role (routes serveur du super admin)
    expect((await expectPgError(rpc(orgA.ownerId, "svc_platform_ban", [reportId, orgA.ownerId, null]))).code).toBe("42501");
    const ban = await svc("svc_platform_ban", [reportId, orgA.ownerId, "Confirmé"]);
    expect(ban).toMatchObject({ ok: true, code: "PLATFORM_BANNED", drivers: 2 });
    expect(ban.user_ids).toEqual(expect.arrayContaining([bad.userId, twin.userId]));
    const [t] = await sql(`select status, ban_scope from public.drivers where id = $1`, [twin.id]);
    expect(t).toEqual({ status: "suspended", ban_scope: "platform" });
    expect((await expectPgError(driverIn(orgC, { phone }))).message).toMatch(/plateforme Rydar/);
    expect((await expectPgError(driverIn(orgC, { vtc: vtc.toLowerCase().replace(/ /g, "") }))).message).toMatch(/IDENTITY_BANNED/);
    expect((await rpc(orgA.ownerId, "lift_driver_ban", [bad.id, null])).code).toBe("PLATFORM_BAN");

    const lift = await svc("svc_platform_unban", [reportId, orgA.ownerId, "Erreur d'identité"]);
    expect(lift.user_ids).toEqual([twin.userId]);
    const [t2] = await sql(`select status, banned_at from public.drivers where id = $1`, [twin.id]);
    expect(t2).toEqual({ status: "suspended", banned_at: null });
    const [b2] = await sql(`select ban_scope from public.drivers where id = $1`, [bad.id]);
    expect(b2.ban_scope).toBe("org");
    expect((await driverIn(orgC, { phone })).id).toBeTruthy();

    // Levée par la centrale : le numéro redevient utilisable chez elle
    expect((await rpc(orgA.ownerId, "lift_driver_ban", [bad.id, "Dette réglée"])).code).toBe("LIFTED");
    expect((await driverIn(orgA, { phone: phone.replace(/^0/, "+33") })).id).toBeTruthy();
  });
});

// -----------------------------------------------------------------------------
describe("Inscription par lien (/rejoindre/{code})", () => {
  it("lien réservé aux centrales, candidature en attente, documents avant validation, validation / refus", async () => {
    const fleet = await createOrg("Flotte Sans Lien");
    expect((await rpc(fleet.ownerId, "set_join_link", [fleet.id, true, false, null])).code).toBe("CENTRALE_ONLY");
    const org = await centrale("Centrale Recrute");
    const dispatcher = await createMember(org, "dispatcher");
    expect((await expectPgError(rpc(dispatcher, "set_join_link", [org.id, true, false, null]))).code).toBe("42501");
    const link = await rpc(org.ownerId, "set_join_link", [org.id, true, false, null]);
    expect(link.join_code).toMatch(/^[0-9a-f]{16}$/);

    expect((await svc("svc_join_info", [link.join_code.toUpperCase()])).organization.name).toBe("Centrale Recrute");
    expect((await svc("svc_join_info", ["inconnu"])).code).toBe("JOIN_LINK_INVALID");
    expect((await expectPgError(rpc(org.ownerId, "svc_join_info", [link.join_code]))).code).toBe("42501");

    const phone = uniquePhone();
    const email = `samir-${randomUUID().slice(0, 6)}@test.dev`;
    expect(await svc("svc_identity_check", [org.id, phone, email, null, "ZZ-999-ZZ"])).toEqual({ banned: false, duplicate: null });
    const userId = await createAuthUser(email, "Samir Candidat");
    const vehicle = { brand: "Toyota", model: "Prius+", plate: uniquePlate(), category: "standard", seats: 4 };
    const applied = await svc("svc_driver_apply", [org.id, userId, "Samir", "Candidat", phone, email, "EVTC 1234", JSON.stringify(vehicle), "Dispo la nuit"]);
    expect(applied.code).toBe("PENDING");
    const [cand] = await sql(`select status, application_status, trust_level, joined_via from public.drivers where id = $1`, [applied.driver_id]);
    expect(cand).toEqual({ status: "inactive", application_status: "pending", trust_level: "new", joined_via: "join_link" });
    const [realtime] = await sql(`select payload from realtime.messages where event = 'driver.application' and topic = $1 order by id desc limit 1`, [`org:${org.id}`]);
    expect(realtime.payload.action).toBe("applied");

    // Candidat : écran d'attente + documents, mais pas de courses
    expect((await rpc(userId, "driver_account_state")).state).toBe("pending");
    expect((await rpc(userId, "driver_documents")).missing_types).toContain("vtc_card");
    expect((await expectPgError(rpc(userId, "driver_home"))).code).toBe("42501");

    // Doublons
    expect((await svc("svc_identity_check", [org.id, phone, "autre@test.dev", null, null])).duplicate).toBe("phone");
    const user2 = await createAuthUser(`bis-${randomUUID().slice(0, 6)}@test.dev`, "Bis");
    expect((await svc("svc_driver_apply", [org.id, user2, "Bis", "Bis", phone.replace(/^0/, "+33"), `bis-${randomUUID().slice(0, 4)}@test.dev`, null, JSON.stringify({ model: "Zoé", plate: uniquePlate() }), null])).code).toBe("PHONE_TAKEN");
    expect((await svc("svc_driver_apply", [org.id, user2, "Bis", "Bis", uniquePhone(), `bis-${randomUUID().slice(0, 4)}@test.dev`, null, JSON.stringify({ model: "Zoé", plate: vehicle.plate }), null])).code).toBe("PLATE_TAKEN");

    // Validation (owner / admin) : actif, notifié
    expect((await expectPgError(rpc(dispatcher, "approve_driver_application", [applied.driver_id, null]))).code).toBe("42501");
    expect((await rpc(org.ownerId, "approve_driver_application", [applied.driver_id, null])).code).toBe("APPROVED");
    expect((await rpc(userId, "driver_account_state")).state).toBe("active");
    expect((await rpc(userId, "driver_home")).driver.trust_level).toBe("new");
    const [welcome] = await sql(`select body from public.notifications where driver_id = $1 and type = 'application_approved'`, [applied.driver_id]);
    expect(welcome.body).toContain("Bienvenue chez Centrale Recrute");
    expect((await rpc(org.ownerId, "approve_driver_application", [applied.driver_id, null])).code).toBe("NOT_PENDING");

    // Le candidat enregistre son appareil (notification de validation) et connaît sa centrale
    const state = await rpc(userId, "driver_account_state");
    expect(state.organization).toMatchObject({ id: org.id, timezone: "Europe/Paris" });

    // Refus
    const user3 = await createAuthUser(`ter-${randomUUID().slice(0, 6)}@test.dev`, "Ter");
    const other = await svc("svc_driver_apply", [org.id, user3, "Ter", "Candidat", uniquePhone(), `ter-${randomUUID().slice(0, 4)}@test.dev`, null, JSON.stringify({ model: "Classe V", plate: uniquePlate(), category: "van", seats: 7 }), null]);
    expect((await rpc(org.ownerId, "reject_driver_application", [other.driver_id, "Pas de carte VTC"])).code).toBe("REJECTED");
    expect(await rpc(user3, "driver_account_state")).toMatchObject({ state: "rejected", reason: "Pas de carte VTC" });
    // La centrale change d'avis : candidature reconsidérée
    expect((await rpc(org.ownerId, "approve_driver_application", [other.driver_id, "new"])).code).toBe("APPROVED");
    expect((await rpc(user3, "driver_account_state")).state).toBe("active");
  });

  it("candidat sur l'appareil d'un banni : candidature refusée d'office, reconsidérable", async () => {
    const org = await centrale("Centrale Appareil Candidat");
    await rpc(org.ownerId, "set_join_link", [org.id, true, false, false]);
    const tag = randomUUID().slice(0, 8);
    const cheat = await driverIn(org);
    await rpc(cheat.userId, "driver_register_device", [`install-${tag}`, "android"]);
    expect((await rpc(org.ownerId, "ban_driver", [cheat.id, "Arnaque", "fraud", false, false])).code).toBe("BANNED");

    const u = await createAuthUser(`retour-${randomUUID().slice(0, 6)}@test.dev`, "Retour");
    const applied = await svc("svc_driver_apply", [org.id, u, "Nouveau", "Nom", uniquePhone(), `retour-${randomUUID().slice(0, 4)}@test.dev`, null, JSON.stringify({ model: "Clio", plate: uniquePlate() }), null]);
    expect(applied.code).toBe("PENDING");
    // Même téléphone (appareil) que le banni : candidature refusée dès l'enregistrement de l'appareil
    expect((await rpc(u, "driver_register_device", [`install-${tag}`, "android", "ExponentPushToken[retour-123456]"])).ok).toBe(true);
    const state = await rpc(u, "driver_account_state");
    expect(state).toMatchObject({ state: "rejected", reason: "Candidature non retenue : contactez la centrale." });
    const [audit] = await sql(`select metadata from public.audit_logs where action = 'driver.banned_device' and entity_id = $1`, [applied.driver_id]);
    expect(audit.metadata.applicant).toBe(true);

    // Un chauffeur banni ne se « valide » pas ; le candidat refusé peut être reconsidéré
    expect((await rpc(org.ownerId, "approve_driver_application", [cheat.id, null])).code).toBe("DRIVER_BANNED");
    expect((await rpc(org.ownerId, "approve_driver_application", [applied.driver_id, "new"])).code).toBe("APPROVED");
    expect((await rpc(u, "driver_account_state")).state).toBe("active");
  });

  it("validation automatique, identité bannie refusée, lien coupé au retour en mode flotte", async () => {
    const org = await centrale("Centrale Auto");
    const link = await rpc(org.ownerId, "set_join_link", [org.id, true, false, true]);
    expect(link.join_auto_approve).toBe(true);

    const u1 = await createAuthUser(`auto-${randomUUID().slice(0, 6)}@test.dev`, "Auto");
    const ok = await svc("svc_driver_apply", [org.id, u1, "Auto", "Validé", uniquePhone(), `auto-${randomUUID().slice(0, 4)}@test.dev`, null, JSON.stringify({ model: "Model 3", plate: uniquePlate() }), null]);
    expect(ok.code).toBe("APPROVED");
    const [row] = await sql(`select status, application_status from public.drivers where id = $1`, [ok.driver_id]);
    expect(row).toEqual({ status: "active", application_status: "approved" });

    // Carte VTC d'un chauffeur banni : refus neutre (sans exception)
    const vtc = `EVTC 092 ${Math.floor(Math.random() * 1e6)}`;
    const cheat = await driverIn(org, { vtc });
    await rpc(org.ownerId, "ban_driver", [cheat.id, "Vol de courses", "fraud", false, false]);
    expect((await svc("svc_identity_check", [org.id, uniquePhone(), "x@test.dev", vtc.toLowerCase(), null])).banned).toBe(true);
    const u2 = await createAuthUser(`cheat-${randomUUID().slice(0, 6)}@test.dev`, "Cheat");
    const refused = await svc("svc_driver_apply", [org.id, u2, "Nouveau", "Nom", uniquePhone(), `cheat-${randomUUID().slice(0, 4)}@test.dev`, vtc.replace(/ /g, "-"), JSON.stringify({ model: "Clio", plate: uniquePlate() }), null]);
    expect(refused).toMatchObject({ ok: false, code: "IDENTITY_BANNED" });
    expect(await sql(`select id from public.drivers where user_id = $1`, [u2])).toHaveLength(0);

    await sql(`update public.organizations set dispatch_model = 'fleet' where id = $1`, [org.id]);
    const [o] = await sql(`select join_enabled from public.organizations where id = $1`, [org.id]);
    expect(o.join_enabled).toBe(false);
    expect((await svc("svc_join_info", [link.join_code])).code).toBe("JOIN_LINK_INVALID");
  });
});
