import { ORG_LEGAL_CHANGES } from "@rydar/shared";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// Pages /cgv (version en vigueur, ORG_LEGAL_VERSION) et /cgv/2026-09-27 (version précédente, page figée) : version
// affichée, préambule (entrée en vigueur au plus tard, résiliation), lien entre les deux, typographie, mentions que
// le code impose (frais TTC, hausse annoncée 30 jours à l'avance ou sur accord écrit, blocage).

vi.mock("@/components/marketing/typo", async () => await import("../marketing/typo"));
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
  it("version, principaux changements (défavorables compris), entrée en vigueur au plus tard et lien vers la version précédente", async () => {
    const html = await render(current.default);
    const t = text(html).replace(/\s+/g, " ");
    expect(html).toContain("Version 2026-10-02.");
    expect(html).toContain("Principaux changements par rapport à la version du 27 septembre 2026");
    // Même liste que le bandeau et l'e-mail d'annonce (typographie française à l'affichage)
    for (const change of ORG_LEGAL_CHANGES) {
      const plain = (s: string) => s.replace(/\u00a0/g, " ");
      expect(plain(t)).toContain(plain(change));
    }
    expect(html).toContain("aux flottes comme aux centrales à commission");
    expect(html).toContain("n'attend plus le renouvellement de l'abonnement");
    expect(html).toContain("dès son acceptation dans le tableau de bord, et au plus tard le 5 novembre 2026");
    expect(html).toContain("elle peut résilier le contrat sans frais ni préavis avant cette date, avec remboursement au prorata");
    expect(html).toContain('href="/cgv/2026-09-27"');
    expect(html).toContain("Version précédente (27 septembre 2026)");
  });

  it("frais par course : TTC, hausse annoncée 30 jours à l'avance ou sur accord écrit, règles du code", async () => {
    const html = await render(current.default);
    expect(html).toContain("Le prix de l'abonnement est exprimé hors taxes");
    expect(html).toContain("Les frais sont exprimés toutes taxes comprises");
    expect(html).toContain("un pourcentage du prix de la course, un montant fixe par course, ou les deux");
    expect(html).toContain("au moins 30 jours avant sa date d'effet, ou s'applique dès son enregistrement si la centrale en a donné son accord écrit");
    expect(html).toContain("sans frais et sans préavis, dans les conditions de l'article 7");
    expect(html).toContain("facture récapitulative des frais du cycle");
    expect(html).toContain("Une hausse dont l'e-mail d'annonce n'est pas parti au moins 30 jours avant sa date d'effet ne s'applique pas.");
    expect(html).toContain("communiqués par e-mail au propriétaire");
    // Taxes : rien n'est ajouté aux frais, mais les pénalités de retard (art. 6) restent dues
    expect(html).toContain("aucune taxe ne s'y ajoute (en cas de retard, les pénalités et l'indemnité de l'article 6 restent dues)");
    // Baisse : refus seulement motivé, acceptée sans décision sous 30 jours
    expect(html).toContain("qui ne peut la refuser que si elle ne correspond pas à la course réellement effectuée et payée");
    expect(html).toContain("sans décision dans les 30 jours, elle est acceptée");
    expect(html).toContain("de 5 jours par défaut et de 45 jours au plus");
    // Résiliation pour refus d'une hausse ou d'une modification défavorable : date choisie, remboursement au prorata
    expect(html).toContain("au plus tard la veille de cette date, et la part de l'abonnement payée d'avance pour la période restant à courir lui est remboursée au prorata");
    expect(html).toContain("sans remboursement de la période en cours, sauf résiliation pour refus d'une hausse des frais");
    expect(html).toContain("un avoir ou la correction d'une erreur de calcul des frais");
    expect(html).toContain("virement sur l'IBAN de l'éditeur");
    expect(html).toContain("menu «\u00a0Encaissements\u00a0» en modèle centrale à commission, «\u00a0Frais Rydar\u00a0» en modèle flotte");
    expect(html).toContain("comptés depuis la première déclaration de paiement des 30 derniers jours");
    expect(html).toContain("y compris lorsque l'option réseau partagé est activée");
    // Formulations retirées après revue
    for (const old of ["prélevés", "et/ou", "selon l'offre choisie", "n'en porte aucun", "virement sur son IBAN", "rien ne s'y ajoute", "Ce qui change"]) {
      expect(html).not.toContain(old);
    }
  });

  it("typographie : espaces insécables avant « : ; ! ? » et dans les guillemets", async () => {
    const t = text(await render(current.default));
    expect(t).not.toMatch(/ [:;!?»]/);
    expect(t).not.toMatch(/« /);
  });
});

// Relecture juridique du 4 octobre 2026 (texte corrigé sur place, même ORG_LEGAL_VERSION) : chaque engagement décrit
// le code (interdiction plateforme réservée à la fraude, refus WhatsApp du propriétaire, suspension motivée, purge non
// outillée retirée).
describe("/cgv : relecture du 4 octobre 2026", () => {
  it("qualification, évolution du service, signalements, garantie, responsabilité, dispositions générales", async () => {
    const t = text(await render(current.default)).replace(/[\s\u00a0]+/g, " ");
    for (const rule of [
      "9 bis. Évolution du service",
      "10 bis. Signalements et interdiction sur la plateforme",
      "18. Dispositions générales",
      "le logiciel n'applique aucune sanction automatique à un refus ou à une absence de réponse",
      "en les conservant, elle les fait siens",
      "l'éditeur agit comme hébergeur au sens de l'article 6 de la loi n° 2004-575 du 21 juin 2004",
      "ni ses chauffeurs ni ses clients ne sont débiteurs de l'éditeur",
      "sauf si le propriétaire a refusé ce canal (article 10)",
      "le propriétaire peut s'y opposer à tout moment en écrivant à l'éditeur, qui le note",
      "L'éditeur ne suspend pas un compte pendant qu'un chauffeur est en route ou qu'un client est à bord.",
      "Le fondement et le motif de la suspension sont affichés au propriétaire et aux administrateurs.",
      "articles L7341-1 et suivants du Code du travail",
      "ou 1 000 €",
      "Toute action contre l'éditeur se prescrit par un an",
      "tribunal de commerce ou tribunal des activités économiques",
      "une dette, un comportement ou un différend reste propre à la centrale et n'est jamais communiqué aux autres centrales",
    ]) {
      expect(t, rule).toContain(rule);
    }
    for (const old of ["selon sa procédure interne documentée", "ne les sélectionne pas", "si ce canal est activé"]) {
      expect(t, old).not.toContain(old);
    }
  });
});

describe("/cgv/2026-09-27 : version précédente, figée", () => {
  it("texte d'origine (frais réservés au modèle centrale), version figée, lien vers la version en vigueur", async () => {
    const html = await render(previous.default);
    expect(html).toContain("Version 2026-09-27.");
    expect(html).toContain("Mise à jour le 27 septembre 2026");
    expect(html).toContain("Version remplacée par celle du 2 octobre 2026.");
    expect(html).not.toContain("remplacée le 2 octobre");
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
