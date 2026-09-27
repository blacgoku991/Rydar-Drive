import { afterAll, describe, expect, it } from "vitest";
import { as, CHAMPS_ELYSEES, createDriver, createOrg, createRideAsOwner, north, pool, rideState, sql } from "./helpers";

afterAll(async () => {
  await pool.end();
});

const svcDelete = async (userId: string) =>
  (await as({ role: "service_role" }, (q) => q("select public.svc_delete_driver_account($1) as r", [userId])))[0].r;

describe("Suppression du compte chauffeur (migration 003500)", () => {
  it("supprime les données personnelles, anonymise la fiche, garde courses et règlements sans identité", async () => {
    const org = await createOrg("Suppression");
    const d = await createDriver(org, { firstName: "Karim", at: north(CHAMPS_ELYSEES, 800) });
    // Course passée (terminée) et données personnelles diverses
    const ride = await createRideAsOwner(org);
    await sql("update public.rides set status = 'COMPLETED', driver_id = $2, completed_at = now() where id = $1", [ride.id, d.id]);
    await sql("update public.drivers set presence = 'available', current_ride_id = null, email = 'karim@test.dev', vtc_card_number = 'VTC123' where id = $1", [d.id]);
    await sql(
      `insert into public.driver_documents (organization_id, driver_id, type, file_path, status) values ($1, $2, 'vtc_card', $3, 'valid')`,
      [org.id, d.id, `${org.id}/${d.id}/vtc_card-1.jpg`],
    );
    await sql(
      `insert into public.driver_devices (organization_id, driver_id, installation_id, platform, app_version) values ($1, $2, 'inst-del', 'ios', '1.1.0')`,
      [org.id, d.id],
    );
    await sql(
      `insert into public.chat_messages (organization_id, channel, driver_id, author_type, author_driver_id, author_name, body)
       values ($1, 'driver', $2, 'driver', $2, 'Karim T.', 'Bonjour')`,
      [org.id, d.id],
    );

    const r = await svcDelete(d.userId);
    expect(r).toMatchObject({ ok: true, code: "DELETED", files: [`${org.id}/${d.id}/vtc_card-1.jpg`] });

    const [row] = await sql(
      "select first_name, last_name, phone, email, vtc_card_number, status, presence, deleted_at is not null as deleted from public.drivers where id = $1",
      [d.id],
    );
    expect(row).toEqual({ first_name: "Chauffeur", last_name: "supprimé", phone: "", email: null, vtc_card_number: null, status: "inactive", presence: "offline", deleted: true });
    for (const t of ["driver_documents", "driver_devices", "driver_locations", "push_tokens", "chat_messages"]) {
      const [c] = await sql(`select count(*)::int as n from public.${t} where driver_id = $1`, [d.id]);
      expect(c.n, t).toBe(0);
    }
    // La course passée reste (comptabilité), rattachée à la fiche anonymisée
    expect((await rideState(ride.id)).ride.driver_id).toBe(d.id);
    // Journal d'audit caviardé, suppression tracée
    const logs = await sql("select action, metadata from public.audit_logs where entity_type = 'drivers' and entity_id = $1", [d.id]);
    expect(logs.some((l) => l.action === "driver.deleted")).toBe(true);
    expect(JSON.stringify(logs)).not.toContain("Karim");
    // Rejouée (route relancée) : sans effet
    expect(await svcDelete(d.userId)).toMatchObject({ ok: true, code: "DELETED" });
  });

  it("refusée tant qu'une course est attribuée", async () => {
    const org = await createOrg("Suppression en course");
    const d = await createDriver(org, { at: north(CHAMPS_ELYSEES, 800) });
    const ride = await createRideAsOwner(org);
    const offer = (await rideState(ride.id)).offers[0];
    const [acc] = await as({ sub: d.userId }, (q) => q("select public.accept_ride_offer($1) as r", [offer.id]));
    expect(acc.r.code).toBe("ACCEPTED");
    const r = await svcDelete(d.userId);
    expect(r).toMatchObject({ ok: false, code: "RIDES_ASSIGNED", count: 1 });
    expect(r.message).toContain("terminez-la");
    const [row] = await sql("select deleted_at from public.drivers where id = $1", [d.id]);
    expect(row.deleted_at).toBeNull();
  });

  it("réservée au service : ni un chauffeur ni un membre ne peuvent l'appeler directement ; compte sans fiche : NOT_DRIVER", async () => {
    const org = await createOrg("Suppression droits");
    const d = await createDriver(org, { at: north(CHAMPS_ELYSEES, 800) });
    await expect(as({ sub: d.userId }, (q) => q("select public.svc_delete_driver_account($1)", [d.userId]))).rejects.toThrow(/permission denied/);
    expect(await svcDelete(org.ownerId)).toMatchObject({ ok: false, code: "NOT_DRIVER" });
  });
});
