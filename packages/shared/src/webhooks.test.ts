import { describe, expect, it } from "vitest";
import { ERROR_MESSAGES } from "./domain";
import { API_SCOPE_LABELS, API_SCOPES, apiKeyCreateSchema, BROWSER_KEY_SCOPES } from "./schemas";
import {
  isNonPublicIpLiteral,
  WEBHOOK_API_VERSION,
  WEBHOOK_EVENT_META,
  WEBHOOK_EVENTS,
  WEBHOOK_FIELD_ERROR_CODES,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_RETRY_DELAYS_S,
  webhookEventLabel,
  webhookSignedContent,
  webhookUpsertSchema,
  webhookUrlProblem,
} from "./webhooks";

describe("événements", () => {
  it("12 événements abonnables, chacun avec un libellé français ; ping hors liste", () => {
    expect(WEBHOOK_EVENTS).toHaveLength(12);
    expect(WEBHOOK_EVENTS).toContain("ride.search_restarted");
    for (const e of WEBHOOK_EVENTS) {
      expect(e).toMatch(/^ride\.[a-z_]+$/);
      expect(WEBHOOK_EVENT_META[e].label.length).toBeGreaterThan(3);
    }
    expect(WEBHOOK_EVENTS).not.toContain("ping" as never);
    expect(webhookEventLabel("ping")).toBe("Test");
    expect(webhookEventLabel("ride.completed")).toBe("Course terminée");
    expect(webhookEventLabel("inconnu")).toBe("inconnu");
  });

  it("version, nouveaux essais (9 tentatives au total), texte signé", () => {
    expect(WEBHOOK_API_VERSION).toBe("2026-10-01");
    expect([...WEBHOOK_RETRY_DELAYS_S]).toEqual([60, 300, 900, 3600, 10800, 21600, 43200, 86400]);
    expect(WEBHOOK_MAX_ATTEMPTS).toBe(9);
    expect(webhookSignedContent(1_790_000_000, '{"id":"x"}')).toBe('1790000000.{"id":"x"}');
  });
});

describe("adresse de destination", () => {
  it("accepte une adresse https publique (port, chemin, requête, IP publique)", () => {
    for (const url of [
      "https://www.rydar-prive.fr/api/drive/webhook",
      "https://hooks.example.com:8443/rydar?source=drive",
      "https://8.8.8.8/hook",
      "https://[2001:4860:4860::8888]/hook",
      "  https://exemple.fr/hook  ",
    ]) {
      expect(webhookUrlProblem(url), url).toBeNull();
    }
  });

  it("refuse http, identifiants, espaces, adresse trop longue ou mal formée", () => {
    expect(webhookUrlProblem("http://exemple.fr/hook")).toMatch(/https/);
    expect(webhookUrlProblem("ftp://exemple.fr/hook")).toMatch(/https/);
    expect(webhookUrlProblem("https:exemple.fr/hook")).toMatch(/https/);
    expect(webhookUrlProblem("https://user:pass@exemple.fr/hook")).toMatch(/Identifiants/);
    expect(webhookUrlProblem("https://exemple.fr/a b")).toMatch(/espace/);
    expect(webhookUrlProblem(`https://exemple.fr/${"a".repeat(500)}`)).toMatch(/500/);
    expect(webhookUrlProblem("https://")).not.toBeNull();
    expect(webhookUrlProblem("")).not.toBeNull();
  });

  it("refuse localhost, réseaux locaux et noms sans domaine", () => {
    for (const url of [
      "https://localhost/hook",
      "https://LOCALHOST./hook",
      "https://api.localhost/hook",
      "https://imprimante.local/hook",
      "https://metadata.google.internal/computeMetadata",
      "https://intranet/hook",
    ]) {
      expect(webhookUrlProblem(url), url).not.toBeNull();
    }
  });

  it("refuse les IP littérales privées, y compris les formes déguisées", () => {
    for (const url of [
      "https://127.0.0.1/hook",
      "https://127.1/hook", // normalisée en 127.0.0.1
      "https://2130706433/hook", // 127.0.0.1 en entier décimal
      "https://0x7f000001/hook",
      "https://10.1.2.3/hook",
      "https://172.16.0.1/hook",
      "https://172.31.255.255/hook",
      "https://192.168.1.10/hook",
      "https://169.254.169.254/latest/meta-data",
      "https://100.64.0.1/hook",
      "https://0.0.0.0/hook",
      "https://224.0.0.1/hook",
      "https://255.255.255.255/hook",
      "https://[::1]/hook",
      "https://[::]/hook",
      "https://[fe80::1]/hook",
      "https://[fd00::1]/hook",
      "https://[ff02::1]/hook",
      "https://[::ffff:127.0.0.1]/hook",
      "https://[::ffff:10.0.0.1]/hook",
      "https://[64:ff9b::a9fe:a9fe]/hook", // NAT64 → 169.254.169.254
      "https://[2002:c0a8:0101::1]/hook", // 6to4 → 192.168.1.1
    ]) {
      expect(webhookUrlProblem(url), url).not.toBeNull();
    }
  });

  it("isNonPublicIpLiteral : bornes des plages", () => {
    expect(isNonPublicIpLiteral("172.15.255.255")).toBe(false);
    expect(isNonPublicIpLiteral("172.32.0.1")).toBe(false);
    expect(isNonPublicIpLiteral("100.63.255.255")).toBe(false);
    expect(isNonPublicIpLiteral("100.128.0.1")).toBe(false);
    expect(isNonPublicIpLiteral("223.255.255.255")).toBe(false);
    expect(isNonPublicIpLiteral("[::ffff:8.8.8.8]")).toBe(false);
    expect(isNonPublicIpLiteral("exemple.fr")).toBe(false);
    expect(isNonPublicIpLiteral("[::ffff:7f00:1]")).toBe(true);
    // IPv6 illisible : refusée par prudence
    expect(isNonPublicIpLiteral("[1:2:3]")).toBe(true);
  });
});

