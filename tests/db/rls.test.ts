import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  as, CHAMPS_ELYSEES, createDriver, createOrg, createRideAsOwner, expectPgError, north, pool, sql,
  type Driver, type Org,
} from "./helpers";

let A: Org;
let B: Org;
let driverA: Driver;
let driverB: Driver;
let rideA: { id: string };
let rideB: { id: string };

beforeAll(async () => {
  A = await createOrg("Rattacheur A");
  B = await createOrg("Rattacheur B");
  driverA = await createDriver(A, { firstName: "Mohamed", at: north(CHAMPS_ELYSEES, 800) });
  driverB = await createDriver(B, { firstName: "Bruno", at: north(CHAMPS_ELYSEES, 500) });
  rideA = await createRideAsOwner(A);
  rideB = await createRideAsOwner(B);
});

afterAll(async () => {
  await pool.end();
});

describe("Isolation multi-tenant (RLS)", () => {
  it("un rattacheur ne voit que ses propres courses", async () => {
    const rows = await as({ sub: A.ownerId }, (q) => q("select id, organization_id from public.rides"));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.organization_id === A.id)).toBe(true);
    expect(rows.find((r) => r.id === rideB.id)).toBeUndefined();
  });

  it("lecture directe d'une course d'un autre tenant : aucune ligne", async () => {
    const rows = await as({ sub: A.ownerId }, (q) => q("select * from public.rides where id = $1", [rideB.id]));
    expect(rows).toHaveLength(0);
  });

  it("modifier la course d'un autre tenant : aucune ligne affectée", async () => {
    const rows = await as({ sub: A.ownerId }, (q) =>
      q("update public.rides set comment = 'hack' where id = $1 returning id", [rideB.id]),
    );
    expect(rows).toHaveLength(0);
    const [b] = await sql("select comment from public.rides where id = $1", [rideB.id]);
    expect(b.comment).toBeNull();
  });

  it("changer organization_id d'une course → 42501 (403)", async () => {
    const err = await expectPgError(
      as({ sub: A.ownerId }, (q) => q("update public.rides set organization_id = $1 where id = $2", [B.id, rideA.id])),
    );
    expect(err.code).toBe("42501");
    const [a] = await sql("select organization_id from public.rides where id = $1", [rideA.id]);
    expect(a.organization_id).toBe(A.id);
  });

  it("même en superutilisateur, organization_id est immuable (trigger)", async () => {
    const err = await expectPgError(sql("update public.rides set organization_id = $1 where id = $2", [B.id, rideA.id]));
    expect(err.code).toBe("42501");
    expect(err.message).toContain("FORBIDDEN_TENANT_CHANGE");
  });

  it("créer une course dans l'organisation B depuis le compte A → 42501 (403)", async () => {
    const err = await expectPgError(createRideAsOwner({ ...A, id: B.id }));
    expect(err.code).toBe("42501");
  });

  it("annuler / attribuer une course d'un autre tenant via RPC → 42501", async () => {
    const e1 = await expectPgError(as({ sub: A.ownerId }, (q) => q("select public.cancel_ride($1, 'x')", [rideB.id])));
    expect(e1.code).toBe("42501");
    const e2 = await expectPgError(
      as({ sub: A.ownerId }, (q) => q("select public.assign_ride($1, $2)", [rideA.id, driverB.id])),
    );
    expect(e2.code).toBe("42501");
    const e3 = await expectPgError(as({ sub: A.ownerId }, (q) => q("select public.org_kpis($1)", [B.id])));
    expect(e3.code).toBe("42501");
  });

  it("un chauffeur ne voit que son propre profil, jamais la flotte B", async () => {
    const drivers = await as({ sub: driverA.userId }, (q) => q("select id, organization_id from public.drivers"));
    expect(drivers.map((d) => d.id)).toEqual([driverA.id]);
    const rides = await as({ sub: driverA.userId }, (q) => q("select id from public.rides"));
    expect(rides).toHaveLength(0);
    const locations = await as({ sub: driverA.userId }, (q) => q("select driver_id from public.driver_locations"));
    expect(locations.map((l) => l.driver_id)).toEqual([driverA.id]);
  });

  it("un chauffeur ne peut pas accepter l'offre d'un autre tenant", async () => {
    const offers = await sql("select id from public.ride_offers where driver_id = $1", [driverB.id]);
    expect(offers.length).toBeGreaterThan(0);
    const [res] = await as({ sub: driverA.userId }, (q) =>
      q("select public.accept_ride_offer($1) as r", [offers[0].id]),
    );
    expect(res.r.code).toBe("OFFER_NOT_FOUND");
  });

  it("anon n'a accès à aucune donnée métier", async () => {
    const err = await expectPgError(as({ role: "anon" }, (q) => q("select * from public.rides")));
    expect(err.code).toBe("42501");
  });

  it("les secrets de clés API sont illisibles côté client", async () => {
    const err = await expectPgError(as({ sub: A.ownerId }, (q) => q("select * from public.api_key_secrets")));
    expect(err.code).toBe("42501");
  });

  it("canaux temps réel : org:A autorisé, org:B refusé", async () => {
    const own = await as({ sub: A.ownerId }, (q) => q("select count(*)::int as n from realtime.messages"), {
      topic: `org:${A.id}`,
    });
    expect(own[0].n).toBeGreaterThan(0);
    const other = await as({ sub: A.ownerId }, (q) => q("select count(*)::int as n from realtime.messages"), {
      topic: `org:${B.id}`,
    });
    expect(other[0].n).toBe(0);
    const driverChannel = await as({ sub: driverA.userId }, (q) => q("select count(*)::int as n from realtime.messages"), {
      topic: `driver:${driverB.id}`,
    });
    expect(driverChannel[0].n).toBe(0);
  });

  it("organisation suspendue : plus aucun accès aux données", async () => {
    const C = await createOrg("Rattacheur C");
    await createRideAsOwner(C);
    await sql("update public.organizations set status = 'suspended' where id = $1", [C.id]);
    const rides = await as({ sub: C.ownerId }, (q) => q("select id from public.rides"));
    expect(rides).toHaveLength(0);
    const orgs = await as({ sub: C.ownerId }, (q) => q("select status from public.organizations"));
    expect(orgs).toEqual([{ status: "suspended" }]);
  });

  it("chauffeur suspendu : RPC refusées immédiatement (session révoquée côté données)", async () => {
    const d = await createDriver(A, { firstName: "Suspendu", at: north(CHAMPS_ELYSEES, 300) });
    await sql("update public.drivers set status = 'suspended' where id = $1", [d.id]);
    const err = await expectPgError(as({ sub: d.userId }, (q) => q("select public.driver_set_online(true)")));
    expect(err.code).toBe("42501");
  });
});
