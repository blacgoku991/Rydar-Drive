/**
 * Simulateur de flotte (démo / recette) — passe par les VRAIES RPC chauffeur :
 * update_driver_location, accept_ride_offer, driver_update_ride_status.
 *
 *   SIM_ORG=<uuid|slug>  SIM_NEW_RIDE_EVERY=45  SIM_SPEEDUP=3  OSRM_URL=…  pnpm --filter @rydar/worker simulate
 *
 * Les véhicules suivent de vrais itinéraires routiers (OSRM) : maraude, approche
 * du client, puis trajet jusqu'à la destination. Les chauffeurs acceptent ~75 %
 * des offres après quelques secondes.
 */
import { decodePolyline, haversine, pointAlong, type Coord } from "@rydar/shared";
import pg from "pg";
import { config, log } from "./config";
import { osrmRoute } from "./routing";

const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 6 });
const ORG = process.env.SIM_ORG ?? "elite-paris";
const STEP_MS = Number(process.env.SIM_STEP_MS ?? 3000);
const NEW_RIDE_EVERY_S = Number(process.env.SIM_NEW_RIDE_EVERY ?? 0);
const SPEEDUP = Number(process.env.SIM_SPEEDUP ?? 3);
const ACCEPT_RATE = Number(process.env.SIM_ACCEPT_RATE ?? 0.75);

type Leg = { key: string; coords: Coord[]; length: number; speed: number; done: number };
type Sim = { id: string; userId: string; name: string; lat: number; lng: number; heading: number; leg?: Leg; routing?: boolean; waitUntil?: number };
const sims = new Map<string, Sim>();
const pendingDecisions = new Set<string>();

async function asDriver<T>(userId: string, sql: string, params: unknown[]): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId, role: "authenticated" })]);
    await c.query("set local role authenticated");
    const { rows } = await c.query(sql, params);
    await c.query("commit");
    return rows[0] as T;
  } catch (error) {
    await c.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    c.release();
  }
}

/** Prépare (asynchrone) un trajet routier pour le véhicule. */
function planLeg(s: Sim, key: string, to: { lat: number; lng: number }, speedMs: number, known?: Coord[]) {
  if (s.routing || s.leg?.key === key) return;
  s.routing = true;
  const done = (coords: Coord[]) => {
    const length = coords.reduce((acc, p, i) => (i ? acc + haversine({ lat: coords[i - 1]![1], lng: coords[i - 1]![0] }, { lat: p[1], lng: p[0] }) : 0), 0);
    s.leg = { key, coords, length, speed: speedMs, done: 0 };
    s.routing = false;
  };
  if (known && known.length > 1) return done(known);
  osrmRoute({ lat: s.lat, lng: s.lng }, to)
    .then((r) => done(r.coords))
    .catch(() => done([[s.lng, s.lat], [to.lng, to.lat]]));
}

/** Avance le long du trajet ; renvoie la distance restante (m). */
function advance(s: Sim, dtS: number): number {
  const leg = s.leg;
  if (!leg) return Infinity;
  leg.done = Math.min(leg.length, leg.done + leg.speed * dtS * SPEEDUP);
  const p = pointAlong(leg.coords, leg.done);
  s.lng = p.point[0];
  s.lat = p.point[1];
  s.heading = p.heading;
  return leg.length - leg.done;
}

async function orgId(): Promise<string> {
  const { rows } = await pool.query("select id from organizations where id::text = $1 or slug = $1", [ORG]);
  if (!rows[0]) throw new Error(`Organisation introuvable : ${ORG}`);
  return rows[0].id;
}

function randomAround(lat: number, lng: number, radiusM: number) {
  const r = radiusM * (0.4 + Math.random() * 0.6);
  const t = Math.random() * 2 * Math.PI;
  return { lat: lat + (r * Math.cos(t)) / 111_320, lng: lng + (r * Math.sin(t)) / (111_320 * Math.cos((lat * Math.PI) / 180)) };
}

