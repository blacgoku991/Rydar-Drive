import { beforeEach, describe, expect, it, vi } from "vitest";

// Mini-site (app/dashboard/booking-site/actions.ts) : vérification ATOMIQUE du domaine personnalisé (le domaine marqué
// vérifié est celui dont le TXT a été lu), domaines de la plateforme refusés, messages d'erreur clairs.

type Row = { organization_id: string; subdomain: string | null; custom_domain: string | null; custom_domain_verified_at: string | null };
type PgError = { code?: string; message: string };

const h = vi.hoisted(() => ({
  rows: [] as Row[],
  ctx: null as unknown,
  resolveTxt: (async () => []) as (name: string) => Promise<string[][]>,
  /** Erreur renvoyée par l'UPDATE du client utilisateur (updateBookingSite) */
  userUpdateError: null as PgError | null,
  userUpdates: 0,
  audits: [] as { action: string; metadata?: Record<string, unknown> }[],
  /** Interrupteur plateforme des mini-sites (platform_settings, migration 20260924006200) */
  bookingSites: true,
}));

vi.mock("@/lib/audit", () => ({ audit: async (e: { action: string; metadata?: Record<string, unknown> }) => void h.audits.push(e) }));
vi.mock("@/lib/auth", () => ({ isAdminRole: (r: string) => r === "owner" || r === "admin" }));
vi.mock("@/lib/booking-sites", () => ({ bookingSitesEnabled: async () => h.bookingSites }));
vi.mock("@/lib/env", () => ({ env: { rootDomain: "rydar.app", appUrl: "https://app.rydar.app" } }));
vi.mock("@/lib/errors", async () => await import("./errors"));
vi.mock("@/lib/org-context", () => ({ getOrgContext: async () => h.ctx }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("node:dns/promises", () => ({ resolveTxt: (name: string) => h.resolveTxt(name) }));

/** booking_sites en mémoire : filtres eq/is, trigger « domaine changé → vérification remise à zéro », index unique partiel. */
function bookingSites(kind: "user" | "admin") {
  const filters: ((r: Row) => boolean)[] = [];
  let op: "select" | "update" = "select";
  let values: Partial<Row> = {};
  let returning = false;
  const exec = async (): Promise<{ data: unknown; error: PgError | null }> => {
    const matched = h.rows.filter((r) => filters.every((f) => f(r)));
    if (op === "select") return { data: matched[0] ?? null, error: null };
    if (kind === "user") {
      h.userUpdates += 1;
      if (h.userUpdateError) return { data: null, error: h.userUpdateError };
    }
    for (const r of matched) {
      const next = { ...r, ...values };
      if (next.custom_domain !== r.custom_domain) next.custom_domain_verified_at = null;
      const clash = next.custom_domain_verified_at && h.rows.some((o) => o !== r && o.custom_domain_verified_at && o.custom_domain === next.custom_domain);
      if (clash) return { data: null, error: { code: "23505", message: 'duplicate key value violates unique constraint "booking_sites_custom_domain_verified_key"' } };
      Object.assign(r, next);
    }
    return { data: returning ? matched.map((r) => ({ organization_id: r.organization_id })) : null, error: null };
  };
  const q = {
    select() {
      returning = true;
      return q;
    },
    update(v: Partial<Row>) {
      op = "update";
      values = v;
      return q;
    },
    eq(col: keyof Row, v: unknown) {
      filters.push((r) => r[col] === v);
      return q;
    },
    is(col: keyof Row, v: unknown) {
      filters.push((r) => r[col] === v);
      return q;
    },
    single: () => exec(),
    then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => exec().then(res, rej),
  };
  return q;
}

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: () => bookingSites("admin") }) }));

const { domainToken, updateBookingSite, verifyCustomDomain } = await import("../app/dashboard/booking-site/actions");

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const site = () => h.rows.find((r) => r.organization_id === ORG)!;
const form = (over: Record<string, unknown> = {}) => ({
  enabled: true, subdomain: "centrale-a", custom_domain: "", title: "Centrale A", tagline: "", description: "", logo_url: "",
  hero_image_url: "", primary_color: "#C8F03C", phone: "", email: "", whatsapp: "", service_area: "",
  vehicle_categories: ["standard" as const], show_price_estimate: true, ...over,
});

beforeEach(() => {
  h.rows = [
    { organization_id: ORG, subdomain: "centrale-a", custom_domain: "mon-a.fr", custom_domain_verified_at: null },
    { organization_id: OTHER, subdomain: "elite", custom_domain: null, custom_domain_verified_at: null },
  ];
  h.ctx = {
    org: { id: ORG },
    role: "owner",
    user: { id: "u1" },
    // org_usage : droit custom_domain de l'offre relu par verifyCustomDomain (contre-audit sql3#0)
    supabase: { from: () => bookingSites("user"), rpc: async () => ({ data: { limits: { custom_domain: true } }, error: null }) },
  };
  h.userUpdateError = null;
  h.userUpdates = 0;
  h.audits = [];
  h.bookingSites = true;
});

