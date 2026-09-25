import { describe, expect, it } from "vitest";
import { summarize } from "./notifications";
import { offerTtlSeconds, presentation, stringifyData, type PushPayload } from "./push/types";

const offer = (type: string, data: Record<string, unknown> = {}): PushPayload => ({ title: "t", body: "b", type, data, priority: "high" });

describe("worker — agrégation des envois", () => {
  it("succès si au moins un appareil reçoit", () => {
    const s = summarize([{ token: "a", ok: false, error: "x", invalid: true }, { token: "b", ok: true, messageId: "m1" }]);
    expect(s).toMatchObject({ ok: true, messageId: "m1", invalid: ["a"], retryable: false });
  });
  it("ré-essai seulement si une erreur est temporaire", () => {
    expect(summarize([{ token: "a", ok: false, error: "503", retryable: true }]).retryable).toBe(true);
    expect(summarize([{ token: "a", ok: false, error: "DeviceNotRegistered", invalid: true }]).retryable).toBe(false);
  });
  it("garde tous les tickets Expo à vérifier (pas seulement le premier)", () => {
    const s = summarize([
      { token: "a", ok: true, messageId: "t1", receiptId: "t1" },
      { token: "b", ok: false, error: "x" },
      { token: "c", ok: true, messageId: "t2", receiptId: "t2" },
    ]);
    expect(s.messageId).toBe("t1,t2");
    expect(s.receipts).toEqual([{ token: "a", id: "t1" }, { token: "c", id: "t2" }]);
    expect(s.deliveredElsewhere).toBe(false);
    // Un envoi FCM/APNs direct réussi (sans accusé) empêche de passer la notification en échec
    expect(summarize([{ token: "a", ok: true, receiptId: "t1" }, { token: "f", ok: true, messageId: "projects/x/messages/1" }]).deliveredElsewhere).toBe(true);
  });
});

describe("worker — présentation des notifications", () => {
  it("offre : sonnerie et canal v2, action ACCEPTER, time-sensitive", () => {
    const p = presentation(offer("ride_offer"));
    expect(p).toMatchObject({
      sound: "ride_offer_v2.wav",
      androidSound: "ride_offer_v2",
      channelId: "ride-offers-v2",
      categoryId: "ride_offer",
      interruptionLevel: "time-sensitive",
    });
    expect(stringifyData({ a: 1, b: "x", c: { d: true } })).toEqual({ a: "1", b: "x", c: '{"d":true}' });
  });
  it("offre planifiée : canal dédié, son court, boutons ACCEPTER / Refuser, sans percer la Concentration", () => {
    const p = presentation(offer("ride_offer_scheduled"));
    expect(p).toMatchObject({
      sound: "ride_offer.wav",
      androidSound: "ride_offer",
      channelId: "ride-offers-scheduled",
      categoryId: "ride_offer",
      interruptionLevel: "active",
      ttlSeconds: 3600,
    });
  });
  it("autres types : canal ride-updates / default, pas de catégorie", () => {
    expect(presentation(offer("ride_cancelled"))).toMatchObject({ sound: "default", channelId: "ride-updates", categoryId: undefined, interruptionLevel: "time-sensitive", ttlSeconds: 3600 });
    expect(presentation(offer("ride_reminder"))).toMatchObject({ sound: "default", channelId: "default", categoryId: undefined, interruptionLevel: "active", ttlSeconds: 3600 });
  });
});

describe("worker — durée de vie push d'une offre", () => {
  const now = Date.parse("2026-09-25T10:00:00Z");
  it("jusqu'à expires_at (arrondi au-dessus)", () => {
    expect(offerTtlSeconds("2026-09-25T10:00:30+00:00", now)).toBe(30);
    expect(offerTtlSeconds("2026-09-25T10:00:29.200123+00:00", now)).toBe(30);
    // instantanée : ouverte deux délais (prolongée puis « ignorée ») → 2 × temps restant, 600 s max
    expect(presentation(offer("ride_offer", { expires_at: "2026-09-25T10:00:45Z" }), now).ttlSeconds).toBe(90);
    expect(presentation(offer("ride_offer", { expires_at: "2026-09-25T10:08:00Z" }), now).ttlSeconds).toBe(600);
  });
  it("bornée à [1 s, 600 s]", () => {
    expect(offerTtlSeconds("2026-09-25T09:59:00Z", now)).toBe(1);
    expect(offerTtlSeconds("2026-09-25T10:00:00Z", now)).toBe(1);
    expect(offerTtlSeconds("2026-09-25T10:30:00Z", now)).toBe(600);
  });
  it("offre planifiée : jusqu'à expires_at, 1 h max ; autres types : 1 h", () => {
    expect(presentation(offer("ride_offer_scheduled", { expires_at: "2026-09-25T10:20:00Z" }), now).ttlSeconds).toBe(1200);
    expect(presentation(offer("ride_offer_scheduled", { expires_at: "2026-09-25T13:00:00Z" }), now).ttlSeconds).toBe(3600);
    expect(presentation(offer("ride_assigned", { expires_at: "2026-09-25T10:00:30Z" }), now).ttlSeconds).toBe(3600);
  });
  it("60 s si expires_at absent ou illisible", () => {
    expect(offerTtlSeconds(undefined, now)).toBe(60);
    expect(offerTtlSeconds("pas une date", now)).toBe(60);
    expect(offerTtlSeconds({}, now)).toBe(60);
    expect(presentation(offer("ride_offer"), now).ttlSeconds).toBe(60);
  });
});
