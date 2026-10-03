import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// Pages /cgv (version en vigueur, ORG_LEGAL_VERSION) et /cgv/2026-09-27 (version précédente, page figée) : version
// affichée, préambule (entrée en vigueur au plus tard, résiliation), lien entre les deux, typographie, mentions que
// le code impose (frais TTC, hausse annoncée 30 jours à l'avance ou sur accord écrit, blocage).

vi.mock("@/lib/legal", async () => {
  const shared = await import("@rydar/shared");
  return {
    LEGAL_VERSION: shared.LEGAL_VERSION,
    ORG_LEGAL_VERSION: shared.ORG_LEGAL_VERSION,
    ORG_LEGAL_EFFECTIVE_AT: shared.ORG_LEGAL_EFFECTIVE_AT,
    CGV_UPDATED_AT: "2 octobre 2026",
    getLegalInfo: async () => ({ name: "Rydar SAS", email: "contact@rydar.example" }),
  };
});
// Mise en page réduite à l'essentiel (le vrai gabarit charge le logo et les liens du pied de page)
vi.mock("@/components/legal/legal-page", () => ({
  LegalPage: ({ title, updatedAt, children }: { title: string; updatedAt: string; children: ReactNode }) =>
    createElement("main", null, createElement("h1", null, title), createElement("p", null, `Mise à jour le ${updatedAt}`), children),
  LegalSection: ({ title, children }: { title: string; children: ReactNode }) =>
    createElement("section", null, createElement("h2", null, title), children),
  LegalList: ({ items }: { items: ReactNode[] }) => createElement("ul", null, ...items.map((item, i) => createElement("li", { key: i }, item))),
}));

const current = await import("../../app/cgv/page");
const previous = await import("../../app/cgv/2026-09-27/page");

const render = async (page: () => Promise<ReactNode>) => renderToStaticMarkup(await page()).replace(/&#x27;/g, "'");
/** Texte seul (sans balises), pour les contrôles de typographie. */
const text = (html: string) => html.replace(/<[^>]+>/g, " ");

describe("/cgv : version en vigueur (2 octobre 2026)", () => {
  it("version, ce qui change, entrée en vigueur au plus tard et lien vers la version précédente", async () => {
    const html = await render(current.default);
    expect(html).toContain("Version 2026-10-02.");
    expect(html).toContain("Ce qui change par rapport à la version du 27 septembre 2026");
    expect(html).toContain("aux flottes comme aux centrales à commission");
    expect(html).toContain("dès son acceptation dans le tableau de bord, et au plus tard le 5 novembre 2026");
    expect(html).toContain("elle peut résilier le contrat sans frais avant cette date");
    expect(html).toContain('href="/cgv/2026-09-27"');
    expect(html).toContain("Version précédente (27 septembre 2026)");
  });

  it("frais par course : TTC, hausse annoncée 30 jours à l'avance ou sur accord écrit, règles du code", async () => {
    const html = await render(current.default);
    expect(html).toContain("Le prix de l'abonnement est exprimé hors taxes");
    expect(html).toContain("Les frais sont exprimés toutes taxes comprises");
    expect(html).toContain("un pourcentage du prix de la course, un montant fixe par course, ou les deux");
    expect(html).toContain("au moins 30 jours avant sa date d'effet, ou s'applique dès son enregistrement si la centrale en a donné son accord écrit");
    expect(html).toContain("sans frais et sans le préavis de l'article 7");
    expect(html).toContain("facture récapitulative des frais du cycle");
    expect(html).toContain("un avoir ou la correction d'une erreur de calcul des frais");
    expect(html).toContain("virement sur l'IBAN de l'éditeur");
    expect(html).toContain("menu «\u00a0Encaissements\u00a0» en modèle centrale à commission, «\u00a0Frais Rydar\u00a0» en modèle flotte");
    expect(html).toContain("comptés depuis la première déclaration de paiement des 30 derniers jours");
    expect(html).toContain("y compris lorsque l'option réseau partagé est activée");
    // Formulations retirées après revue
    for (const old of ["prélevés", "et/ou", "selon l'offre choisie", "n'en porte aucun", "virement sur son IBAN"]) expect(html).not.toContain(old);
  });

  it("typographie : espaces insécables avant « : ; ! ? » et dans les guillemets", async () => {
    const t = text(await render(current.default));
    expect(t).not.toMatch(/ [:;!?»]/);
    expect(t).not.toMatch(/« /);
  });
});

describe("/cgv/2026-09-27 : version précédente, figée", () => {
  it("texte d'origine (frais réservés au modèle centrale), version figée, lien vers la version en vigueur", async () => {
    const html = await render(previous.default);
    expect(html).toContain("Version 2026-09-27.");
    expect(html).toContain("Mise à jour le 27 septembre 2026");
    expect(html).toContain("Version remplacée le 2 octobre 2026.");
    expect(html).toContain('href="/cgv"');
    expect(html).toContain("5. Frais plateforme (modèle centrale)");
    expect(html).not.toContain("2026-10-02");
    const t = text(html);
    expect(t).not.toMatch(/ [:;!?»]/);
    expect(t).not.toMatch(/« /);
  });

  it("non indexée", () => {
    expect(previous.metadata.robots).toMatchObject({ index: false });
    expect(current.metadata.robots).toBeUndefined();
  });
});
