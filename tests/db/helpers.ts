import { randomUUID } from "node:crypto";
import pg from "pg";

export const DB_URL = process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/rydar_test";

export const pool = new pg.Pool({ connectionString: DB_URL, max: 30 });

export type PgError = Error & { code?: string };

/** Requête en superutilisateur (bypass RLS) — fixtures uniquement. */
export async function sql<T extends pg.QueryResultRow = any>(text: string, params: unknown[] = []) {
  const res = await pool.query<T>(text, params);
  return res.rows;
}

/**
 * Exécute fn dans une transaction « comme Supabase » : rôle authenticated
 * (ou anon / service_role) + claims JWT. Les erreurs PG sont propagées.
 */
export async function as<T>(
  who: { sub?: string; role?: "authenticated" | "anon" | "service_role" },
  fn: (q: <R extends pg.QueryResultRow = any>(text: string, params?: unknown[]) => Promise<R[]>) => Promise<T>,
  opts: { topic?: string } = {},
): Promise<T> {
  const client = await pool.connect();
  const role = who.role ?? "authenticated";
  try {
    await client.query("begin");
    await client.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: who.sub ?? null, role }),
    ]);
    if (opts.topic) await client.query("select set_config('realtime.topic', $1, true)", [opts.topic]);
    await client.query(`set local role ${role}`);
    const result = await fn(async (text, params = []) => (await client.query(text, params)).rows);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function expectPgError(promise: Promise<unknown>): Promise<PgError> {
  try {
    await promise;
  } catch (error) {
    return error as PgError;
  }
  throw new Error("Une erreur PostgreSQL était attendue");
}

export async function createAuthUser(email: string, fullName: string): Promise<string> {
  const id = randomUUID();
  await sql(
    `insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, raw_user_meta_data)
     values ($1, 'authenticated', 'authenticated', $2, 'x', now(), jsonb_build_object('full_name', $3::text))`,
    [id, email, fullName],
  );
  return id;
}

let planId: string | undefined;
export async function unlimitedPlan(): Promise<string> {
  if (planId) return planId;
  const rows = await sql(
    `insert into public.plans (code, name, limits) values ('test_unlimited', 'Test', '{"api_access":true,"booking_site":true,"custom_domain":true,"advanced_stats":true}')
     on conflict (code) do update set name = excluded.name returning id`,
  );
  planId = rows[0].id;
  return planId!;
}

export type Org = { id: string; slug: string; ownerId: string };

