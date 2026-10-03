import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NETWORK_DOCUMENTS, NETWORK_FORBIDDEN_WORDS, NETWORK_POSITIONING, NETWORK_TERMS_REVIEWED } from "@rydar/shared";
import { describe, expect, it } from "vitest";
import { NETWORK_CONVENTION, NETWORK_DRIVER_TERMS, NETWORK_TERMS_REVIEW_NOTICE, documentTexts } from "./network-terms";

// Textes publics du réseau partagé (spec §7.1 à §7.3) : vocabulaire (Rydar est un logiciel), décisions du propriétaire
// (Q1, Q2, Q5), version affichée, pages servies telles quelles sur les mini-sites.

const WEB = join(__dirname, "../..");
const all = [...documentTexts(NETWORK_CONVENTION), ...documentTexts(NETWORK_DRIVER_TERMS), NETWORK_TERMS_REVIEW_NOTICE];
const join_ = (doc: typeof NETWORK_CONVENTION) => documentTexts(doc).join("\n");

describe("vocabulaire : Rydar est un logiciel de dispatch (§7.1)", () => {
  it("aucun mot interdit, dans les textes comme dans les fichiers des pages", () => {
    const sources = [
      "components/legal/network-terms.ts",
      "components/legal/network-terms-page.tsx",
      "app/reseau-partage/conditions/page.tsx",
      "app/reseau-partage/chauffeur/page.tsx",
    ].map((p) => readFileSync(join(WEB, p), "utf8").toLowerCase());
    for (const word of NETWORK_FORBIDDEN_WORDS) {
      expect(all.filter((t) => t.toLowerCase().includes(word)), word).toEqual([]);
      for (const src of sources) expect(src.includes(word), word).toBe(false);
    }
  });

  it("positionnement repris mot pour mot dans les deux documents", () => {
    expect(join_(NETWORK_CONVENTION)).toContain(NETWORK_POSITIONING);
    expect(join_(NETWORK_DRIVER_TERMS)).toContain(NETWORK_POSITIONING);
    expect(NETWORK_POSITIONING).toContain("Rydar ne choisit ni l'organisation partenaire ni le chauffeur");
    expect(NETWORK_POSITIONING).toContain("n'encaisse aucune somme");
    expect(join_(NETWORK_CONVENTION)).toContain("vérification administrative de l'inscription au registre des exploitants VTC");
  });
});

describe("convention entre organisations (§7.2)", () => {
  const text = join_(NETWORK_CONVENTION);

  it("clauses attendues : ses chauffeurs d'abord, vendeur, conformité, mandat et garantie, délais, relevé, non-sollicitation, RGPD, retrait", () => {
    for (const clause of [
      "Ses chauffeurs d'abord",
      "Elle est le vendeur",
      "registre des exploitants VTC",
      "pour le compte de l'organisation exécutante",
      "est garante envers l'organisation qui confie",
      "jamais moins de 48 heures",
      "sous 7 jours",
      "relevé mensuel par partenaire",
      "ne démarchent pas les clients",
      "article 28.3 du RGPD",
      "responsable distincte",
      "Les litiges entre organisations se règlent entre elles",
      "délai de grâce",
    ]) {
      expect(text, clause).toContain(clause);
    }
  });

  it("Q1 : l'organisation exécutante ne prend rien ; Q2 : c'est toujours le chauffeur qui règle ou qui est payé", () => {
    expect(text).toContain("Elle ne prélève rien sur les courses partagées");
    expect(text).toContain("c'est le chauffeur qui règle ou qui est payé");
    expect(text).not.toMatch(/\(ou [^)]*elle-même\)/);
  });

  it("contestation d'une course : versement annulé, reversement dû ; baisse des frais Rydar jamais acquise faute de réponse", () => {
    expect(text).toContain("le versement prévu au chauffeur (client qui a déjà payé) est annulé, ce que le chauffeur doit reverser (client payé à bord) reste dû");
    expect(text).toContain("Cette baisse n'est jamais acquise faute de réponse : les frais restent dus tant que l'éditeur ne l'a pas acceptée");
  });

  it("Q5 : l'organisation exécutante ne voit ni le client ni la position de son chauffeur pendant la course", () => {
    expect(text).toContain("ne voit jamais le client ni l'adresse exacte");
    expect(text).toContain("elle ne voit pas la position de son chauffeur pendant la course partagée");
  });
});

describe("conditions des chauffeurs (§7.3)", () => {
  const text = join_(NETWORK_DRIVER_TERMS);

  it("texte de base de la spec, adapté aux décisions du propriétaire", () => {
    expect(text).toContain("Vous faites la course pour le compte de votre organisation");
    expect(text).toContain("vous réglez la part de l'organisation qui vous confie la course, pour le compte de votre organisation, avec les moyens de paiement qu'elle propose");
    expect(text).toContain("l'organisation qui vous confie la course vous verse votre part.");
    expect(text).toContain("Elle reçoit votre prénom, l'initiale de votre nom, votre véhicule, votre plaque, votre téléphone et le numéro de votre carte VTC.");
    expect(text).toContain("Vous pouvez arrêter à tout moment dans votre profil.");
  });

  it("Q2 : chaque chauffeur accepte et règle lui-même (jamais « J'ai compris », jamais « ou à votre organisation »)", () => {
    expect(text).toContain("Chaque chauffeur accepte ces conditions lui-même");
    expect(text).not.toMatch(/j'ai compris/i);
    expect(text).not.toMatch(/ou à votre organisation/i);
  });

  it("un seul montant : jamais « commission » ni frais de l'éditeur côté chauffeur (U4)", () => {
    expect(text).not.toMatch(/commission/i);
    expect(text).not.toMatch(/frais/i);
    expect(text).toContain("un seul montant");
  });

  it("Q5 et minimisation : position non montrée, client visible une heure avant", () => {
    expect(text).toContain("Votre organisation ne voit pas votre position pendant une course partagée");
    expect(text).toContain("à partir d'une heure avant la prise en charge");
  });
});

describe("version, relecture, pages servies sur les mini-sites", () => {
  it("version affichée dans l'introduction des deux documents", () => {
    expect(NETWORK_CONVENTION.intro.join(" ")).toContain("Version {version}");
    expect(NETWORK_DRIVER_TERMS.intro.join(" ")).toContain("Version {version}");
  });

  it("bandeau de relecture tant que le texte n'est pas relu", () => {
    expect(NETWORK_TERMS_REVIEWED).toBe(false);
    expect(NETWORK_TERMS_REVIEW_NOTICE).toMatch(/^Texte en cours de relecture juridique/);
    const page = readFileSync(join(WEB, "components/legal/network-terms-page.tsx"), "utf8");
    expect(page).toContain("!NETWORK_TERMS_REVIEWED &&");
  });

  it("chemins du contrat = pages existantes, servies telles quelles sur les mini-sites (proxy.ts)", () => {
    const proxy = readFileSync(join(WEB, "proxy.ts"), "utf8");
    for (const doc of Object.values(NETWORK_DOCUMENTS)) {
      expect(existsSync(join(WEB, "app", doc.path, "page.tsx")), doc.path).toBe(true);
      expect(proxy).toContain(`"${doc.path}"`);
    }
  });
});