describe("mini-sites coupés par la plateforme (super admin)", () => {
  it("enregistrement et vérification du domaine refusés avant toute lecture ou écriture, message clair", async () => {
    h.bookingSites = false;
    h.resolveTxt = async () => {
      throw new Error("aucune résolution DNS attendue");
    };
    const message = "Les mini-sites de réservation sont momentanément désactivés par Rydar.";
    expect(await updateBookingSite(form({ title: "Autre titre" }))).toEqual({ ok: false, error: message });
    expect(await verifyCustomDomain()).toEqual({ ok: false, error: message });
    expect(h.userUpdates).toBe(0);
    expect(site()).toEqual({ organization_id: ORG, subdomain: "centrale-a", custom_domain: "mon-a.fr", custom_domain_verified_at: null });
    expect(h.audits).toHaveLength(0);
  });

  it("coupure survenue entre le contrôle et l'écriture : refus de la base traduit (BOOKING_SITES_DISABLED)", async () => {
    h.userUpdateError = { code: "55000", message: "BOOKING_SITES_DISABLED: les mini-sites de réservation sont désactivés par la plateforme" };
    expect(await updateBookingSite(form())).toEqual({
      ok: false,
      error: "Les mini-sites de réservation sont momentanément désactivés par Rydar.",
    });
  });
});

describe("verifyCustomDomain : vérification atomique", () => {
  it("domaine changé PENDANT la résolution DNS (TOCTOU) : rien n'est marqué vérifié", async () => {
    const token = await domainToken(ORG);
    h.resolveTxt = async (name) => {
      expect(name).toBe("_rydar.mon-a.fr");
      // updateBookingSite concurrent : le domaine devient celui d'une autre centrale (le trigger remet la vérification à zéro)
      Object.assign(site(), { custom_domain: "elite.rydar.app", custom_domain_verified_at: null });
      return [[token]];
    };
    const res = await verifyCustomDomain();
    expect(res).toEqual({ ok: false, error: "Le domaine a changé pendant la vérification : recommencez." });
    expect(site().custom_domain_verified_at).toBeNull();
    expect(h.audits).toHaveLength(0);
  });

  it("TXT correct et domaine inchangé : vérifié et journalisé avec le domaine réellement vérifié", async () => {
    const token = await domainToken(ORG);
    h.resolveTxt = async () => [["autre"], [token.slice(0, 10), token.slice(10)]];
    expect(await verifyCustomDomain()).toEqual({ ok: true });
    expect(site().custom_domain_verified_at).not.toBeNull();
    expect(h.audits).toEqual([expect.objectContaining({ action: "booking_site.domain_verified", metadata: { domain: "mon-a.fr" } })]);
  });

  it("domaine déjà vérifié par une autre centrale : message clair (23505)", async () => {
    Object.assign(h.rows[1]!, { custom_domain: "mon-a.fr", custom_domain_verified_at: new Date().toISOString() });
    const token = await domainToken(ORG);
    h.resolveTxt = async () => [[token]];
    const res = await verifyCustomDomain();
    expect(res).toEqual({ ok: false, error: expect.stringMatching(/^Ce domaine est déjà vérifié par une autre centrale/) });
    expect(site().custom_domain_verified_at).toBeNull();
  });

  it("TXT absent : refus, rien n'est écrit", async () => {
    h.resolveTxt = async () => [];
    expect(await verifyCustomDomain()).toEqual({ ok: false, error: "Enregistrement TXT introuvable sur _rydar.mon-a.fr." });
    expect(site().custom_domain_verified_at).toBeNull();
  });

  it("domaine de la plateforme (saisi directement en base) : jamais vérifié", async () => {
    site().custom_domain = "elite.rydar.app";
    h.resolveTxt = async () => [[await domainToken(ORG)]];
    const res = await verifyCustomDomain();
    expect(res.ok).toBe(false);
    expect(site().custom_domain_verified_at).toBeNull();
  });
});

describe("updateBookingSite", () => {
  it("refuse un domaine personnalisé égal au domaine racine, à l'un de ses sous-domaines ou à l'hôte de l'application", async () => {
    for (const custom_domain of ["rydar.app", "elite.rydar.app", "app.rydar.app"]) {
      const res = await updateBookingSite(form({ custom_domain }));
      expect(res).toEqual({ ok: false, error: expect.stringMatching(/^Le domaine personnalisé ne peut pas être rydar\.app/) });
    }
    expect(h.userUpdates).toBe(0);
    expect(await updateBookingSite(form({ custom_domain: "reservation.ma-centrale.fr" }))).toEqual({ ok: true });
    expect(await updateBookingSite(form({ custom_domain: "rydar.app.ma-centrale.fr" }))).toEqual({ ok: true });
  });

  it("messages clairs : sous-domaine pris, trop de changements de sous-domaine", async () => {
    h.userUpdateError = { code: "23505", message: 'duplicate key value violates unique constraint "booking_sites_subdomain_key"' };
    expect(await updateBookingSite(form())).toEqual({ ok: false, error: "Ce sous-domaine est déjà utilisé : choisissez-en un autre." });
    h.userUpdateError = { code: "P0001", message: "SUBDOMAIN_CHANGE_LIMIT: sous-domaine déjà modifié 5 fois en 7 jours" };
    expect(await updateBookingSite(form())).toEqual({
      ok: false,
      error: "Sous-domaine déjà modifié 5 fois ces 7 derniers jours : réessayez plus tard ou contactez l'équipe Rydar.",
    });
  });
});
