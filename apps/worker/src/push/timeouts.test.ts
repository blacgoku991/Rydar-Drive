import { createServer, type Http2Server, type ServerHttp2Session } from "node:http2";
import type { AddressInfo } from "node:net";
import { exportPKCS8, generateKeyPair } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sendWithTimeout, summarize } from "../notifications";
import { apnsProvider } from "./apns";
import { fcmProvider } from "./fcm";
import type { PushPayload, PushProvider, PushTarget } from "./types";

// Une requête push sans réponse (connexion morte, API muette) ne doit jamais bloquer la file des notifications.

const payload: PushPayload = { title: "t", body: "b", type: "ride_offer", data: { ride_id: "r1" }, priority: "high" };
const target = (token: string, provider: PushTarget["provider"]): PushTarget => ({ token, provider, platform: "ios" });

describe("push — envoi borné dans le temps (file des notifications)", () => {
  it("fournisseur muet : jetons en échec réessayable après le délai", async () => {
    const mute: PushProvider = { name: "expo", send: () => new Promise(() => undefined) };
    const started = Date.now();
    const results = await sendWithTimeout(mute, [target("a", "expo"), target("b", "expo")], payload, 50);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(results).toEqual([
      { token: "a", ok: false, error: "PUSH_TIMEOUT: expo (50 ms)", retryable: true },
      { token: "b", ok: false, error: "PUSH_TIMEOUT: expo (50 ms)", retryable: true },
    ]);
    expect(summarize(results)).toMatchObject({ ok: false, retryable: true });
  });
  it("réponse dans le délai : résultats inchangés ; erreur du fournisseur transmise", async () => {
    const ok: PushProvider = { name: "fcm", send: async (t) => t.map((x) => ({ token: x.token, ok: true, messageId: "m" })) };
    expect(await sendWithTimeout(ok, [target("a", "fcm")], payload, 1_000)).toEqual([{ token: "a", ok: true, messageId: "m" }]);
    const broken: PushProvider = { name: "fcm", send: async () => Promise.reject(new Error("boom")) };
    await expect(sendWithTimeout(broken, [target("a", "fcm")], payload, 1_000)).rejects.toThrow("boom");
  });
});

describe("push APNs direct — délai par requête", () => {
  let server: Http2Server | undefined;
  const sessions = new Set<ServerHttp2Session>();
  afterEach(async () => {
    for (const s of sessions) s.destroy();
    sessions.clear();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  /** Faux APNs en HTTP/2 clair : muet pour les jetons « mute », sinon 200 + apns-id. */
  async function fakeApns() {
    server = createServer();
    server.on("session", (s) => sessions.add(s));
    server.on("stream", (stream, headers) => {
      stream.on("error", () => undefined);
      if (String(headers[":path"]).endsWith("/mute")) return; // accepte le flux, ne répond jamais
      stream.respond({ ":status": 200, "apns-id": "id-1" });
      stream.end();
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  }

  async function provider(host: string) {
    const { privateKey } = await generateKeyPair("ES256", { extractable: true });
    return apnsProvider({ key: await exportPKCS8(privateKey), keyId: "KEY", teamId: "TEAM", bundleId: "app.test", production: false, host, timeoutMs: 150 });
  }

  it("APNs muet : échec réessayable APNS_TIMEOUT, puis nouvel envoi réussi sur une session neuve", async () => {
    const apns = await provider(await fakeApns());
    const [late] = await apns.send([target("mute", "apns")], payload);
    expect(late).toMatchObject({ token: "mute", ok: false, error: "APNS_TIMEOUT", retryable: true });
    expect(late!.invalid).toBe(false);
    const [ok] = await apns.send([target("good", "apns")], payload);
    expect(ok).toEqual({ token: "good", ok: true, messageId: "id-1" });
  });
});

describe("push FCM direct — délai par requête", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("FCM muet : échec réessayable au lieu d'une attente sans fin", async () => {
    const { privateKey } = await generateKeyPair("RS256", { extractable: true });
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url.includes("oauth2")) return Promise.resolve(new Response(JSON.stringify({ access_token: "at", expires_in: 3600 })));
      // Comme fetch : ne se termine qu'à l'abandon (signal), jamais sinon
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
    });
    vi.stubGlobal("fetch", fetchMock);
    const fcm = fcmProvider({ project_id: "p", client_email: "sa@p.iam", private_key: await exportPKCS8(privateKey) }, { timeoutMs: 100 });
    const [r] = await fcm.send([target("tok", "fcm")], payload);
    expect(r).toMatchObject({ token: "tok", ok: false, retryable: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) expect(call[1]?.signal).toBeInstanceOf(AbortSignal);
  });
});