export async function createOrg(name: string, opts: { plan?: string; settings?: Record<string, unknown> } = {}): Promise<Org> {
  const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${randomUUID().slice(0, 6)}`;
  const plan = opts.plan ?? (await unlimitedPlan());
  const [org] = await sql(`insert into public.organizations (name, slug, plan_id) values ($1, $2, $3) returning id`, [name, slug, plan]);
  const ownerId = await createAuthUser(`owner-${slug}@test.dev`, `Owner ${name}`);
  await sql(`insert into public.organization_users (organization_id, user_id, role) values ($1, $2, 'owner')`, [org.id, ownerId]);
  if (opts.settings && Object.keys(opts.settings).length) {
    const keys = Object.keys(opts.settings);
    const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
    await sql(`update public.organization_settings set ${sets} where organization_id = $1`, [org.id, ...Object.values(opts.settings)]);
  }
  return { id: org.id, slug, ownerId };
}

export type Driver = { id: string; userId: string; vehicleId: string; number: number };

export async function createDriver(
  org: Org,
  opts: {
    firstName?: string;
    category?: "standard" | "business" | "first" | "van" | "green";
    seats?: number;
    at?: [number, number];
    presence?: "offline" | "available" | "offered" | "en_route" | "arrived" | "on_trip";
    locationAgeSeconds?: number;
    status?: "active" | "inactive" | "suspended" | "invited";
  } = {},
): Promise<Driver> {
  const firstName = opts.firstName ?? `Chauffeur${randomUUID().slice(0, 4)}`;
  const userId = await createAuthUser(`${firstName.toLowerCase()}-${randomUUID().slice(0, 6)}@test.dev`, firstName);
  const [vehicle] = await sql(
    `insert into public.vehicles (organization_id, model, plate, category, seats) values ($1, 'Classe E', $2, $3, $4) returning id`,
    [org.id, `AA-${randomUUID().slice(0, 5)}`, opts.category ?? "business", opts.seats ?? 4],
  );
  const [driver] = await sql(
    `insert into public.drivers (organization_id, user_id, first_name, last_name, phone, status, presence, vehicle_id)
     values ($1, $2, $3, 'Test', '+33600000000', $4, $5, $6) returning id, number`,
    [org.id, userId, firstName, opts.status ?? "active", opts.presence ?? "available", vehicle.id],
  );
  if (opts.at) {
    const age = opts.locationAgeSeconds ?? 5;
    await sql(
      `insert into public.driver_locations (driver_id, organization_id, lat, lng, recorded_at, updated_at)
       values ($1, $2, $3, $4, now() - make_interval(secs => $5), now() - make_interval(secs => $5))`,
      [driver.id, org.id, opts.at[0], opts.at[1], age],
    );
  }
  return { id: driver.id, userId, vehicleId: vehicle.id, number: driver.number };
}

/** Point à ~d mètres au nord d'un point (approximation suffisante pour les tests). */
export function north(point: [number, number], meters: number): [number, number] {
  return [point[0] + meters / 111_320, point[1]];
}

export const CHAMPS_ELYSEES: [number, number] = [48.8698, 2.3075];
export const CDG: [number, number] = [49.0047, 2.571];

export async function createRideAsOwner(org: Org, overrides: Record<string, unknown> = {}) {
  const ride = {
    organization_id: org.id,
    pickup_address: "12 Avenue des Champs-Élysées, 75008 Paris",
    pickup_lat: CHAMPS_ELYSEES[0],
    pickup_lng: CHAMPS_ELYSEES[1],
    dropoff_address: "Aéroport Paris-Charles de Gaulle, Terminal 2E",
    dropoff_lat: CDG[0],
    dropoff_lng: CDG[1],
    customer_name: "Client Test",
    customer_phone: "+33611223344",
    passengers: 2,
    vehicle_category: "business",
    price_cents: 7200,
    ...overrides,
  };
  const cols = Object.keys(ride);
  const params = cols.map((_, i) => `$${i + 1}`).join(", ");
  const [row] = await as({ sub: org.ownerId }, (q) =>
    q(`insert into public.rides (${cols.join(", ")}) values (${params}) returning id, number, type`, Object.values(ride)),
  );
  return row as { id: string; number: number; type: string };
}

export async function rideState(rideId: string) {
  const [ride] = await sql(`select * from public.rides where id = $1`, [rideId]);
  const offers = await sql(`select * from public.ride_offers where ride_id = $1 order by sent_at, distance_m nulls last, driver_id`, [rideId]);
  const events = await sql(`select * from public.ride_events where ride_id = $1 order by id`, [rideId]);
  return { ride, offers, events };
}

/**
 * Insère une course « historique » (statut et horodatages libres) via le mode
 * import du seed : connexion directe + GUC rydar.bypass_ride_rules, sans JWT.
 */
export async function insertRideBypass(org: Org, fields: Record<string, unknown>) {
  const ride = {
    organization_id: org.id,
    type: "instant",
    status: "COMPLETED",
    source: "dashboard",
    pickup_address: "Place de l'Opéra, 75009 Paris",
    pickup_lat: 48.872,
    pickup_lng: 2.3316,
    dropoff_address: "Gare de Lyon, 75012 Paris",
    pickup_at: new Date(),
    customer_name: "Client Historique",
    customer_phone: "+33600000001",
    passengers: 1,
    vehicle_category: "business",
    price_cents: 5000,
    ...fields,
  };
  const cols = Object.keys(ride);
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('rydar.bypass_ride_rules', 'on', true)");
    const { rows } = await client.query(
      `insert into public.rides (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning id`,
      Object.values(ride),
    );
    await client.query("commit");
    return rows[0].id as string;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export const ago = (seconds: number) => new Date(Date.now() - seconds * 1000);

/** Membre supplémentaire d'une organisation (dispatcher, admin…). Renvoie l'id utilisateur. */
export async function createMember(org: Org, role: "owner" | "admin" | "dispatcher", name = `Membre ${role}`): Promise<string> {
  const userId = await createAuthUser(`${role}-${randomUUID().slice(0, 8)}@test.dev`, name);
  await sql(`insert into public.organization_users (organization_id, user_id, role) values ($1, $2, $3)`, [org.id, userId, role]);
  return userId;
}

/** Date ISO dans n minutes. */
export const inMinutes = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
