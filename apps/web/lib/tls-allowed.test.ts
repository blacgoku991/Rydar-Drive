import { beforeEach, describe, expect, it, vi } from "vitest";

// app/api/tls/allowed/route.ts (Caddy, certificats « à la demande ») : hôtes de la plateforme toujours acceptés ;
// hôtes de mini-site acceptés seulement si resolve_booking_host les connaît ET si les mini-sites ne sont pas coupés
// par la plateforme (interrupteur du super admin, migration 20260924006200).

const h = vi.hoisted(() => ({
  bookingSites: true,
  slug: null as string | null,
  error: null as null | { message: string },
  calls: [] as { fn: string; args: unknown }[],
}));

vi.mock("@/lib/env", () => ({ env: { appUrl: "https://app.rydar.app", rootDomain: "rydar.app" } }));
vi.mock("@/lib/hostname", async () => await import("./hostname"));
vi.mock("@/lib/booking-sites", () => ({ bookingSitesEnabled: async () => h.bookingSites }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async (fn: string, args: unknown) => {
      h.calls.push({ fn, args });
      return h.error ? { data: null, error: h.error } : { data: h.slug, error: null };
    },
  }),
}));

const { GET } = await import("../app/api/tls/allowed/route");

const ask = async (domain: string) => (await GET(new Request(`http://web:3000/api/tls/allowed?domain=${encodeURIComponent(domain)}`))).status;

beforeEach(() => {
  h.bookingSites = true;
  h.slug = null;
  h.error = null;
  h.calls = [];
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
    expect(await ask("elite.rydar.app")).toBe(503);
  });

  it("nom d'hôte invalide : 400, avant tout appel", async () => {
    expect(await ask("a_b.exemple.fr")).toBe(400);
    expect(h.calls).toEqual([]);
  });
});
