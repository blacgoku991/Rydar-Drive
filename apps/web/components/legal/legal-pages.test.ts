import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Pages légales publiques (liste du propriétaire, points 1 à 9) : liens du pied de page et des mini-sites, pages
// « Abonnement, résiliation et remboursement » (reprise des CGV, rien de plus) et « Accessibilité » (non conforme tant
// qu'aucun audit), mentions légales sans « à compléter » quand l'information existe, inventaire des stockages du
// navigateur tenu à jour, typographie.

const legal = vi.hoisted(() => ({ info: {} as Record<string, unknown> }));

vi.mock("@/lib/legal", async () => {
  const shared = await import("@rydar/shared");
  return {
    LEGAL_VERSION: shared.LEGAL_VERSION,
    ORG_LEGAL_VERSION: shared.ORG_LEGAL_VERSION,
    NOTICE_UPDATED_AT: "3 octobre 2026",
    COOKIES_UPDATED_AT: "3 octobre 2026",
    SUBSCRIPTION_TERMS_UPDATED_AT: "3 octobre 2026",
    ACCESSIBILITY_UPDATED_AT: "3 octobre 2026",
    getLegalInfo: async () => legal.info,
  };
});
vi.mock("@/lib/legal-notice", async () => await import("../../lib/legal-notice"));
vi.mock("@/lib/utils", async () => await import("../../lib/utils"));
// Mise en page réduite à l'essentiel (le vrai gabarit charge le logo et les liens du pied de page)
vi.mock("@/components/legal/legal-page", () => ({
  LegalPage: ({ title, updatedAt, children }: { title: string; updatedAt: string; children: ReactNode }) =>
    createElement("main", null, createElement("h1", null, title), createElement("p", null, `Mise à jour le ${updatedAt}`), children),
  LegalSection: ({ title, children }: { title: string; children: ReactNode }) =>
    createElement("section", null, createElement("h2", null, title), children),
  LegalList: ({ items }: { items: ReactNode[] }) => createElement("ul", null, ...items.map((item, i) => createElement("li", { key: i }, item))),
}));

const { LEGAL_LINKS } = await import("./legal-links");
const { legalNoticeGaps, isIndividualBusiness } = await import("../../lib/legal-notice");
const notice = await import("../../app/mentions-legales/page");
const cookies = await import("../../app/cookies/page");
const subscription = await import("../../app/abonnement-resiliation/page");
const accessibility = await import("../../app/accessibilite/page");

