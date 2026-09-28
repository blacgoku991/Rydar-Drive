import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// Site vitrine en plusieurs pages : navigation par pages avec lien actif, « Demander un tarif » et les offres vers le
// formulaire de contact, anciennes ancres de l'accueil redirigées ; plus aucune « démo » ni lien mailto commercial.

const nav = vi.hoisted(() => ({ pathname: "/services" }));

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  usePathname: () => nav.pathname,
}));
vi.mock("@/lib/utils", async () => await import("../../lib/utils"));
vi.mock("@/lib/env", async () => await import("../../lib/env"));
vi.mock("@/components/brand/logo", async () => await import("../brand/logo"));
vi.mock("@/components/ui/button", async () => await import("../ui/button"));
vi.mock("@/components/legal/legal-links", async () => await import("../legal/legal-links"));

const { SiteHeader } = await import("./site-header");
const { SiteFooter } = await import("./site-footer");
const { FinalCta } = await import("./final-cta");
const { PlanCards } = await import("./pricing");
const { contactHref, PRICING_HREF, QUESTION_HREF } = await import("./contact");
const { NAV_LINKS, isCurrentPage, legacyAnchorTarget } = await import("./nav");

/** Balises <a> du rendu, avec leurs attributs (href décodé). */
function anchors(html: string) {
  return [...html.matchAll(/<a\b([^>]*)>/g)].map(([, attrs]) => ({
    href: /\bhref="([^"]*)"/.exec(attrs!)?.[1]?.replaceAll("&amp;", "&") ?? null,
    current: /\baria-current="page"/.test(attrs!),
  }));
}

function expectNoDemoNorMailto(html: string) {
  expect(html).not.toMatch(/d[ée]mo\b/i);
  expect(html).not.toContain("mailto:");
}

describe("site vitrine : liens de contact", () => {
  it("contactHref : sujet et offre en paramètres d'URL, encodés", () => {
    expect(contactHref()).toBe("/contact");
    expect(contactHref("tarif")).toBe("/contact?sujet=tarif");
    expect(contactHref("tarif", "pro")).toBe("/contact?sujet=tarif&offre=pro");
    expect(contactHref("tarif", "a b&c")).toBe("/contact?sujet=tarif&offre=a+b%26c");
    expect(PRICING_HREF).toBe("/contact?sujet=tarif");
    expect(QUESTION_HREF).toBe("/contact?sujet=question");
  });

  it("offres : chaque bouton ouvre le formulaire avec le sujet « tarif » et le code de l'offre", () => {
    const plan = { id: "1", code: "pro", name: "Pro", description: null, price_monthly_cents: 9900, features: ["Mini-site"], highlighted: true };
    const html = renderToStaticMarkup(createElement(PlanCards, { plans: [plan] }));
    expect(anchors(html).map((a) => a.href)).toEqual(["/contact?sujet=tarif&offre=pro"]);
    expectNoDemoNorMailto(html);
  });

  it("sans offre publique : « Tarif sur mesure » et « Demander un tarif » vers le formulaire", () => {
    const html = renderToStaticMarkup(createElement(PlanCards, { plans: [] }));
    expect(html).toContain("Tarif sur mesure");
    expect(html).toContain("Demander un tarif");
    expect(anchors(html).map((a) => a.href)).toEqual(["/contact?sujet=tarif"]);
  });

  it("appel final : demande de tarif et question, par le formulaire", () => {
    const html = renderToStaticMarkup(createElement(FinalCta));
    expect(anchors(html).map((a) => a.href)).toEqual(["/contact?sujet=tarif", "/contact?sujet=question"]);
    expectNoDemoNorMailto(html);
  });
});

describe("site vitrine : navigation", () => {
  it("les liens de l'en-tête sont des pages (plus des ancres de l'accueil)", () => {
    expect(NAV_LINKS.map((l) => l.href)).toEqual(["/services", "/avantages", "/tarifs", "/faq", "/contact"]);
  });

  it("en-tête : la page affichée est marquée (aria-current) dans la barre et le menu mobile, et seulement elle", () => {
    nav.pathname = "/services";
    const links = anchors(renderToStaticMarkup(createElement(SiteHeader)));
    expect(links.filter((a) => a.current).map((a) => a.href)).toEqual(["/services", "/services"]);
    nav.pathname = "/";
    const home = anchors(renderToStaticMarkup(createElement(SiteHeader)));
    expect(home.filter((a) => a.current).map((a) => a.href)).toEqual(["/"]);
  });

  it("en-tête : « Demander un tarif » (barre et menu) mène au formulaire, sans démo ni mailto", () => {
    nav.pathname = "/tarifs";
    const html = renderToStaticMarkup(createElement(SiteHeader));
    expect(anchors(html).filter((a) => a.href === PRICING_HREF)).toHaveLength(2);
    expect(html).toContain("Demander un tarif");
    expectNoDemoNorMailto(html);
  });

  it("pied de page : toutes les pages, contact par le formulaire, sans démo ni mailto", () => {
    const html = renderToStaticMarkup(createElement(SiteFooter));
    const hrefs = anchors(html).map((a) => a.href);
    for (const href of ["/services", "/avantages", "/services#fonctionnement", "/tarifs", "/faq", "/contact", PRICING_HREF, QUESTION_HREF, "/login"]) {
      expect(hrefs).toContain(href);
    }
    expectNoDemoNorMailto(html);
  });

  it("lien actif : la page ou l'une de ses sous-pages, jamais un simple préfixe", () => {
    expect(isCurrentPage("/services", "/services")).toBe(true);
    expect(isCurrentPage("/services/detail", "/services")).toBe(true);
    expect(isCurrentPage("/servicesx", "/services")).toBe(false);
    expect(isCurrentPage("/", "/services")).toBe(false);
    expect(isCurrentPage(null, "/services")).toBe(false);
  });

  it("anciennes ancres de l'accueil : redirigées vers la page qui a repris la section", () => {
    expect(legacyAnchorTarget("#services")).toBe("/services");
    expect(legacyAnchorTarget("#avantages")).toBe("/avantages");
    expect(legacyAnchorTarget("#fonctionnement")).toBe("/services#fonctionnement");
    expect(legacyAnchorTarget("#tarifs")).toBe("/tarifs");
    expect(legacyAnchorTarget("#faq")).toBe("/faq");
    for (const hash of ["", "#", "#contenu", "#FAQ", "#constructor", "#__proto__"]) expect(legacyAnchorTarget(hash)).toBeNull();
  });
});
