import { describe, expect, it } from "vitest";
import { summarize } from "./notifications";
import { presentation, stringifyData } from "./push/types";

describe("worker — agrégation des envois", () => {
  it("succès si au moins un appareil reçoit", () => {
    const s = summarize([{ token: "a", ok: false, error: "x", invalid: true }, { token: "b", ok: true, messageId: "m1" }]);
    expect(s).toMatchObject({ ok: true, messageId: "m1", invalid: ["a"], retryable: false });
  });
  it("ré-essai seulement si une erreur est temporaire", () => {
    expect(summarize([{ token: "a", ok: false, error: "503", retryable: true }]).retryable).toBe(true);
    expect(summarize([{ token: "a", ok: false, error: "DeviceNotRegistered", invalid: true }]).retryable).toBe(false);
  });
  it("offre : son dédié, canal ride-offers, action ACCEPTER", () => {
    const p = presentation({ title: "t", body: "b", type: "ride_offer", data: {}, priority: "high" });
    expect(p).toMatchObject({ sound: "ride_offer.wav", channelId: "ride-offers", categoryId: "ride_offer", interruptionLevel: "time-sensitive" });
    expect(stringifyData({ a: 1, b: "x", c: { d: true } })).toEqual({ a: "1", b: "x", c: '{"d":true}' });
  });
});