describe("webhookUpsertSchema (POST /api/v1/webhooks, dashboard)", () => {
  const url = "https://www.rydar-prive.fr/api/drive/webhook";

  it("valeurs par défaut : tous les événements, sans description ni secret", () => {
    const v = webhookUpsertSchema.parse({ url });
    expect(v).toEqual({ url, description: null, events: [], secret: null });
    expect(webhookUpsertSchema.parse({ url, events: null, description: "  " })).toMatchObject({ events: [], description: null });
  });

  it("événements dédoublonnés, inconnus refusés", () => {
    expect(webhookUpsertSchema.parse({ url, events: ["ride.completed", "ride.completed", "ride.cancelled"] }).events).toEqual([
      "ride.completed",
      "ride.cancelled",
    ]);
    const bad = webhookUpsertSchema.safeParse({ url, events: ["ride.completed", "ping"] });
    expect(bad.success).toBe(false);
    expect(bad.error!.issues[0]!.path[0]).toBe("events");
  });

  it("secret : 32 à 200 caractères [A-Za-z0-9_.-]", () => {
    expect(webhookUpsertSchema.safeParse({ url, secret: "a".repeat(32) }).success).toBe(true);
    expect(webhookUpsertSchema.safeParse({ url, secret: `whsec_${"0".repeat(48)}` }).success).toBe(true);
    expect(webhookUpsertSchema.safeParse({ url, secret: "a".repeat(31) }).success).toBe(false);
    expect(webhookUpsertSchema.safeParse({ url, secret: "a".repeat(201) }).success).toBe(false);
    expect(webhookUpsertSchema.safeParse({ url, secret: `${"a".repeat(32)} ` }).success).toBe(false);
    expect(webhookUpsertSchema.safeParse({ url, secret: `${"a".repeat(32)}/` }).success).toBe(false);
  });

  it("description de 120 caractères au plus ; champ inconnu refusé", () => {
    expect(webhookUpsertSchema.safeParse({ url, description: "x".repeat(120) }).success).toBe(true);
    expect(webhookUpsertSchema.safeParse({ url, description: "x".repeat(121) }).success).toBe(false);
    const extra = webhookUpsertSchema.safeParse({ url, organization_id: "x" });
    expect(extra.success).toBe(false);
  });

  it("chaque code d'erreur des webhooks a un libellé", () => {
    for (const code of [
      ...Object.values(WEBHOOK_FIELD_ERROR_CODES), "WEBHOOK_LIMIT", "WEBHOOK_NOT_FOUND", "WEBHOOK_DISABLED",
      "WEBHOOK_DELIVERY_NOT_FOUND", "WEBHOOK_TEST_PENDING", "WEBHOOK_TEST_RATE_LIMITED",
    ]) {
      expect(ERROR_MESSAGES[code], code).toBeTruthy();
    }
  });
});

describe("permission webhooks:manage", () => {
  const base = { name: "Serveur RYDAR Privé", rateLimitPerMinute: 60 };

  it("permission disponible avec un libellé, jamais pour une clé « navigateur »", () => {
    expect(API_SCOPES).toContain("webhooks:manage");
    expect(API_SCOPE_LABELS["webhooks:manage"]).toBe("Webhooks");
    expect(BROWSER_KEY_SCOPES).toEqual(["rides:create"]);
    expect(apiKeyCreateSchema.safeParse({ ...base, scopes: ["rides:create", "webhooks:manage"] }).success).toBe(true);
    expect(
      apiKeyCreateSchema.safeParse({ ...base, scopes: ["rides:create", "webhooks:manage"], allowedOrigins: ["https://www.centrale.fr"] }).success,
    ).toBe(false);
  });
});