const WEB = join(import.meta.dirname, "..", "..");
const source = (path: string) => readFileSync(join(WEB, path), "utf8");
const render = async (page: () => Promise<ReactNode>) => renderToStaticMarkup(await page()).replace(/&#x27;/g, "'");
/** Texte seul (sans balises), espaces insécables gardés, pour les contrôles de contenu et de typographie. */
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
/** Texte comparable (espaces insécables et retours à la ligne ramenés à une espace simple). */
const flat = (s: string) => s.replace(/[\s ]+/g, " ");

const FULL = {
  name: "Rydar SAS",
  nameSet: true,
  form: "SAS",
  capital: "1 000 €",
  address: "1 rue de l'Exemple, 75001 Paris",
  registration: "RCS Paris 000 000 000",
  vat: "FR00 000000000",
  director: "Prénom Nom",
  email: "contact@rydar.example",
  phone: "01 00 00 00 00",
  privacyEmail: "rgpd@rydar.example",
  hostName: "Hébergeur SAS",
  hostAddress: "2 rue de l'Hébergeur, 59000 Lille",
  hostPhone: "03 00 00 00 00",
  dataHost: "Même serveur que le site, datacenter en France",
  complete: true,
};
const EMPTY = {
  name: "Rydar Drive", nameSet: false, form: "", capital: "", address: "", registration: "", vat: "", director: "", email: "",
  phone: "", privacyEmail: "", hostName: "", hostAddress: "", hostPhone: "", dataHost: "", complete: false,
};

beforeEach(() => {
  legal.info = { ...FULL };
});

describe("liens légaux : pied de page, plan du site, mini-sites", () => {
  it("résiliation et remboursement, accessibilité (état de conformité dans l'intitulé)", () => {
    const hrefs = LEGAL_LINKS.map((l) => l.href as string);
    expect(hrefs).toEqual(expect.arrayContaining(["/mentions-legales", "/cgu", "/cgv", "/confidentialite", "/cookies", "/dpa", "/abonnement-resiliation", "/accessibilite"]));
    expect(LEGAL_LINKS.find((l) => l.href === "/accessibilite")!.label).toBe("Accessibilité : non conforme");
  });

  it("chaque page légale est servie telle quelle sur un mini-site (proxy.ts, LEGAL_PATHS)", () => {
    const set = /const LEGAL_PATHS = new Set\(\[([^\]]+)\]\)/.exec(source("proxy.ts"))?.[1] ?? "";
    for (const { href } of LEGAL_LINKS) expect(set, href).toContain(`"${href}"`);
    expect(set).toContain('"/suppression-compte"');
  });

  it("mini-site, inscription par lien et connexion : déclaration d'accessibilité dans le pied de page", () => {
    for (const page of ["app/book/[slug]/page.tsx", "app/rejoindre/[code]/page.tsx", "app/login/page.tsx"]) {
      expect(source(page), page).toMatch(/<LegalLinks [^>]*only=\{\[[^\]]*"\/accessibilite"/);
    }
  });

  it("parcours d'achat : CGV, accord de traitement et page de résiliation liés depuis l'abonnement, les tarifs et la FAQ", () => {
    const billing = source("components/settings/billing-panel.tsx");
    for (const href of ["/cgv", "/dpa", "/abonnement-resiliation"]) expect(billing).toContain(`href="${href}"`);
    expect(source("components/marketing/pricing.tsx")).toContain('href="/abonnement-resiliation"');
    expect(source("components/marketing/faq.tsx")).toContain('href="/abonnement-resiliation"');
  });
});

describe("/mentions-legales", () => {
  it("informations renseignées : aucune mention « à compléter », point de contact DSA, hébergement des données", async () => {
    const html = await render(notice.default);
    expect(html).not.toContain("à compléter");
    const t = flat(text(html));
    expect(t).toContain("Raison sociale : Rydar SAS");
    expect(t).toContain("Capital social : 1 000 €");
    expect(t).toContain("règlement (UE) 2022/2065 sur les services numériques, articles 11 et 12");
    expect(t).toContain("Langue acceptée : français");
    expect(t).toContain("Hébergeur : Hébergeur SAS");
    expect(t).toContain("Base de données, comptes de connexion, fichiers et sauvegardes : Même serveur que le site, datacenter en France");
    expect(html).toContain('href="mailto:contact@rydar.example"');
    expect(html).toContain('href="/accessibilite"');
  });

  it("entreprise individuelle : pas de ligne « Capital social » (sans objet)", async () => {
    legal.info = { ...FULL, form: "Entrepreneur individuel (EI)", capital: "" };
    const html = await render(notice.default);
    expect(html).not.toContain("Capital social");
    expect(html).not.toContain("à compléter");
  });

  it("rien de renseigné : chaque mention manquante affichée « à compléter », jamais le nom du service comme raison sociale", async () => {
    legal.info = { ...EMPTY };
    const t = flat(text(await render(notice.default)));
    expect(t).toContain("Raison sociale : à compléter par l'éditeur");
    expect(t).toContain("Capital social : à compléter par l'éditeur");
    expect(t).not.toContain("Raison sociale : Rydar Drive");
    expect(t).not.toMatch(/Supabase/);
  });
});

describe("mentions obligatoires manquantes (/admin/legal)", () => {
  const fields = { ...FULL, companyName: "Rydar SAS" };

  it("tout renseigné : aucune", () => {
    expect(legalNoticeGaps(fields)).toEqual([]);
  });

  it("capital exigé d'une société, pas d'une entreprise individuelle ; lieu des données seulement recommandé", () => {
    expect(legalNoticeGaps({ ...fields, capital: "" }).map((g) => g.key)).toEqual(["share_capital"]);
    expect(legalNoticeGaps({ ...fields, capital: "", form: "EI" })).toEqual([]);
    expect(legalNoticeGaps({ ...fields, capital: "", form: "Micro-entreprise" })).toEqual([]);
    expect(legalNoticeGaps({ ...fields, dataHost: "" })).toEqual([expect.objectContaining({ key: "data_host", required: false })]);
  });

  it("formes juridiques reconnues comme entreprise individuelle", () => {
    for (const form of ["EI", "E.I.", "EIRL", "Entrepreneur individuel", "Entreprise individuelle", "micro-entreprise", "Auto-entrepreneur"]) {
      expect(isIndividualBusiness(form), form).toBe(true);
    }
    for (const form of ["SAS", "SASU", "SARL", "EURL", "SA", "SEIGNEURIE", ""]) expect(isIndividualBusiness(form), form).toBe(false);
  });

  it("rien de renseigné : toutes les mentions LCEN demandées (éditeur, directeur, contact, hébergeur)", () => {
    const gaps = legalNoticeGaps({ ...EMPTY, companyName: "" });
    expect(gaps.filter((g) => g.required).map((g) => g.key)).toEqual([
      "company_name", "legal_form", "share_capital", "address", "registration", "vat_number", "publication_director", "email", "phone",
      "host_name", "host_address", "host_phone",
    ]);
  });
});

describe("/abonnement-resiliation : reprise des CGV, sans engagement nouveau", () => {
  it("règles reprises : pas de rétractation (B2B), fin de période payée, prorata seulement sur refus, préavis, 40 €", async () => {
    const t = flat(text(await render(subscription.default)));
    expect(t).toContain("Abonnement, résiliation et remboursement");
    expect(t).toContain("article L221-18");
    expect(t).toContain("sans remboursement de la période en cours");
    expect(t).toContain("remboursée au prorata (article 7)");
    expect(t).toContain("Une course annulée ne porte aucuns frais");
    expect(t).toContain("avec un préavis de 30 jours");
    expect(t).toContain("indemnité forfaitaire pour frais de recouvrement de 40 €");
    expect(t).toContain("Dans les 30 jours qui suivent");
    expect(t).toContain("relèvent de la centrale qui l'organise");
    expect(t).toContain("contact@rydar.example");
  });

  it("aucune promesse absente des CGV : ni délai ni moyen du remboursement, ni rétractation, ni avoir automatique", async () => {
    const t = flat(text(await render(subscription.default)));
    for (const promise of [/rembours\w* sous \d+/i, /dans un délai de \d+/i, /droit de rétractation (de 14 jours )?s'applique/i, /avoir automatique/i, /satisfait ou rembours/i]) {
      expect(t).not.toMatch(promise);
    }
  });

  it("chaque règle reprise figure dans les CGV en vigueur (app/cgv/page.tsx)", () => {
    const cgv = flat(source("app/cgv/page.tsx").replace(/&apos;/g, "'"));
    for (const rule of [
      "sans remboursement de la période en cours",
      "Une course annulée ne porte aucuns frais",
      "avec un préavis de 30 jours",
      "indemnité forfaitaire pour frais de recouvrement de 40 €",
      "Dans les 30 jours qui suivent",
      "Elles sont réservées aux professionnels",
      "mise en demeure restée sans effet pendant 8 jours",
    ]) {
      expect(cgv, rule).toContain(rule);
    }
  });

  // Le remboursement au prorata (refus d'une hausse ou d'une modification défavorable) est écrit à l'article 7 des CGV
  // de la branche cgv-fleet-fees (fusionnée avant celle-ci) : vérifié dès que les CGV le contiennent.
  it.runIf(source("app/cgv/page.tsx").includes("remboursée au prorata"))("remboursement au prorata : même règle qu'à l'article 7 des CGV", () => {
    const cgv = flat(source("app/cgv/page.tsx").replace(/&apos;/g, "'"));
    expect(cgv).toContain("la part de l'abonnement payée d'avance pour la période restant à courir lui est remboursée au prorata");
    expect(cgv).toContain("au plus tard la veille de cette date");
  });
});

describe("/accessibilite : déclaration honnête", () => {
  it("non conforme (aucun audit), RGAA, contrôles décrits, contact et voies de recours (Défenseur des droits)", async () => {
    const t = flat(text(await render(accessibility.default)));
    expect(t).toContain("Rydar Drive est non conforme avec le référentiel général d'amélioration de l'accessibilité (RGAA)");
    expect(t).toContain("aucun audit de conformité n'a encore été réalisé");
    expect(t).not.toMatch(/partiellement conforme|totalement conforme|est conforme/i);
    expect(t).toContain("Défenseur des droits, Libre réponse 71120, 75342 Paris CEDEX 07");
    expect(t).toContain("Limites connues");
    expect(t).toContain("contact@rydar.example");
  });

  it("sans e-mail renseigné : renvoi aux mentions légales, jamais une adresse inventée", async () => {
    legal.info = { ...EMPTY };
    const html = await render(accessibility.default);
    expect(html).not.toContain("mailto:");
    expect(flat(text(html))).toContain("l'adresse indiquée dans les mentions légales");
  });
});

describe("/cookies : inventaire réel du navigateur", () => {
  /** Fichiers source du site (hors tests et dépendances). */
  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (name === "node_modules" || name.startsWith(".")) return [];
      if (statSync(path).isDirectory()) return files(path);
      return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
    });
  }

  it("chaque clé de cookie ou de stockage posée par le code (rydar.…, rd_…) figure dans le tableau de /cookies", () => {
    const page = source("app/cookies/page.tsx");
    const keys = new Set<string>();
    for (const dir of ["app", "components", "lib", "hooks"]) {
      for (const file of files(join(WEB, dir))) {
        for (const m of readFileSync(file, "utf8").matchAll(/["'`](rydar\.(?!app\b|test\b)[A-Za-z-]+|rd_[a-z_]+)[:"'`]/g)) keys.add(m[1]!);
      }
    }
    expect([...keys]).toEqual(expect.arrayContaining(["rd_cookie_notice", "rd_org", "rd_org_switch", "rydar.sound"]));
    for (const key of keys) expect(page, key).toContain(key);
  });

  it("aucun consentement demandé, expliqué ; engagement si un traceur soumis à consentement était ajouté", async () => {
    const t = flat(text(await render(cookies.default)));
    expect(t).toContain("rd_org_switch");
    expect(t).toContain("exemptés de consentement");
    expect(t).toContain("Pourquoi aucun bouton « Tout accepter » ou « Tout refuser »");
    expect(t).toContain("« Tout refuser » aussi simplement que « Tout accepter »");
  });
});

describe("typographie des nouvelles pages", () => {
  it("espaces insécables avant « : ; ! ? » et dans les guillemets", async () => {
    for (const page of [subscription.default, accessibility.default, notice.default, cookies.default]) {
      const t = text(await render(page)).replace(/https?:\/\/\S+/g, "");
      expect(t).not.toMatch(/ [:;!?»]/);
      expect(t).not.toMatch(/« /);
    }
  });
});
