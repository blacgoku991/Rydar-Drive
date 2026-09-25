import type { ExpoPushMessage, ExpoPushReceipt, ExpoPushTicket } from "expo-server-sdk";
import { describe, expect, it, vi } from "vitest";
import { apnsPayload } from "./apns";
import { expoProvider, expoReceiptTracker, type ExpoClient } from "./expo";
import { fcmFailure, fcmMessage } from "./fcm";
import { presentation, type PushPayload } from "./types";

const NOW = Date.parse("2026-09-25T10:00:00Z");
const rideOffer: PushPayload = {
  title: "NOUVELLE COURSE",
  body: "Opéra → Orly · 1,2 km du client · 48,00 €",
  type: "ride_offer",
  data: { offer_id: "o1", ride_id: "r1", price_cents: 4800, expires_at: "2026-09-25T10:00:30+00:00", notification_id: "n1" },
  priority: "high",
};

/** Faux client Expo : tickets et accusés pilotés par le test, découpage en lots de 2. */
function fakeExpo(opts: { tickets?: (m: ExpoPushMessage[]) => ExpoPushTicket[]; receipts?: Record<string, ExpoPushReceipt> } = {}) {
  const receipts: Record<string, ExpoPushReceipt> = { ...opts.receipts };
  const client = {
    chunkPushNotifications: vi.fn((m: ExpoPushMessage[]) => (m.length ? [m] : [])),
    sendPushNotificationsAsync: vi.fn(async (m: ExpoPushMessage[]) => opts.tickets?.(m) ?? m.map((_, i) => ({ status: "ok" as const, id: `t${i}` }))),
    chunkPushNotificationReceiptIds: vi.fn((ids: string[]) => {
      const out: string[][] = [];
      for (let i = 0; i < ids.length; i += 2) out.push(ids.slice(i, i + 2));
      return out;
    }),
    getPushNotificationReceiptsAsync: vi.fn(async (ids: string[]) => Object.fromEntries(ids.filter((id) => receipts[id]).map((id) => [id, receipts[id]!]))),
  };
  return { client: client as unknown as ExpoClient & typeof client, receipts };
}

function tracker(client: ExpoClient, opts: Parameters<typeof expoReceiptTracker>[2] = {}) {
  const actions = { deactivateTokens: vi.fn(async () => undefined), failNotification: vi.fn(async () => undefined) };
  return { t: expoReceiptTracker(client, actions, { firstCheckMs: 15_000, retryMs: 30_000, giveUpMs: 300_000, ...opts }), actions };
}

const notRegistered: ExpoPushReceipt = { status: "error", message: "\"ExponentPushToken[a]\" is not a registered push notification recipient", details: { error: "DeviceNotRegistered" } };

describe("push Expo — envoi", () => {
  it("ticket ok : receiptId conservé pour l'accusé ; ticket DeviceNotRegistered : jeton invalide", async () => {
    const { client } = fakeExpo({
      tickets: (m) => m.map((x, i) => (i === 0 ? { status: "ok", id: "rcpt-1" } : { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } })),
    });
    const res = await expoProvider(client).send(
      [
        { token: "ExponentPushToken[a]", provider: "expo", platform: "android" },
        { token: "ExponentPushToken[b]", provider: "expo", platform: "ios" },
        { token: "pas-un-jeton-expo", provider: "expo", platform: "ios" },
      ],
      rideOffer,
    );
    expect(res).toContainEqual({ token: "ExponentPushToken[a]", ok: true, messageId: "rcpt-1", receiptId: "rcpt-1" });
    expect(res).toContainEqual(expect.objectContaining({ token: "ExponentPushToken[b]", ok: false, invalid: true }));
    expect(res).toContainEqual(expect.objectContaining({ token: "pas-un-jeton-expo", ok: false, invalid: true }));
    const msg = client.sendPushNotificationsAsync.mock.calls[0]![0][0]!;
    expect(msg).toMatchObject({ channelId: "ride-offers-v2", categoryId: "ride_offer", sound: { name: "ride_offer_v2.wav" }, priority: "high" });
    expect(msg.ttl).toBeGreaterThanOrEqual(1);
    expect(msg.ttl).toBeLessThanOrEqual(600);
    expect(msg.data).toMatchObject({ type: "ride_offer", offer_id: "o1", notification_id: "n1" });
  });
});

