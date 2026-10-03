// Réseau partagé — outils communs des tests des lots administration et cycle de vie (20260924007100) : organisations
// validées, chauffeur partenaire prêt, course partagée acceptée (étape réseau réelle du dispatch) puis menée au bout.
// Les fichiers des lots précédents (dispatch, argent, accès) gardent leurs propres copies. Pas un fichier de test
// (aucun « .test.ts ») : importé par les fichiers qui en ont besoin.
import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import {
  acceptDriverTerms, approveNetwork, as, CDG, createAuthUser, createDriver, createOrg, createRideAsOwner, enableNetwork, north,
  pingApp, sql, type Driver, type Org,
} from "./helpers";

export const tag = () => randomUUID().slice(0, 6);
/** Téléphone propre à un chauffeur (empreintes d'identité : createDriver donne le même numéro à tous). */
export const uniquePhone = () => `+3364${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;

/**
 * Lieux propres à un fichier (base de latitude distincte par fichier : le compteur repart de zéro dans chaque fichier),
 * ≈ 39 km d'écart, plus que le rayon réseau maximal, loin des lieux des autres fichiers (dispatch 42,5+, argent 20+,
 * accès −10−).
 */
export function siteMaker(baseLat: number) {
  let n = 0;
  return (): [number, number] => [baseLat - ++n * 0.35, 2.35];
}

/** Chauffeur partenaire prêt : position, téléphone, carte VTC, n° d'exploitant, 4 documents valides, conditions, app à jour. */
export async function readyPartner(B: Org, opts: { firstName?: string; lastName?: string; at: [number, number] }): Promise<Driver> {
  const d = await createDriver(B, { firstName: opts.firstName ?? "Karim", at: opts.at });
  await sql(
    `update public.drivers set phone = $2, vtc_card_number = $3, last_name = $4, vtc_operator_registration = 'EVTC075990001'
      where id = $1`,
    [d.id, uniquePhone(), `VTC${tag()}`, opts.lastName ?? "Tazi"],
  );
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

export type Model = "fleet" | "centrale";
export type Pair = { A: Org; B: Org; partner: Driver; site: [number, number]; aName: string; bName: string };

export async function orgName(org: Org): Promise<string> {
  const [o] = await sql(`select name from public.organizations where id = $1`, [org.id]);
  return o.name;
}

/** Organisation qui confie ses courses (10 % de frais Rydar ; centrale : 15 % de commission), partage validé. */
export async function giver(name: string, model: Model = "fleet"): Promise<Org> {
  const A = await createOrg(`${name} ${tag()}`);
  if (model === "centrale") {
    await sql(`update public.organizations set dispatch_model = 'centrale' where id = $1`, [A.id]);
    await sql(`update public.organization_settings set driver_commission_percent = 15 where organization_id = $1`, [A.id]);
  }
  await enableNetwork(A, { out: true });
  await approveNetwork(A);
  return A;
}

/** A (donneuse) partage, B (flotte) reçoit ; validées ; un partenaire prêt chez B près du lieu de la paire. */
export async function networkPair(site: [number, number], opts: { giver?: Model } = {}): Promise<Pair> {
  const A = await giver("Donneuse", opts.giver ?? "fleet");
  const B = await createOrg(`Executante ${tag()}`);
  await enableNetwork(B, { in: true });
  await approveNetwork(B);
  const partner = await readyPartner(B, { at: north(site, 800) });
  return { A, B, partner, site, aName: await orgName(A), bName: await orgName(B) };
}

/** Position du chauffeur (reçue il y a ageSeconds). */
export async function moveTo(driverId: string, at: [number, number], ageSeconds = 0) {
  await sql(
    `update public.driver_locations
        set lat = $2, lng = $3, recorded_at = now() - make_interval(secs => $4), updated_at = now() - make_interval(secs => $4)
      where driver_id = $1`,
    [driverId, at[0], at[1], ageSeconds],
  );
}

/** Course de A arrivée à l'étape réseau (vagues propres épuisées) : offres réseau envoyées par le dispatch. */
export async function rideAtNetworkStep(p: Pair, overrides: Record<string, unknown> = {}, A: Org = p.A) {
  await moveTo(p.partner.id, north(p.site, 800));
  const ride = await createRideAsOwner(A, { pickup_lat: p.site[0], pickup_lng: p.site[1], price_cents: 5000, ...overrides });
  await sql(`update public.rides set dispatch_wave = 6, next_dispatch_at = now() - interval '1 second' where id = $1`, [ride.id]);
  await sql("select private.dispatch_tick()");
  return ride;
}

/** Offre réseau en attente d'un chauffeur pour une course. */
export async function pendingOffer(rideId: string, driverId: string) {
  const [offer] = await sql(`select * from public.ride_offers where ride_id = $1 and driver_id = $2 and status = 'pending'`, [rideId, driverId]);
  return offer as { id: string; status: string; closed_reason: string | null } | undefined;
}

/** Course de A acceptée par le partenaire : étape réseau réelle (après les vagues propres) + accept_ride_offer. */
export async function partnerAccepts(p: Pair, partner: Driver = p.partner, overrides: Record<string, unknown> = {}, A: Org = p.A) {
  await sql(`update public.drivers set presence = 'available', current_ride_id = null where id = $1`, [partner.id]);
  const ride = await rideAtNetworkStep({ ...p, partner }, overrides, A);
  const offer = await pendingOffer(ride.id, partner.id);
  expect(offer, "offre réseau envoyée").toBeTruthy();
  const res = await as({ sub: partner.userId }, async (q) => (await q("select public.accept_ride_offer($1) as r", [offer!.id]))[0].r);
  expect(res).toMatchObject({ ok: true, code: "ACCEPTED" });
  const [execution] = await sql(`select * from public.ride_network_executions where ride_id = $1 and ended_at is null`, [ride.id]);
  return { ride, execution };
}

/** Étape déclarée par le chauffeur (application). */
export async function stepAs(driver: Driver, rideId: string, status: string) {
  return as({ sub: driver.userId }, async (q) => (await q("select public.driver_update_ride_status($1, $2) as r", [rideId, status]))[0].r);
}

/** Course menée jusqu'au bout par le chauffeur, positions fraîches (aucune raison « à vérifier »). */
export async function finish(driver: Driver, rideId: string, site: [number, number]) {
  for (const s of ["DRIVER_EN_ROUTE", "DRIVER_ARRIVED", "PASSENGER_ONBOARD", "IN_PROGRESS"]) {
    await moveTo(driver.id, site);
    expect(await stepAs(driver, rideId, s), s).toMatchObject({ ok: true });
  }
  await moveTo(driver.id, CDG);
  expect(await stepAs(driver, rideId, "COMPLETED")).toMatchObject({ ok: true, status: "COMPLETED" });
}

/** Course partagée faite de bout en bout ; renvoie la course, l'exécution et la ligne réseau créée. */
export async function sharedRide(p: Pair, overrides: Record<string, unknown> = {}, opts: { partner?: Driver; A?: Org } = {}) {
  const partner = opts.partner ?? p.partner;
  const { ride, execution } = await partnerAccepts(p, partner, overrides, opts.A ?? p.A);
  await finish(partner, ride.id, p.site);
  const [settlement] = await sql(`select * from public.ride_settlements where ride_id = $1`, [ride.id]);
  return { ride, execution, settlement };
}

/** RPC sous le rôle authenticated (JWT de `who`). */
export const rpc = async (who: string, fn: string, args: unknown[] = []) =>
  as({ sub: who }, async (q) => (await q(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as r`, args))[0].r);

/** RPC sous le rôle service_role (actions serveur du web). */
export const svc = async (fn: string, args: unknown[] = []) =>
  as({ role: "service_role" }, async (q) => (await q(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as r`, args))[0].r);

/** Super admin (compte de la plateforme). */
export async function superAdmin(): Promise<string> {
  const id = await createAuthUser(`sa-${tag()}@test.dev`, "Super Admin");
  await sql(`update public.users set is_super_admin = true where id = $1`, [id]);
  return id;
}
