import { LEGAL_VERSION, ORG_LEGAL_CHANGES, ORG_LEGAL_VERSION } from "@rydar/shared";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { orgTermsGate, termsBannerChoice } from "./terms-state";

// Bandeaux d'acceptation du tableau de bord, versions séparées : CGV + accord de traitement au nom de l'organisation
// (ORG_LEGAL_VERSION, owner / admin), CGU + politique de confidentialité à titre personnel (LEGAL_VERSION, tout membre).

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }) }));
vi.mock("@/app/dashboard/actions", () => ({ acceptOrgTerms: vi.fn(), acceptUserTerms: vi.fn() }));
vi.mock("@/lib/run-action", () => ({ runAction: (fn: () => unknown) => fn() }));
vi.mock("@/lib/utils", async () => await import("../../lib/utils"));
vi.mock("@/components/ui/button", async () => await import("../ui/button"));
vi.mock("@/components/marketing/typo", async () => await import("../marketing/typo"));

const { OrgTermsGate, TermsBanner, UserTermsBanner } = await import("./terms-banner");

const both = ["cgu", "privacy"];

describe("bandeau à afficher (un seul à la fois)", () => {
  it("owner / admin : organisation qui n'a jamais accepté → bandeau de l'organisation, première acceptation", () => {
    expect(termsBannerChoice({ admin: true, orgVersions: [], userDocuments: [] })).toEqual({ kind: "org", updated: false });
    // Version « postérieure » ou texte libre du registre : sans valeur
    expect(termsBannerChoice({ admin: true, orgVersions: ["9999-12-31", "v1"], userDocuments: both })).toEqual({ kind: "org", updated: false });
  });

  it("owner / admin : organisation qui avait accepté une version antérieure → bandeau « mise à jour »", () => {
    // Cas de la version 2026-10-02 : tout avait été accepté le 27/09 (CGU et politique comprises)
    expect(termsBannerChoice({ admin: true, orgVersions: ["2026-09-27"], userDocuments: both })).toEqual({ kind: "org", updated: true });
    expect(termsBannerChoice({ admin: true, orgVersions: ["2026-09-27", "2026-09-27"], userDocuments: [] })).toEqual({ kind: "org", updated: true });
  });

  it("owner / admin : version en vigueur acceptée par l'organisation → reste le bandeau personnel des CGU s'il manque", () => {
    expect(termsBannerChoice({ admin: true, orgVersions: ["2026-09-27", ORG_LEGAL_VERSION], userDocuments: both })).toBeNull();
    expect(termsBannerChoice({ admin: true, orgVersions: [ORG_LEGAL_VERSION], userDocuments: ["cgu"] })).toEqual({ kind: "user" });
    expect(termsBannerChoice({ admin: true, orgVersions: [ORG_LEGAL_VERSION], userDocuments: [] })).toEqual({ kind: "user" });
  });

  it("dispatcher : jamais le bandeau de l'organisation, seulement les CGU + politique (LEGAL_VERSION)", () => {
    expect(termsBannerChoice({ admin: false, orgVersions: null, userDocuments: [] })).toEqual({ kind: "user" });
    expect(termsBannerChoice({ admin: false, orgVersions: null, userDocuments: ["privacy"] })).toEqual({ kind: "user" });
    // Accepté le 27/09 : rien de nouveau (les CGV du 2 octobre ne concernent que l'organisation)
    expect(LEGAL_VERSION).toBe("2026-09-27");
    expect(termsBannerChoice({ admin: false, orgVersions: null, userDocuments: both })).toBeNull();
  });

  it("lecture en échec : pas de bandeau de ce type (non bloquant)", () => {
    expect(termsBannerChoice({ admin: true, orgVersions: null, userDocuments: both })).toBeNull();
    expect(termsBannerChoice({ admin: true, orgVersions: null, userDocuments: [] })).toEqual({ kind: "user" });
    expect(termsBannerChoice({ admin: false, orgVersions: null, userDocuments: null })).toBeNull();
  });

  it("acceptation exigée avant la première course : jamais acceptées et aucune course seulement", () => {
    const never = termsBannerChoice({ admin: true, orgVersions: [], userDocuments: [] });
    expect(orgTermsGate(never, false)).toBe(true);
    // Déjà en service, ou lecture des courses en échec : bandeau non bloquant
    expect(orgTermsGate(never, true)).toBe(false);
    expect(orgTermsGate(never, null)).toBe(false);
    // Version antérieure acceptée (mise à jour) : jamais bloquant ; dispatcher, version en vigueur : rien
    expect(orgTermsGate(termsBannerChoice({ admin: true, orgVersions: ["2026-09-27"], userDocuments: both }), false)).toBe(false);
    expect(orgTermsGate(termsBannerChoice({ admin: false, orgVersions: null, userDocuments: [] }), false)).toBe(false);
    expect(orgTermsGate(termsBannerChoice({ admin: true, orgVersions: [ORG_LEGAL_VERSION], userDocuments: both }), false)).toBe(false);
  });
});

