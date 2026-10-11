import { beforeEach, describe, expect, it, vi } from "vitest";

// Mini-site /book/<slug> NON publié (booking_sites.enabled = false, ligne créée pour toute organisation) : la page
// répond 404, et ses métadonnées (titre, description diffusés dans la réponse) ne livrent ni le nom de l'organisation
// ni son accroche — sauf aperçu demandé par un membre (audit p5, admin-public-3).

const h = vi.hoisted(() => ({
  site: null as null | Record<string, unknown>,
  session: null as null | { memberships: { org: { id: string } }[] },
}));

const ORG = "11111111-1111-4111-8111-111111111111";

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
vi.mock("@/components/booking/booking-form", () => ({ BookingForm: () => null }));
vi.mock("@/components/brand/logo", () => ({ RadarMark: () => null }));
vi.mock("@/components/legal/legal-links", () => ({ LegalLinks: () => null }));
vi.mock("@/lib/auth", () => ({ getSession: async () => h.session }));
vi.mock("@/lib/booking-sites", () => ({ bookingSitesEnabled: async () => true }));
vi.mock("@/lib/geo/anchor", () => ({ publicAnchor: () => null }));
vi.mock("@/lib/public-image", () => ({ platformImageUrl: () => null }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const b: any = {
        select: () => b,
        eq: () => b,
        maybeSingle: async () =>
          table === "organizations"
            ? { data: { id: ORG, name: "Lambert VTC Photo", status: "active", timezone: "Europe/Paris", booking: h.site, network: null }, error: null }
            : { data: { shared_network_enabled: false }, error: null },
      };
      return b;
    },
  }),
}));

const page = await import("../app/book/[slug]/page");
const args = (preview?: string) => ({ params: Promise.resolve({ slug: "lambert-vtc-photo" }), searchParams: Promise.resolve({ preview }) });

beforeEach(() => {
  h.site = { enabled: false, title: null, tagline: "Votre chauffeur Lambert", vehicle_categories: ["standard"] };
  h.session = null;
});

describe("/book/<slug> : métadonnées d'un mini-site non publié", () => {
  it("non publié : titre générique, ni nom ni accroche ; la page répond 404", async () => {
    const meta = await page.generateMetadata(args());
    expect(meta).toEqual({ title: "Réservation" });
    expect(JSON.stringify(meta)).not.toMatch(/Lambert/);
    await expect(page.default(args())).rejects.toThrow("NOT_FOUND");
    // ?preview=1 sans être membre : pareil
    h.session = { memberships: [{ org: { id: "22222222-2222-4222-8222-222222222222" } }] };
    expect(await page.generateMetadata(args("1"))).toEqual({ title: "Réservation" });
  });

  it("aperçu par un membre ou mini-site publié : titre de la centrale", async () => {
    h.session = { memberships: [{ org: { id: ORG } }] };
    expect(await page.generateMetadata(args("1"))).toMatchObject({ title: { absolute: "Lambert VTC Photo — Réservation de chauffeur privé" } });
    h.session = null;
    h.site = { ...h.site, enabled: true };
    expect(await page.generateMetadata(args())).toMatchObject({ description: "Votre chauffeur Lambert" });
  });
});
