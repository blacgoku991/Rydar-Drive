import { beforeEach, describe, expect, it, vi } from "vitest";

// Contre-audit « web_api » : mini-site (app/dashboard/booking-site/actions.ts).
// - sql3#0 : « Vérifier maintenant » ne revérifie jamais un domaine personnalisé que l'offre n'inclut plus (centrale
//   sans offre : autorisé, comme private.org_limits).
// - web_public#6 : une centrale dont le sous-domaine EXISTANT est réservé (pris avant la règle) enregistre ses autres
//   réglages ; le contrôle « réservé » ne s'applique qu'à un changement de sous-domaine (comme le trigger SQL).

type Row = { organization_id: string; subdomain: string | null; custom_domain: string | null; custom_domain_verified_at: string | null; title?: string };

const h = vi.hoisted(() => ({
  rows: [] as Row[],
  ctx: null as unknown,
  txt: [] as string[][],
  limits: { custom_domain: true } as Record<string, unknown> | null,
  usageError: null as null | { message: string },
  userUpdates: [] as Record<string, unknown>[],
  audits: [] as { action: string }[],
}));

vi.mock("@/lib/audit", () => ({ audit: async (e: { action: string }) => void h.audits.push(e) }));
vi.mock("@/lib/auth", () => ({ isAdminRole: (r: string) => r === "owner" || r === "admin" }));
// Interrupteur plateforme des mini-sites allumé (coupure : domaine-booking-site.test.ts)
vi.mock("@/lib/booking-sites", () => ({ bookingSitesEnabled: async () => true }));
vi.mock("@/lib/env", () => ({ env: { rootDomain: "rydar.app", appUrl: "https://app.rydar.app" } }));
vi.mock("@/lib/errors", async () => await import("./errors"));
vi.mock("@/lib/org-context", () => ({ getOrgContext: async () => h.ctx }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("node:dns/promises", () => ({ resolveTxt: async () => h.txt }));

/** booking_sites en mémoire (client utilisateur ou service role) : select/update filtrés par eq. */
function bookingSites(kind: "user" | "admin") {
  const filters: ((r: Row) => boolean)[] = [];
  let op: "select" | "update" = "select";
  let values: Partial<Row> = {};
  let returning = false;
  const exec = async () => {
    const matched = h.rows.filter((r) => filters.every((f) => f(r)));
    if (op === "select") return { data: matched[0] ?? null, error: null };
    if (kind === "user") h.userUpdates.push(values);
    for (const r of matched) Object.assign(r, values);
    return { data: returning ? matched.map((r) => ({ organization_id: r.organization_id })) : null, error: null };
  };
  const q: any = {
    select: () => ((returning = true), q),
    update: (v: Partial<Row>) => ((op = "update"), (values = v), q),
    eq: (col: keyof Row, v: unknown) => (filters.push((r) => r[col] === v), q),
    single: () => exec(),
    maybeSingle: () => exec(),
    then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => exec().then(res, rej),
  };
  return q;
}
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: () => bookingSites("admin") }) }));

const { domainToken, updateBookingSite, verifyCustomDomain } = await import("../app/dashboard/booking-site/actions");

const ORG = "11111111-1111-4111-8111-111111111111";
const site = () => h.rows[0]!;
const form = (over: Record<string, unknown> = {}) => ({
  enabled: true, subdomain: "rydar-demo", custom_domain: "", title: "Nouveau titre", tagline: "", description: "", logo_url: "",
  hero_image_url: "", primary_color: "#C8F03C", phone: "", email: "", whatsapp: "", service_area: "",
  vehicle_categories: ["standard" as const], show_price_estimate: true, ...over,
});

beforeEach(() => {
  h.rows = [{ organization_id: ORG, subdomain: "rydar-demo", custom_domain: "resa-a.fr", custom_domain_verified_at: null }];
  h.limits = { custom_domain: true };
  h.usageError = null;
  h.userUpdates = [];
  h.audits = [];
  h.txt = [];
  h.ctx = {
    org: { id: ORG },
    role: "owner",
    user: { id: "u1" },
    supabase: {
      from: () => bookingSites("user"),
      rpc: async (fn: string, args: { p_org: string }) => {
        expect(fn).toBe("org_usage");
        expect(args.p_org).toBe(ORG);
        return h.usageError ? { data: null, error: h.usageError } : { data: { limits: h.limits }, error: null };
      },
    },
  };
});

describe("verifyCustomDomain : droit custom_domain de l'offre (sql3#0)", () => {
  it("offre sans domaine personnalisé (retiré par une rétrogradation) : TXT présent mais jamais revérifié", async () => {
    h.limits = { booking_site: true, custom_domain: false };
    h.txt = [[await domainToken(ORG)]];
    expect(await verifyCustomDomain()).toEqual({ ok: false, error: "Le domaine personnalisé n'est pas inclus dans votre offre." });
    expect(site().custom_domain_verified_at).toBeNull();
    expect(h.audits).toEqual([]);
  });

  it("limites illisibles : rien n'est écrit", async () => {
    h.usageError = { message: "TypeError: fetch failed" };
    h.txt = [[await domainToken(ORG)]];
    expect((await verifyCustomDomain()).ok).toBe(false);
    expect(site().custom_domain_verified_at).toBeNull();
  });

  it("offre qui inclut le domaine personnalisé, ou centrale sans offre (org_limits : tout autorisé) : vérifié", async () => {
    h.txt = [[await domainToken(ORG)]];
    expect(await verifyCustomDomain()).toEqual({ ok: true });
    expect(site().custom_domain_verified_at).not.toBeNull();
  });
});

describe("updateBookingSite : sous-domaine réservé déjà en place (web_public#6)", () => {
  it("sous-domaine existant réservé, inchangé : les autres réglages s'enregistrent", async () => {
    expect(await updateBookingSite(form())).toEqual({ ok: true });
    expect(site().title).toBe("Nouveau titre");
    // Même nom saisi avec une autre casse / des espaces : pas un changement
    expect(await updateBookingSite(form({ subdomain: " Rydar-Demo " }))).toEqual({ ok: true });
  });

  it("changer pour un AUTRE nom réservé reste refusé, sans écriture", async () => {
    const res = await updateBookingSite(form({ subdomain: "support" }));
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toMatch(/nom réservé à la plateforme/i);
    expect(h.userUpdates).toEqual([]);
  });

  it("quitter le nom réservé pour un nom ordinaire : accepté", async () => {
    expect(await updateBookingSite(form({ subdomain: "centrale-demo" }))).toEqual({ ok: true });
    expect(site().subdomain).toBe("centrale-demo");
  });

  it("sans sous-domaine enregistré : choisir un nom réservé est refusé", async () => {
    site().subdomain = null;
    const res = await updateBookingSite(form({ subdomain: "admin" }));
    expect(res.ok).toBe(false);
    expect(h.userUpdates).toEqual([]);
  });
});