async function step(org: string) {
  const dt = STEP_MS / 1000;
  const { rows: drivers } = await pool.query(
    `select d.id, d.user_id, d.first_name, d.presence, d.current_ride_id, l.lat, l.lng
       from drivers d left join driver_locations l on l.driver_id = d.id
      where d.organization_id = $1 and d.status = 'active' and d.presence <> 'offline' and d.user_id is not null`,
    [org],
  );
  for (const d of drivers) {
    let s = sims.get(d.id);
    if (!s) {
      s = { id: d.id, userId: d.user_id, name: d.first_name, lat: d.lat ?? 48.8566, lng: d.lng ?? 2.3522, heading: Math.random() * 360 };
      sims.set(d.id, s);
    }
    const ride = d.current_ride_id
      ? (await pool.query("select id, status, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng, route_polyline from rides where id = $1", [d.current_ride_id])).rows[0]
      : null;
    let speed = 0;
    if (ride) {
      const next = (status: string) => asDriver(s!.userId, "select public.driver_update_ride_status($1, $2) as r", [ride.id, status]).catch(() => null);
      if (["ACCEPTED", "DRIVER_EN_ROUTE"].includes(ride.status)) {
        planLeg(s, `${ride.id}:approach`, { lat: ride.pickup_lat, lng: ride.pickup_lng }, 11);
        const remaining = s.leg?.key === `${ride.id}:approach` ? advance(s, dt) : Infinity;
        speed = 11 * SPEEDUP;
        if (ride.status === "ACCEPTED") await next("DRIVER_EN_ROUTE");
        else if (remaining < 40) {
          await next("DRIVER_ARRIVED");
          s.waitUntil = Date.now() + 12_000;
        }
      } else if (ride.status === "DRIVER_ARRIVED") {
        if (!s.waitUntil || Date.now() > s.waitUntil) await next("PASSENGER_ONBOARD");
      } else if (ride.status === "PASSENGER_ONBOARD") {
        await next("IN_PROGRESS");
      } else if (ride.status === "IN_PROGRESS" && ride.dropoff_lat != null) {
        const known = ride.route_polyline ? decodePolyline(ride.route_polyline) : undefined;
        planLeg(s, `${ride.id}:trip`, { lat: ride.dropoff_lat, lng: ride.dropoff_lng }, 13, known);
        const remaining = s.leg?.key === `${ride.id}:trip` ? advance(s, dt) : Infinity;
        speed = 13 * SPEEDUP;
        if (remaining < 40) {
          await next("COMPLETED");
          s.leg = undefined;
        }
      }
    } else {
      // Maraude sur de vraies rues autour de la position
      if (!s.leg?.key.startsWith("cruise") || s.leg.done >= s.leg.length) {
        s.leg = undefined;
        planLeg(s, `cruise:${Date.now()}`, randomAround(s.lat, s.lng, 1800), 7);
      }
      if (s.leg) advance(s, dt);
      speed = 7 * SPEEDUP;
    }
    await asDriver(s.userId, "select public.update_driver_location($1, $2, $3, $4, 8, 0.8, now()) as r", [s.lat, s.lng, ((s.heading % 360) + 360) % 360, speed]).catch((e) =>
      log("warn", "location failed", { driver: s!.name, error: (e as Error).message }),
    );
  }

  // Décisions sur les offres en attente
  const { rows: offers } = await pool.query(
    `select o.id, o.driver_id, d.user_id, d.first_name from ride_offers o join drivers d on d.id = o.driver_id
      where o.organization_id = $1 and o.status = 'pending'`,
    [org],
  );
  for (const o of offers) {
    if (pendingDecisions.has(o.id)) continue;
    pendingDecisions.add(o.id);
    const delay = 3000 + Math.random() * 10000;
    setTimeout(async () => {
      const roll = Math.random();
      const fn = roll < ACCEPT_RATE ? "accept_ride_offer" : roll < ACCEPT_RATE + 0.1 ? "decline_ride_offer" : null;
      if (fn) {
        const res = await asDriver<{ r: { ok: boolean; code: string } }>(o.user_id, `select public.${fn}($1) as r`, [o.id]).catch(() => null);
        log("info", `${o.first_name} → ${fn}`, { code: res?.r?.code });
      }
      pendingDecisions.delete(o.id);
    }, delay);
  }
}