describe("push Expo — accusés de réception", () => {
  it("rien avant ~15 s, puis DeviceNotRegistered → jeton désactivé + notification en échec", async () => {
    const { client } = fakeExpo({ receipts: { r1: notRegistered } });
    const { t, actions } = tracker(client);
    t.track("n1", [{ token: "ExponentPushToken[a]", id: "r1" }], {}, NOW);

    expect(await t.poll(NOW + 5_000)).toMatchObject({ checked: 0 });
    expect(client.getPushNotificationReceiptsAsync).not.toHaveBeenCalled();

    expect(await t.poll(NOW + 16_000)).toMatchObject({ checked: 1, errors: 1, deactivated: 1, failed: 1 });
    expect(actions.deactivateTokens).toHaveBeenCalledWith(["ExponentPushToken[a]"], "DeviceNotRegistered");
    expect(actions.failNotification).toHaveBeenCalledWith("n1", expect.stringMatching(/^DeviceNotRegistered: /));
    expect(t.size()).toBe(0);
  });

  it("un appareil a reçu, l'autre non : jeton désactivé mais notification toujours « sent »", async () => {
    const { client } = fakeExpo({ receipts: { r1: notRegistered, r2: { status: "ok" } } });
    const { t, actions } = tracker(client);
    t.track("n1", [{ token: "ExponentPushToken[a]", id: "r1" }, { token: "ExponentPushToken[b]", id: "r2" }], {}, NOW);
    await t.poll(NOW + 20_000);
    expect(actions.deactivateTokens).toHaveBeenCalledWith(["ExponentPushToken[a]"], "DeviceNotRegistered");
    expect(actions.failNotification).not.toHaveBeenCalled();
  });

  it("toutes les erreurs (autre code que DeviceNotRegistered) → échec sans désactivation", async () => {
    const { client } = fakeExpo({
      receipts: {
        r1: { status: "error", message: "Unable to retrieve the FCM server key", details: { error: "InvalidCredentials" } },
        r2: { status: "error", message: "Unable to retrieve the FCM server key", details: { error: "InvalidCredentials" } },
      },
    });
    const { t, actions } = tracker(client);
    t.track("n1", [{ token: "ExponentPushToken[a]", id: "r1" }, { token: "ExponentPushToken[b]", id: "r2" }], {}, NOW);
    await t.poll(NOW + 20_000);
    expect(actions.deactivateTokens).not.toHaveBeenCalled();
    expect(actions.failNotification).toHaveBeenCalledTimes(1);
    expect(actions.failNotification).toHaveBeenCalledWith("n1", "InvalidCredentials: Unable to retrieve the FCM server key");
  });

  it("livrée aussi par FCM/APNs direct → jamais passée en échec", async () => {
    const { client } = fakeExpo({ receipts: { r1: notRegistered } });
    const { t, actions } = tracker(client);
    t.track("n1", [{ token: "ExponentPushToken[a]", id: "r1" }], { deliveredElsewhere: true }, NOW);
    await t.poll(NOW + 20_000);
    expect(actions.deactivateTokens).toHaveBeenCalled();
    expect(actions.failNotification).not.toHaveBeenCalled();
  });

  it("accusé pas encore prêt → nouvel essai, abandon après ~5 min sans échec", async () => {
    const { client, receipts } = fakeExpo();
    const { t, actions } = tracker(client);
    t.track("n1", [{ token: "ExponentPushToken[a]", id: "r1" }], {}, NOW);
    await t.poll(NOW + 16_000);
    expect(t.size()).toBe(1);
    await t.poll(NOW + 30_000); // pas encore dû (retry 30 s)
    expect(client.getPushNotificationReceiptsAsync).toHaveBeenCalledTimes(1);
    receipts.r1 = notRegistered;
    await t.poll(NOW + 47_000);
    expect(actions.failNotification).toHaveBeenCalledWith("n1", expect.stringContaining("DeviceNotRegistered"));

    t.track("n2", [{ token: "ExponentPushToken[b]", id: "r2" }], {}, NOW);
    for (let s = 16; s <= 330; s += 31) await t.poll(NOW + s * 1000);
    expect(t.size()).toBe(0);
    expect(actions.failNotification).toHaveBeenCalledTimes(1);
  });

  it("erreur réseau Expo → ré-essai plus tard", async () => {
    const { client } = fakeExpo({ receipts: { r1: notRegistered } });
    client.getPushNotificationReceiptsAsync.mockRejectedValueOnce(new Error("socket hang up"));
    const { t, actions } = tracker(client);
    t.track("n1", [{ token: "ExponentPushToken[a]", id: "r1" }], {}, NOW);
    await t.poll(NOW + 16_000);
    expect(actions.failNotification).not.toHaveBeenCalled();
    await t.poll(NOW + 46_000);
    expect(actions.failNotification).toHaveBeenCalledTimes(1);
  });

  it("interroge Expo par lots (chunkPushNotificationReceiptIds)", async () => {
    const { client } = fakeExpo({ receipts: { a: { status: "ok" }, b: { status: "ok" }, c: { status: "ok" } } });
    const { t } = tracker(client);
    t.track("n1", ["a", "b", "c"].map((id) => ({ token: `ExponentPushToken[${id}]`, id })), {}, NOW);
    expect(await t.poll(NOW + 16_000)).toMatchObject({ checked: 3, errors: 0 });
    expect(client.getPushNotificationReceiptsAsync).toHaveBeenCalledTimes(2);
  });

  it("mémoire bornée : les tickets les plus anciens sont oubliés (sans échec)", async () => {
    const { client } = fakeExpo({ receipts: { r3: notRegistered } });
    const { t, actions } = tracker(client, { maxTickets: 2 });
    t.track("n1", [{ token: "ExponentPushToken[a]", id: "r1" }], {}, NOW);
    t.track("n2", [{ token: "ExponentPushToken[b]", id: "r2" }], {}, NOW);
    t.track("n3", [{ token: "ExponentPushToken[c]", id: "r3" }], {}, NOW);
    expect(t.size()).toBe(2);
    await t.poll(NOW + 16_000);
    expect(client.getPushNotificationReceiptsAsync.mock.calls.flatMap((c) => c[0])).toEqual(["r2", "r3"]);
    expect(actions.failNotification).toHaveBeenCalledWith("n3", expect.any(String));
  });
});

