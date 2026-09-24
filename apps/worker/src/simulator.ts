/**
 * Simulateur de flotte (démo / recette) — passe par les VRAIES RPC chauffeur :
 * update_driver_location, accept_ride_offer, driver_update_ride_status.
 *
 *   SIM_ORG=<uuid|slug>  SIM_NEW_RIDE_EVERY=45  pnpm --filter @rydar/worker simulate
 *
 * Les chauffeurs en ligne roulent, acceptent ~75 % des offres après quelques
 * secondes, puis enchaînent le cycle de course jusqu'à la destination.
 */
import { haversine } from "@rydar/shared";
import pg from "pg";
import { config, log } from "./config";

const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 6 });
const ORG = process.env.SIM_ORG ?? "elite-paris";
const STEP_MS = Number(process.env.SIM_STEP_MS ?? 3000);
const NEW_RIDE_EVERY_S = Number(process.env.SIM_NEW_RIDE_EVERY ?? 0);

type Sim = { id: string; userId: string; name: string; lat: number; lng: number; heading: number; target?: { lat: number; lng: number } };
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

function moveToward(s: Sim, target: { lat: number; lng: number }, metersPerStep: number) {
  const d = haversine(s, target);
  if (d < 1) return 0;
  const k = Math.min(1, metersPerStep / d);
  s.heading = (Math.atan2(target.lng - s.lng, target.lat - s.lat) * 180) / Math.PI;
  s.lat += (target.lat - s.lat) * k;
  s.lng += (target.lng - s.lng) * k;
  return d;
}

async function orgId(): Promise<string> {
  const { rows } = await pool.query("select id from organizations where id::text = $1 or slug = $1", [ORG]);
  if (!rows[0]) throw new Error(`Organisation introuvable : ${ORG}`);
  return rows[0].id;
}

async function step(org: string) {
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
    // Course en cours : on roule vers le départ puis la destination
    const ride = d.current_ride_id
      ? (await pool.query("select id, status, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng from rides where id = $1", [d.current_ride_id])).rows[0]
      : null;
    let speed = 8 + Math.random() * 10; // m/s en maraude
    if (ride) {
      const toPickup = ["ACCEPTED", "DRIVER_EN_ROUTE"].includes(ride.status);
      const target = toPickup ? { lat: ride.pickup_lat, lng: ride.pickup_lng } : { lat: ride.dropoff_lat ?? ride.pickup_lat, lng: ride.dropoff_lng ?? ride.pickup_lng };
      speed = 14;
      const remaining = moveToward(s, target, speed * (STEP_MS / 1000) * 6);
      const next = (status: string) => asDriver(s!.userId, "select public.driver_update_ride_status($1, $2) as r", [ride.id, status]).catch(() => null);
      if (ride.status === "ACCEPTED") await next("DRIVER_EN_ROUTE");
      else if (ride.status === "DRIVER_EN_ROUTE" && remaining < 150) await next("DRIVER_ARRIVED");
      else if (ride.status === "DRIVER_ARRIVED" && Math.random() < 0.5) await next("PASSENGER_ONBOARD");
      else if (ride.status === "PASSENGER_ONBOARD") await next("IN_PROGRESS");
      else if (ride.status === "IN_PROGRESS" && remaining < 200) await next("COMPLETED");
    } else {
      // Maraude aléatoire autour de la position
      s.heading += (Math.random() - 0.5) * 50;
      const rad = (s.heading * Math.PI) / 180;
      const dist = speed * (STEP_MS / 1000);
      s.lat += (Math.cos(rad) * dist) / 111_320;
      s.lng += (Math.sin(rad) * dist) / (111_320 * Math.cos((s.lat * Math.PI) / 180));
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
    const delay = 3000 + Math.random() * 12000;
    setTimeout(async () => {
      const roll = Math.random();
      const fn = roll < 0.75 ? "accept_ride_offer" : roll < 0.85 ? "decline_ride_offer" : null;
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
] as const;

async function newRide(org: string) {
  const a = SPOTS[Math.floor(Math.random() * SPOTS.length)]!;
  let b = SPOTS[Math.floor(Math.random() * SPOTS.length)]!;
  if (b === a) b = SPOTS[(SPOTS.indexOf(a) + 3) % SPOTS.length]!;
  const { rows } = await pool.query(
    `insert into rides (organization_id, source, pickup_address, pickup_lat, pickup_lng, dropoff_address, dropoff_lat, dropoff_lng,
       customer_name, customer_phone, passengers, vehicle_category, price_cents)
     values ($1, 'api', $2, $3, $4, $5, $6, $7, 'Client simulé', '+33600000000', 1 + floor(random() * 3)::int,
       (array['business','business','standard'])[1 + floor(random() * 3)::int]::vehicle_category, (45 + floor(random() * 50)::int) * 100)
     returning number`,
    [org, a[0], a[1], a[2], b[0], b[1], b[2]],
  );
  log("info", "course simulée créée", { number: rows[0]?.number });
}

async function main() {
  const org = await orgId();
  log("info", "simulateur démarré", { org, stepMs: STEP_MS, newRideEvery: NEW_RIDE_EVERY_S || "off" });
  setInterval(() => step(org).catch((e) => log("error", "step failed", { error: (e as Error).message })), STEP_MS);
  if (NEW_RIDE_EVERY_S > 0) setInterval(() => newRide(org).catch((e) => log("error", "new ride failed", { error: (e as Error).message })), NEW_RIDE_EVERY_S * 1000);
}

void main();
