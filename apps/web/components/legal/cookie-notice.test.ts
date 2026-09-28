import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// Bandeau d'information cookies : ne masque jamais un contrôle (e2e D1 : il recouvrait le menu du compte,
// « Se déconnecter », en bas de la barre latérale du tableau de bord).

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  usePathname: () => "/dashboard",
}));
vi.mock("@/lib/utils", async () => await import("../../lib/utils"));
vi.mock("@/components/brand/logo", async () => await import("../brand/logo"));
vi.mock("@/components/ui/misc", async () => await import("../ui/misc"));

const { cookieNoticeSlot, FloatingNotice, SidebarNotice } = await import("./cookie-notice");
const { Sidebar } = await import("../shell/sidebar");

const noop = () => undefined;

describe("bandeau cookies : emplacement", () => {
  it("espaces connectés (tableau de bord, super admin) : jamais flottant, placé dans la barre latérale par le shell", () => {
    for (const path of ["/dashboard", "/dashboard/rides/123", "/admin", "/admin/organizations/x"]) {
      expect(cookieNoticeSlot("floating", path)).toBeNull();
      expect(cookieNoticeSlot("sidebar", path)).toBe("sidebar");
    }
    for (const path of ["/", "/login", "/book/elite", "/rejoindre/abc", "/cookies", "/dashboards", "/suspended"]) {
      expect(cookieNoticeSlot("floating", path)).toBe("floating");
    }
  });

  it("barre latérale : dans le flux (jamais fixe), AVANT le menu du compte", () => {
    const html = renderToStaticMarkup(
      createElement(Sidebar, {
        sections: [{ title: "Opérations", items: [{ href: "/dashboard", label: "En direct", icon: "radar", exact: true }] }],
        subtitle: "Dispatch",
        user: { name: "Gérant", email: "gerant@exemple.fr" },
        signOut: noop,
        notice: createElement(SidebarNotice, { href: "/cookies", onClose: noop }),
      }),
    );
    const notice = html.indexOf('aria-label="Information sur les cookies"');
    const account = html.indexOf("gerant@exemple.fr");
    expect(notice).toBeGreaterThan(0);
    expect(account).toBeGreaterThan(notice);
    const region = renderToStaticMarkup(createElement(SidebarNotice, { href: "/cookies", onClose: noop }));
    expect(region).not.toMatch(/\bfixed\b/);
    expect(region).toContain('href="/cookies"');
  });

  it("pages publiques : sous les dialogues (z-50) et menus (z-[60]), avec une réserve de place en fin de page", () => {
    const html = renderToStaticMarkup(createElement(FloatingNotice, { href: "/cookies", onClose: noop }));
    expect(html).toMatch(/class="fixed [^"]*\bz-40\b/);
    expect(html).not.toContain("z-[60]");
    // Réserve dans le flux, rendue avant le bandeau fixe
    expect(html.indexOf('aria-hidden="true"')).toBeGreaterThanOrEqual(0);
    expect(html.indexOf('aria-hidden="true"')).toBeLessThan(html.indexOf('role="region"'));
    expect(html).toContain('aria-label="Fermer l&#x27;information sur les cookies"');
  });
});