describe("push FCM direct", () => {
  it("message data-only haute priorité au format expo-notifications", () => {
    const m = fcmMessage("fcm-token", rideOffer, NOW);
    expect(m).not.toHaveProperty("notification");
    // ouverte deux délais (prolongée puis fermée « ignorée ») : 2 × 30 s restantes
    expect(m.android).toEqual({ priority: "HIGH", ttl: "60s" });
    expect(Object.keys(m.data).sort()).toEqual(["body", "categoryId", "channelId", "message", "sound", "title"]);
    expect(m.data).toMatchObject({ title: "NOUVELLE COURSE", message: rideOffer.body, channelId: "ride-offers-v2", categoryId: "ride_offer", sound: "ride_offer_v2" });
    expect(Object.values(m.data).every((v) => typeof v === "string")).toBe(true);
    expect(JSON.parse(m.data.body!)).toEqual({ ...rideOffer.data, type: "ride_offer" });
    expect(JSON.stringify(m)).not.toContain("click_action");
  });

  it("notification non-offre : pas de catégorie, canal ride-updates", () => {
    const m = fcmMessage("fcm-token", { ...rideOffer, type: "ride_cancelled", data: { ride_id: "r1" }, priority: "normal" }, NOW);
    expect(m.data).not.toHaveProperty("categoryId");
    expect(m.data).toMatchObject({ channelId: "ride-updates", sound: "default" });
    // bloc notification : sinon expo-notifications ne montre rien au premier plan (message data-only)
    expect(m.notification).toEqual({ title: rideOffer.title, body: rideOffer.body });
    expect(m.android).toEqual({ priority: "NORMAL", ttl: "3600s", notification: { channel_id: "ride-updates", sound: "default" } });
  });

  it("offre planifiée : canal dédié et son court (pas la sonnerie 10 s des instantanées)", () => {
    const m = fcmMessage("fcm-token", { ...rideOffer, type: "ride_offer_scheduled", priority: "normal" }, NOW);
    expect(m).not.toHaveProperty("notification");
    expect(m.data).toMatchObject({ channelId: "ride-offers-scheduled", categoryId: "ride_offer", sound: "ride_offer" });
    expect(presentation({ ...rideOffer, type: "ride_offer_scheduled" }, NOW)).toMatchObject({ sound: "ride_offer.wav", interruptionLevel: "active" });
  });

  it("désactive le jeton seulement sur UNREGISTERED / NOT_FOUND", () => {
    const unregistered = fcmFailure("t", 404, {
      error: { status: "NOT_FOUND", message: "Requested entity was not found.", details: [{ "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", errorCode: "UNREGISTERED" }] },
    });
    expect(unregistered).toMatchObject({ ok: false, invalid: true, retryable: false });
    expect(unregistered.error).toContain("UNREGISTERED");

    const badRequest = fcmFailure("t", 400, {
      error: { status: "INVALID_ARGUMENT", message: "Invalid value at 'message.data[0].value'", details: [{ "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", errorCode: "INVALID_ARGUMENT" }] },
    });
    expect(badRequest).toMatchObject({ ok: false, invalid: false, retryable: false });

    expect(fcmFailure("t", 503, { error: { status: "UNAVAILABLE" } })).toMatchObject({ invalid: false, retryable: true });
    expect(fcmFailure("t", 429, {})).toMatchObject({ invalid: false, retryable: true, error: "HTTP_429: " });
  });
});

describe("push APNs direct", () => {
  it("données sous « body » (userInfo.body lu par expo-notifications), présentation dans aps", () => {
    const p = apnsPayload(rideOffer, NOW);
    expect(p.aps).toEqual({
      alert: { title: rideOffer.title, body: rideOffer.body },
      sound: "ride_offer_v2.wav",
      category: "ride_offer",
      "interruption-level": "time-sensitive",
      "thread-id": "r1",
    });
    expect(p.body).toEqual({ ...rideOffer.data, type: "ride_offer" });
    expect(p).not.toHaveProperty("offer_id");
    expect(Object.keys(p).sort()).toEqual(["aps", "body"]);
  });

  it("offre planifiée : boutons ACCEPTER / Refuser, niveau « active »", () => {
    const p = apnsPayload({ ...rideOffer, type: "ride_offer_scheduled" }, NOW);
    expect(p.aps).toMatchObject({ category: "ride_offer", sound: "ride_offer.wav", "interruption-level": "active" });
  });
});
