import type { ExpoPushMessage, ExpoPushReceipt, ExpoPushTicket } from "expo-server-sdk";
import { describe, expect, it, vi } from "vitest";
import { expoProvider, expoReceiptTracker, maskPushToken, redactPushTokens, type ExpoClient } from "./expo";
import type { PushPayload } from "./types";

const TOKEN = "ExponentPushToken[AbCdEfGhIjKlMnOpQrStUv]";
const SECRET = "GhIjKlMnOpQrStUv"; // partie du jeton qui ne doit jamais sortir
const payload: PushPayload = { title: "Test", body: "Corps", type: "chat_message", data: {}, priority: "normal" };

function client(opts: { tickets?: (m: ExpoPushMessage[]) => ExpoPushTicket[]; throws?: Error; receipts?: Record<string, ExpoPushReceipt> }) {
  return {
    chunkPushNotifications: vi.fn((m: ExpoPushMessage[]) => (m.length ? [m] : [])),
    sendPushNotificationsAsync: vi.fn(async (m: ExpoPushMessage[]) => {
      if (opts.throws) throw opts.throws;
      return opts.tickets!(m);
    }),
    chunkPushNotificationReceiptIds: vi.fn((ids: string[]) => [ids]),
    getPushNotificationReceiptsAsync: vi.fn(async () => opts.receipts ?? {}),
  } as unknown as ExpoClient;
}

describe("push Expo — jetons masqués dans les erreurs", () => {
  it("maskPushToken : 6 premiers caractères + …", () => {
    expect(maskPushToken(TOKEN)).toBe("ExponentPushToken[AbCdEf…]");
    expect(maskPushToken("ExpoPushToken[xyz]")).toBe("ExpoPushToken[xyz…]");
    expect(maskPushToken("fcm-registration-token-123456")).toBe("fcm-re…");
  });

  it("redactPushTokens : tout ExponentPushToken[…] et les jetons connus", () => {
    expect(redactPushTokens(`"${TOKEN}" is not a registered push notification recipient`)).toBe(
      "\"ExponentPushToken[AbCdEf…]\" is not a registered push notification recipient",
    );
    expect(redactPushTokens("bad token raw-device-token-0123456789", ["raw-device-token-0123456789"])).toBe("bad token raw-de…");
    expect(redactPushTokens("sans jeton")).toBe("sans jeton");
  });

  it("ticket en erreur : le message conservé (last_error) ne contient pas le jeton complet", async () => {
    const c = client({
      tickets: (m) => m.map(() => ({ status: "error", message: `"${TOKEN}" is not a registered push notification recipient`, details: { error: "DeviceNotRegistered" } })),
    });
    const [r] = await expoProvider(c).send([{ token: TOKEN, provider: "expo", platform: "android" }], payload);
    expect(r).toMatchObject({ token: TOKEN, ok: false, invalid: true }); // le jeton reste disponible pour la désactivation
    expect(r!.error).toMatch(/^DeviceNotRegistered: /);
    expect(r!.error).toContain("ExponentPushToken[AbCdEf…]");
    expect(r!.error).not.toContain(SECRET);
  });

  it("exception d'envoi : message masqué", async () => {
    const c = client({ throws: new Error(`Request failed for ${TOKEN}`) });
    const [r] = await expoProvider(c).send([{ token: TOKEN, provider: "expo", platform: "ios" }], payload);
    expect(r).toMatchObject({ ok: false, retryable: true });
    expect(r!.error).not.toContain(SECRET);
  });

  it("accusé en erreur : ni failNotification ni le journal ne reçoivent le jeton complet", async () => {
    const c = client({
      receipts: { r1: { status: "error", message: `"${TOKEN}" is not a registered push notification recipient`, details: { error: "DeviceNotRegistered" } } },
    });
    const actions = { deactivateTokens: vi.fn(async () => undefined), failNotification: vi.fn(async () => undefined), log: vi.fn() };
    const t = expoReceiptTracker(c, actions, { firstCheckMs: 0 });
    t.track("n1", [{ token: TOKEN, id: "r1" }], {}, 0);
    await t.poll(1);
    expect(actions.deactivateTokens).toHaveBeenCalledWith([TOKEN], "DeviceNotRegistered");
    expect(actions.failNotification).toHaveBeenCalledWith("n1", expect.stringContaining("ExponentPushToken[AbCdEf…]"));
    expect(JSON.stringify(actions.failNotification.mock.calls)).not.toContain(SECRET);
    expect(JSON.stringify(actions.log.mock.calls)).not.toContain(SECRET);
  });
});