const SPOTS = [
  ["Gare de Lyon, Place Louis-Armand, 75012 Paris", 48.8443, 2.3743],
  ["Aéroport Paris-Charles de Gaulle, Terminal 2E, 95700 Roissy-en-France", 49.0047, 2.571],
  ["La Défense, Parvis de la Défense, 92400 Courbevoie", 48.8924, 2.236],
  ["Opéra Garnier, Place de l'Opéra, 75009 Paris", 48.872, 2.3316],
  ["Gare du Nord, 18 Rue de Dunkerque, 75010 Paris", 48.8809, 2.3553],
  ["Aéroport de Paris-Orly, Terminal 4, 94390 Orly", 48.7262, 2.3652],
  ["Hôtel Plaza Athénée, 25 Avenue Montaigne, 75008 Paris", 48.8663, 2.304],
  ["Place de la Bastille, 75011 Paris", 48.8532, 2.3692],
  ["Tour Eiffel, 5 Avenue Anatole France, 75007 Paris", 48.8584, 2.2945],
  ["Gare Montparnasse, 17 Boulevard de Vaugirard, 75015 Paris", 48.8414, 2.3209],
  ["Palais des Congrès, 2 Place de la Porte Maillot, 75017 Paris", 48.8785, 2.283],
  ["Hôtel Le Bristol, 112 Rue du Faubourg Saint-Honoré, 75008 Paris", 48.8718, 2.315],
] as const;
const CUSTOMERS = ["M. Laurent Dubois", "Mme Claire Fontaine", "Famille Martin", "M. Pierre Girard", "Cabinet Delsol — M. Perrin", "Mme Sophie Bernard", "M. Julien Morel"];

async function newRide(org: string) {
  const a = SPOTS[Math.floor(Math.random() * SPOTS.length)]!;
  let b = SPOTS[Math.floor(Math.random() * SPOTS.length)]!;
  if (b === a) b = SPOTS[(SPOTS.indexOf(a) + 3) % SPOTS.length]!;
  const route = await osrmRoute({ lat: a[1], lng: a[2] }, { lat: b[1], lng: b[2] });
  const price = Math.max(35, Math.round((20 + (route.distanceM / 1000) * 1.9 + (route.durationS / 60) * 0.45) / 1)) * 100;
  const { rows } = await pool.query(
    `insert into rides (organization_id, source, pickup_address, pickup_lat, pickup_lng, dropoff_address, dropoff_lat, dropoff_lng,
       customer_name, customer_phone, passengers, vehicle_category, price_cents, estimated_distance_m, estimated_duration_s, route_polyline, route_provider)
     values ($1, 'api', $2, $3, $4, $5, $6, $7, $8, '+33612345678', 1 + floor(random() * 3)::int,
       (array['business','business','standard'])[1 + floor(random() * 3)::int]::vehicle_category, $9, $10, $11, $12, $13)
     returning number`,
    [org, a[0], a[1], a[2], b[0], b[1], b[2], CUSTOMERS[Math.floor(Math.random() * CUSTOMERS.length)], price, route.distanceM, route.durationS, route.polyline, route.approximate ? "estimate" : "osrm"],
  );
  log("info", "course simulée créée", { number: rows[0]?.number, km: Math.round(route.distanceM / 100) / 10 });
}

async function main() {
  const org = await orgId();
  log("info", "simulateur démarré", { org, stepMs: STEP_MS, newRideEvery: NEW_RIDE_EVERY_S || "off", speedup: SPEEDUP });
  setInterval(() => step(org).catch((e) => log("error", "step failed", { error: (e as Error).message })), STEP_MS);
  if (NEW_RIDE_EVERY_S > 0) setInterval(() => newRide(org).catch((e) => log("error", "new ride failed", { error: (e as Error).message })), NEW_RIDE_EVERY_S * 1000);
}

void main();
