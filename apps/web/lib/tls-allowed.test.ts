import { beforeEach, describe, expect, it, vi } from "vitest";

// app/api/tls/allowed/route.ts (Caddy, certificats « à la demande ») : hôtes de la plateforme toujours acceptés ;
// hôtes de mini-site acceptés seulement si resolve_booking_host les connaît ET si les mini-sites ne sont pas coupés
// par la plateforme (interrupteur du super admin, migration 20260924006200).

const h = vi.hoisted(() => ({
  bookingSites: true,
  switchReads: 0,
  slug: null as string | null,
  error: null as null | { message: string },
  calls: [] as { fn: string; args: unknown }[],
  /** Budget global des recherches en base (rateLimit("tls-ask:lookup", …)) : appels comptés, dépassement simulé */
  budgetCalls: [] as { key: string; limit: number; windowSec: number }[],
  budgetOk: true,
}));

vi.mock("@/lib/env", () => ({ env: { appUrl: "https://app.rydar.app", rootDomain: "rydar.app" } }));
vi.mock("@/lib/hostname", async () => await import("./hostname"));
vi.mock("@/lib/booking-sites", () => ({
  bookingSitesEnabled: async () => {
    h.switchReads += 1;
    return h.bookingSites;
  },
}));
vi.mock("@/lib/geo/cache", async () => await import("./geo/cache"));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: async (key: string, limit: number, windowSec: number) => {
    h.budgetCalls.push({ key, limit, windowSec });
    return { ok: h.budgetOk, remaining: 0, resetAt: 0, limit };
  },
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async (fn: string, args: unknown) => {
      h.calls.push({ fn, args });
      return h.error ? { data: null, error: h.error } : { data: h.slug, error: null };
    },
  }),
}));

// Caches de la route (décisions, interrupteur) : propres à chaque test (module rechargé)
let GET: (req: Request) => Promise<Response>;

const ask = async (domain: string) => (await GET(new Request(`http://web:3000/api/tls/allowed?domain=${encodeURIComponent(domain)}`))).status;

beforeEach(async () => {
  h.bookingSites = true;
  h.switchReads = 0;
  h.slug = null;
  h.error = null;
  h.calls = [];
  h.budgetCalls = [];
  h.budgetOk = true;
  vi.useRealTimers();
  vi.resetModules();
  ({ GET } = await import("../app/api/tls/allowed/route"));
});

describe("/api/tls/allowed", () => {
  it("mini-sites coupés : aucun nouveau certificat pour un sous-domaine ou un domaine personnalisé, sans résolution", async () => {
    h.bookingSites = false;
    h.slug = "elite";
    expect(await ask("elite.rydar.app")).toBe(404);
    expect(await ask("reservation.ma-centrale.fr")).toBe(404);
    expect(h.calls).toEqual([]);
  });

  it("mini-sites coupés : les hôtes de la plateforme restent acceptés", async () => {
    h.bookingSites = false;
    for (const host of ["app.rydar.app", "rydar.app", "www.rydar.app"]) expect(await ask(host)).toBe(200);
  });

  it("mini-sites servis : hôte connu accepté, inconnu refusé, panne de la base → 503", async () => {
    h.slug = "elite";
    expect(await ask("elite.rydar.app")).toBe(200);
    expect(h.calls).toEqual([{ fn: "resolve_booking_host", args: { p_host: "elite.rydar.app", p_root_domain: "rydar.app" } }]);
    h.slug = null;
    expect(await ask("inconnu.rydar.app")).toBe(404);
    h.error = { message: "fetch failed" };
    expect(await ask("autre.rydar.app")).toBe(503);
    // Accord déjà donné : gardé (aucune requête en base)
    expect(await ask("elite.rydar.app")).toBe(200);
    expect(h.calls).toHaveLength(3);
  });

  it("nom d'hôte invalide : 400, avant tout appel", async () => {
    expect(await ask("a_b.exemple.fr")).toBe(400);
    expect(h.calls).toEqual([]);
  });
});

describe("/api/tls/allowed : coût par poignée de main TLS borné (audit p5 web-2)", () => {
  // Caddy (on_demand_tls ask) appelle la route à CHAQUE poignée de main dont le SNI n'a pas de certificat, sans garder
  // les refus : avant, chaque appel coûtait 2 RPC service role (interrupteur + resolve_booking_host).
  it("même nom inconnu demandé 3 fois : 1 seule résolution, interrupteur lu 1 fois", async () => {
    for (let i = 0; i < 3; i += 1) expect(await ask("inconnu.rydar.app")).toBe(404);
    expect(h.calls).toHaveLength(1);
    expect(h.switchReads).toBe(1);
  });

  it("refus gardé 60 s, accord 5 min ; panne de la base jamais gardée", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-11T10:00:00Z"));
    expect(await ask("bientot.rydar.app")).toBe(404);
    h.slug = "bientot";
    vi.setSystemTime(new Date("2026-10-11T10:00:50Z"));
    expect(await ask("bientot.rydar.app")).toBe(404); // refus encore gardé
    vi.setSystemTime(new Date("2026-10-11T10:01:01Z"));
    expect(await ask("bientot.rydar.app")).toBe(200); // mini-site tout juste activé : accepté passé 60 s
    vi.setSystemTime(new Date("2026-10-11T10:05:00Z"));
    expect(await ask("bientot.rydar.app")).toBe(200);
    expect(h.calls).toHaveLength(2);
    h.error = { message: "fetch failed" };
    expect(await ask("panne.rydar.app")).toBe(503);
    expect(await ask("panne.rydar.app")).toBe(503);
    expect(h.calls).toHaveLength(4);
  });

  it("interrupteur des mini-sites relu au plus toutes les 30 s ; coupé : accords gardés ignorés", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-11T10:00:00Z"));
    h.slug = "elite";
    expect(await ask("elite.rydar.app")).toBe(200);
    h.bookingSites = false;
    vi.setSystemTime(new Date("2026-10-11T10:00:20Z"));
    expect(await ask("autre.rydar.app")).toBe(200);
    expect(h.switchReads).toBe(1);
    vi.setSystemTime(new Date("2026-10-11T10:00:31Z"));
    expect(await ask("elite.rydar.app")).toBe(404); // coupé : accord gardé non utilisé
    expect(h.switchReads).toBe(2);
  });

  it("budget global des résolutions épuisé (SNI aléatoires en rafale) : 404 sans requête en base", async () => {
    h.slug = "elite";
    h.budgetOk = false;
    expect(await ask("x1.aleatoire.fr")).toBe(404);
    expect(await ask("x2.aleatoire.fr")).toBe(404);
    expect(h.calls).toEqual([]);
    expect(h.budgetCalls[0]).toMatchObject({ key: "tls-ask:lookup" });
    // Hôtes de la plateforme : jamais concernés par le budget
    expect(await ask("app.rydar.app")).toBe(200);
    expect(h.budgetCalls).toHaveLength(2);
  });
});
