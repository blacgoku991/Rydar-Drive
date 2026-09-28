import { describe, expect, it, vi } from "vitest";

// robots.txt et sitemap.xml ne passent pas par le proxy (fichiers .txt / .xml) : ils répondent aussi sur les
// mini-sites des centrales (sous-domaine, domaine personnalisé). Là, jamais de trace de la plateforme (marque blanche).

const req = vi.hoisted(() => ({ host: "localhost:3000" as string | null }));

vi.mock("next/headers", () => ({
  headers: async () => new Headers(req.host == null ? {} : { host: req.host }),
}));
vi.mock("@/lib/env", async () => await import("../../lib/env"));
vi.mock("@/lib/utils", async () => await import("../../lib/utils"));
vi.mock("@/components/marketing/seo", async () => await import("./seo"));
vi.mock("@/components/legal/legal-links", async () => await import("../legal/legal-links"));

const { isPlatformHost } = await import("./seo");
const { default: robots } = await import("../../app/robots");
const { default: sitemap } = await import("../../app/sitemap");
const { env } = await import("../../lib/env");

const PLATFORM = { appUrl: "https://app.rydar.app", rootDomain: "rydar.app" };

describe("site vitrine : hôte de la plateforme ou mini-site d'une centrale", () => {
  it("plateforme : URL de l'application, domaine racine, www, localhost, IPv4 (port, casse et point final ignorés)", () => {
    for (const host of ["app.rydar.app", "APP.Rydar.app:443", "rydar.app", "rydar.app.", "www.rydar.app", "localhost:3000", "127.0.0.1:3107", ""]) {
      expect(isPlatformHost(host, PLATFORM), host).toBe(true);
    }
    expect(isPlatformHost(null, PLATFORM)).toBe(true);
  });

  it("mini-site : sous-domaine d'une centrale ou domaine personnalisé", () => {
    for (const host of ["elite.rydar.app", "reservation.ma-centrale.fr", "rydar.app.evil.com", "wwwrydar.app"]) {
      expect(isPlatformHost(host, PLATFORM), host).toBe(false);
    }
  });

  it("URL de l'application invalide : le domaine racine reste reconnu", () => {
    expect(isPlatformHost("rydar.app", { appUrl: "pas une url", rootDomain: "rydar.app" })).toBe(true);
    expect(isPlatformHost("elite.rydar.app", { appUrl: "pas une url", rootDomain: "rydar.app" })).toBe(false);
  });
});

describe("robots.txt et sitemap.xml", () => {
  it("plateforme : chemins privés exclus et plan du site annoncé", async () => {
    req.host = "localhost:3000";
    const r = await robots();
    expect(r.sitemap).toBe(`${env.appUrl.replace(/\/+$/, "")}/sitemap.xml`);
    expect(r.rules).toMatchObject({ userAgent: "*", allow: "/", disallow: ["/dashboard", "/admin", "/api", "/auth"] });
    const urls = (await sitemap()).map((u) => u.url.replace(env.appUrl.replace(/\/+$/, ""), ""));
    expect(urls).toEqual(expect.arrayContaining(["/", "/services", "/avantages", "/tarifs", "/faq", "/contact", "/cgv", "/dpa"]));
  });

  it("mini-site d'une centrale : robots neutre, sans plan du site ni chemins de la plateforme ; plan du site vide", async () => {
    for (const host of ["elite.rydar.app", "reservation.ma-centrale.fr"]) {
      req.host = host;
      const r = await robots();
      expect(r.sitemap).toBeUndefined();
      expect(JSON.stringify(r)).not.toMatch(/dashboard|admin|auth|sitemap/);
      expect(await sitemap()).toEqual([]);
    }
  });
});
