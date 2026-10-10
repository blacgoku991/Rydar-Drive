import { describe, expect, it } from "vitest";
import { SITE_KEY_KIND_LABELS, originsLabel, siteHost, siteKeyActive, siteKeyKind, siteLink, type SiteKeyRow, type SiteWebhookRow } from "./site-status";

// « Mon site » de la Flotte Privée (docs/FLOTTE-PRIVEE.md § 7.3) : état du site relié par l'API v1, en lecture seule
// (clés et webhooks gérés par l'équipe Rydar, D16).

const NOW = Date.parse("2026-10-20T08:00:00Z");

const key = (over: Partial<SiteKeyRow> = {}): SiteKeyRow => ({
  id: "k-1",
  name: "Site",
  prefix: "rk_live_ab12",
  last4: "9f3c",
  scopes: ["rides:write", "quotes:read"],
  allowed_origins: null,
  created_at: "2026-10-01T10:00:00Z",
  last_used_at: null,
  expires_at: null,
  revoked_at: null,
  ...over,
});

const hook = (over: Partial<SiteWebhookRow> = {}): SiteWebhookRow => ({
  id: "w-1",
  url: "https://www.taxi-karim.fr/api/rydar",
  enabled: true,
  last_success_at: null,
  last_failure_at: null,
  ...over,
});

describe("clés du site", () => {
  it("navigateur (origines autorisées) ou serveur", () => {
    expect(siteKeyKind(key({ allowed_origins: ["https://taxi-karim.fr"] }))).toBe("browser");
    expect(siteKeyKind(key({ allowed_origins: [] }))).toBe("server");
    expect(siteKeyKind(key())).toBe("server");
    expect(SITE_KEY_KIND_LABELS).toEqual({ browser: "Clé navigateur", server: "Clé serveur" });
  });

  it("active : ni révoquée, ni expirée", () => {
    expect(siteKeyActive(key(), NOW)).toBe(true);
    expect(siteKeyActive(key({ expires_at: "2026-10-21T00:00:00Z" }), NOW)).toBe(true);
    expect(siteKeyActive(key({ expires_at: "2026-10-20T08:00:00Z" }), NOW)).toBe(false);
    expect(siteKeyActive(key({ revoked_at: "2026-10-19T00:00:00Z" }), NOW)).toBe(false);
  });

  it("nom du site : sans « www. » ; adresse illisible ou absente : aucun", () => {
    expect(siteHost("https://www.taxi-karim.fr/reserver")).toBe("taxi-karim.fr");
    expect(siteHost("https://reservation.taxi-karim.fr")).toBe("reservation.taxi-karim.fr");
    expect(siteHost("taxi-karim")).toBeNull();
    expect(siteHost(null)).toBeNull();
    expect(originsLabel(["https://taxi-karim.fr", "https://www.taxi-karim.fr"])).toBe("taxi-karim.fr, www.taxi-karim.fr");
    expect(originsLabel(null)).toBe("");
  });
});

describe("site relié", () => {
  it("aucune clé active : non relié, aucun nom (même avec un webhook)", () => {
    expect(siteLink([key({ revoked_at: "2026-10-19T00:00:00Z" })], [hook()], NOW)).toEqual({
      linked: false,
      host: null,
      activeKeys: [],
      lastUsedAt: null,
    });
    expect(siteLink([], [], NOW).linked).toBe(false);
  });

  it("clé navigateur : nom tiré de ses origines ; dernière utilisation la plus récente des clés actives", () => {
    const keys = [
      key({ id: "a", allowed_origins: ["https://www.taxi-karim.fr"], last_used_at: "2026-10-19T10:00:00Z" }),
      key({ id: "b", last_used_at: "2026-10-20T07:00:00Z" }),
      key({ id: "c", revoked_at: "2026-10-18T00:00:00Z", last_used_at: "2026-10-20T07:59:00Z" }),
    ];
    const link = siteLink(keys, [hook({ url: "https://autre-site.fr/hook" })], NOW);
    expect(link.linked).toBe(true);
    expect(link.host).toBe("taxi-karim.fr");
    expect(link.activeKeys.map((k) => k.id)).toEqual(["a", "b"]);
    expect(link.lastUsedAt).toBe("2026-10-20T07:00:00Z");
  });

  it("clé serveur seule : nom tiré d'un webhook actif (un webhook coupé est ignoré)", () => {
    expect(siteLink([key()], [hook({ enabled: false, url: "https://coupe.fr/h" }), hook()], NOW).host).toBe("taxi-karim.fr");
    expect(siteLink([key()], [hook({ enabled: false })], NOW).host).toBeNull();
  });
});
