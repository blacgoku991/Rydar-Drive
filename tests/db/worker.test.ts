import { afterAll, describe, expect, it } from "vitest";
import { as, CHAMPS_ELYSEES, createDriver, createOrg, createRideAsOwner, expectPgError, north, pool, rideState, sql } from "./helpers";

afterAll(async () => {
  await pool.end();
});

/** Réservation comme le worker (service_role → fonctions private.*). */
const claim = (limit = 1000) => sql("select * from private.claim_notifications($1)", [limit]);
const complete = (id: string, ok: boolean, error: string | null = null, retryable = true) =>
  sql("select private.complete_notification($1, $2, $3, 'fcm', $4, $5)", [id, ok, error, ok ? "msg-1" : null, retryable]);
const notif = async (id: string) => (await sql("select * from public.notifications where id = $1", [id]))[0];

describe("File de notifications du worker", () => {
  it("réserve une offre due une seule fois, avec les seuls jetons push actifs du chauffeur", async () => {
    const org = await createOrg("Notif Claim");
    const d = await createDriver(org, { at: north(CHAMPS_ELYSEES, 600) });
    await sql(
      `insert into public.push_tokens (organization_id, driver_id, token, provider, platform, is_active)
       values ($1, $2, $3, 'expo', 'ios', true), ($1, $2, $4, 'fcm', 'android', false)`,
      [org.id, d.id, `active-${d.id}`, `revoked-${d.id}`],
    );
    const ride = await createRideAsOwner(org);

    const mine = (await claim()).filter((n) => n.ride_id === ride.id);
    expect(mine).toHaveLength(1);
    expect(mine[0].type).toBe("ride_offer");
    expect(mine[0].attempts).toBe(1);
    expect(mine[0].tokens).toEqual([{ token: `active-${d.id}`, provider: "expo", platform: "ios" }]);
    expect((await notif(mine[0].id)).status).toBe("sending");

    // Déjà réservée : un second worker ne la reprend pas
    expect((await claim()).find((n) => n.id === mine[0].id)).toBeUndefined();
  });

  it("annule, sans l'envoyer, la notification d'une offre déjà fermée (course prise par un autre)", async () => {
    const org = await createOrg("Notif Stale");
    const fast = await createDriver(org, { at: north(CHAMPS_ELYSEES, 400) });
    const slow = await createDriver(org, { at: north(CHAMPS_ELYSEES, 1500) });
    const ride = await createRideAsOwner(org);
    const { offers } = await rideState(ride.id);
    const fastOffer = offers.find((o) => o.driver_id === fast.id)!;

    const [res] = await as({ sub: fast.userId }, (q) => q("select public.accept_ride_offer($1) as r", [fastOffer.id]));
    expect(res.r.ok).toBe(true);

    // L'acceptation annule elle-même les pushs encore en file : rien ne part
    const claimed = (await claim()).filter((n) => n.ride_id === ride.id && n.type === "ride_offer");
    expect(claimed).toHaveLength(0);
    const rows = await sql("select status from public.notifications where ride_id = $1 and type = 'ride_offer'", [ride.id]);
    expect(rows.map((r) => r.status)).toEqual(["cancelled", "cancelled"]);
  });

  it("filet de sécurité : une offre fermée par un autre chemin n'est jamais envoyée", async () => {
    const org = await createOrg("Notif Closed");
    const d = await createDriver(org, { at: north(CHAMPS_ELYSEES, 400) });
    const ride = await createRideAsOwner(org);
    const { offers } = await rideState(ride.id);
    // Offre expirée hors du chemin normal (la notification reste en file)
    await sql("update public.ride_offers set status = 'expired', responded_at = now() where id = $1", [offers[0].id]);

    expect((await claim()).filter((n) => n.ride_id === ride.id)).toHaveLength(0);
    const [row] = await sql("select status, last_error from public.notifications where offer_id = $1", [offers[0].id]);
    expect(row).toEqual({ status: "cancelled", last_error: "offer_closed" });
    expect(d.id).toBe(offers[0].driver_id);
  });

  it("ne réserve pas une notification planifiée dans le futur (rappel)", async () => {
    const org = await createOrg("Notif Future");
    const d = await createDriver(org);
    const [{ id }] = await sql(
      "select private.queue_notification($1, $2, null, null, 'ride_reminder', 'Rappel', 'Dans 1 h', '{}'::jsonb, 'high', now() + interval '1 hour') as id",
      [org.id, d.id],
    );
    expect((await claim()).find((n) => n.id === id)).toBeUndefined();
    expect((await notif(id)).status).toBe("queued");
  });

  it("finalise : succès, ré-essai avec backoff, puis échec (2 tentatives max pour une offre)", async () => {
    const org = await createOrg("Notif Retry");
    const d = await createDriver(org);
    const queue = async (type: string) =>
      (await sql("select private.queue_notification($1, $2, null, null, $3, 'T', 'B') as id", [org.id, d.id, type]))[0].id as string;

    // Succès
    const okId = await queue("ride_assigned");
    expect((await claim()).some((n) => n.id === okId)).toBe(true);
    await complete(okId, true);
    const sent = await notif(okId);
    expect(sent.status).toBe("sent");
    expect(sent.sent_at).not.toBeNull();
    expect(sent.provider).toBe("fcm");
    expect(sent.provider_message_id).toBe("msg-1");

    // Offre : 1er échec → remise en file avec backoff (5 × 2^1 = 10 s)
    const offerId = await queue("ride_offer");
    await claim();
    await complete(offerId, false, "timeout");
    const retry = await notif(offerId);
    expect(retry.status).toBe("queued");
    expect(retry.last_error).toBe("timeout");
    const delay = (new Date(retry.scheduled_for).getTime() - Date.now()) / 1000;
    expect(delay).toBeGreaterThan(5);
    expect(delay).toBeLessThanOrEqual(11);
    expect((await claim()).find((n) => n.id === offerId)).toBeUndefined(); // pas encore due

    // 2e tentative → échec définitif
    await sql("update public.notifications set scheduled_for = now() where id = $1", [offerId]);
    expect((await claim()).find((n) => n.id === offerId)?.attempts).toBe(2);
    await complete(offerId, false, "timeout");
    expect((await notif(offerId)).status).toBe("failed");

    // Erreur non ré-essayable (jeton invalide) → échec immédiat, même pour un rappel
    const deadId = await queue("ride_reminder");
    await claim();
    await complete(deadId, false, "DeviceNotRegistered", false);
    const dead = await notif(deadId);
    expect(dead.status).toBe("failed");
    expect(dead.attempts).toBe(1);
  });

  it("désactive uniquement les jetons push signalés invalides", async () => {
    const org = await createOrg("Notif Tokens");
    const d = await createDriver(org);
    const t = (s: string) => `${s}-${d.id}`;
    await sql(
      `insert into public.push_tokens (organization_id, driver_id, token, provider, platform)
       values ($1, $2, $3, 'expo', 'ios'), ($1, $2, $4, 'fcm', 'android')`,
      [org.id, d.id, t("dead"), t("alive")],
    );
    const [{ n }] = await sql("select private.deactivate_push_tokens($1, 'DeviceNotRegistered') as n", [[t("dead"), "inconnu"]]);
    expect(n).toBe(1);
    const rows = await sql("select token, is_active, last_error from public.push_tokens where driver_id = $1 order by token", [d.id]);
    expect(rows).toEqual([
      { token: t("alive"), is_active: true, last_error: null },
      { token: t("dead"), is_active: false, last_error: "DeviceNotRegistered" },
    ]);
    // Idempotent
    const [{ n: again }] = await sql("select private.deactivate_push_tokens($1, 'x') as n", [[t("dead")]]);
    expect(again).toBe(0);
  });

  it("n'expose pas ces fonctions aux clients (rattacheur ou chauffeur)", async () => {
    const org = await createOrg("Notif Guard");
    const d = await createDriver(org);
    for (const sub of [org.ownerId, d.userId]) {
      const err = await expectPgError(as({ sub }, (q) => q("select * from private.claim_notifications(10)")));
      expect(err.code).toBe("42501");
    }
    const err = await expectPgError(as({ role: "anon" }, (q) => q("select private.deactivate_push_tokens(array['x'], 'x')")));
    expect(err.code).toBe("42501");
  });
});