describe("textes des bandeaux", () => {
  const render = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

  it("organisation, première acceptation : CGV, accord de traitement, CGU et politique, sans annonce de mise à jour", () => {
    const html = render(createElement(TermsBanner, { orgName: "Elite VTC" }));
    for (const href of ["/cgv", "/dpa", "/cgu", "/confidentialite"]) expect(html).toContain(`href="${href}"`);
    expect(html).toContain('<span class="text-fg">Elite VTC</span>, les ');
    expect(html).not.toContain("Nouvelles conditions");
    expect(html).not.toContain("nouvelle version");
  });

  it("organisation, mise à jour : principaux changements (défavorables compris), entrée en vigueur au plus tard, résiliation sans frais", () => {
    const html = render(createElement(TermsBanner, { orgName: "Elite VTC", updated: true })).replace(/&#x27;/g, "'");
    const plain = (s: string) => s.replace(/\u00a0/g, " ");
    // Espaces insécables avant « : » et « ; » (comme le préambule des CGV)
    expect(html).toContain("Nouvelles conditions générales de vente (version du 2 octobre 2026)\u00a0:");
    // Même liste que le préambule des CGV et l'e-mail d'annonce
    for (const change of ORG_LEGAL_CHANGES) expect(plain(html)).toContain(plain(change));
    expect(html).toContain("aux flottes comme aux centrales à commission");
    expect(html).toContain("(articles 3 à 5)\u00a0;");
    expect(html).toContain("au plus tard le 5 novembre 2026\u00a0;");
    expect(html).toContain("résilier sans frais ni préavis avant cette date, avec remboursement au prorata");
    expect(html).toContain('href="/cgv#changements"');
    expect(html).toContain(">Lire les nouvelles CGV</a>");
    expect(html).toContain('<span class="text-fg">Elite VTC</span>, la nouvelle version des ');
    for (const href of ["/cgv", "/dpa", "/cgu", "/confidentialite"]) expect(html).toContain(`href="${href}"`);
    const t = html.replace(/<[^>]+>/g, " ");
    expect(t).not.toMatch(/ [:;!?»]/);
    expect(t).not.toMatch(/« /);
  });

  it("organisation, mise à jour, date d'entrée en vigueur passée : « en vigueur depuis », plus de résiliation sans frais avant", () => {
    const html = render(createElement(TermsBanner, { orgName: "Elite VTC", updated: true, effectivePassed: true }));
    expect(html).toContain("Pour votre organisation, elles sont en vigueur depuis le 5 novembre 2026.");
    expect(html).not.toContain("au plus tard");
    expect(html).not.toContain("résilier sans frais");
  });

  it("acceptation avant la première course : écran plein, mêmes documents, case à cocher", () => {
    const html = render(createElement(OrgTermsGate, { orgName: "Nouvelle Flotte" }));
    expect(html).toContain("Conditions à accepter avant votre première course");
    expect(html).toContain('<span class="text-fg">Nouvelle Flotte</span>, les ');
    for (const href of ["/cgv", "/dpa", "/cgu", "/confidentialite"]) expect(html).toContain(`href="${href}"`);
    expect(html).toContain('type="checkbox"');
  });

  it("membre : CGU et politique de confidentialité seulement", () => {
    const html = render(createElement(UserTermsBanner));
    expect(html).toContain('href="/cgu"');
    expect(html).toContain('href="/confidentialite"');
    expect(html).not.toContain('href="/cgv"');
    expect(html).not.toContain('href="/dpa"');
  });
});
