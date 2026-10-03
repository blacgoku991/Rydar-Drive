import { describe, expect, it } from "vitest";
import { bookingSitePublishable, bookingSiteSchema, bookingSiteSchemaFor } from "./schemas";

// Contre-audit « web_api » (web_public#6) : le contrôle des sous-domaines réservés ne s'applique qu'à un CHANGEMENT de
// sous-domaine, comme le trigger SQL booking_sites_reserved_subdomain (migration 004900).

/** Conditions, téléphone et e-mail de la centrale : obligatoires pour un mini-site en ligne (bookingSitePublishable). */
const PUBLISHABLE = {
  phone: "01 23 45 67 89",
  email: "contact@centrale.example",
  legal_mentions: "Élite Paris SAS, 1 rue de l'Exemple, 75001 Paris. Paiement : carte ou espèces à bord. Médiateur : CM2C.",
};
const site = (subdomain: string | null) => ({
  enabled: true, subdomain, primary_color: "#C8F03C", vehicle_categories: ["standard"], show_price_estimate: true, ...PUBLISHABLE,
});

describe("bookingSiteSchemaFor : sous-domaine réservé déjà enregistré", () => {
  it("le même nom (casse et espaces ignorés) passe : les autres réglages s'enregistrent", () => {
    const schema = bookingSiteSchemaFor("rydar-demo");
    expect(schema.safeParse(site("rydar-demo")).success).toBe(true);
    expect(schema.safeParse(site(" Rydar-Demo ")).data?.subdomain).toBe("rydar-demo");
    expect(bookingSiteSchemaFor("support").safeParse(site("support")).success).toBe(true);
  });

  it("un AUTRE nom réservé reste refusé, sur le champ sous-domaine", () => {
    const res = bookingSiteSchemaFor("rydar-demo").safeParse(site("support"));
    expect(res.success).toBe(false);
    expect(res.error?.issues[0]).toMatchObject({ path: ["subdomain"], message: "Nom réservé à la plateforme" });
    expect(bookingSiteSchemaFor("rydar-demo").safeParse(site("rydar-autre")).success).toBe(false);
  });

  it("quitter le nom réservé, ou passer à aucun sous-domaine : accepté", () => {
    expect(bookingSiteSchemaFor("rydar-demo").safeParse(site("centrale-demo")).success).toBe(true);
    expect(bookingSiteSchemaFor("rydar-demo").safeParse(site(null)).success).toBe(true);
  });

  it("sans sous-domaine enregistré (bookingSiteSchema) : tout nom réservé est refusé, le format reste contrôlé", () => {
    expect(bookingSiteSchema.safeParse(site("admin")).success).toBe(false);
    expect(bookingSiteSchemaFor(null).safeParse(site("rydar")).success).toBe(false);
    expect(bookingSiteSchemaFor("rydar-demo").safeParse(site("Pas_Valide!")).success).toBe(false);
    expect(bookingSiteSchema.safeParse(site("elite-paris")).success).toBe(true);
  });
});

// Revue de conformité (mini-sites B2C) : un mini-site n'est mis en ligne qu'avec les informations dues aux clients
// particuliers (C. conso. L111-1, L221-5, L221-14, L612-1) ; hors ligne, ses réglages s'enregistrent librement.
describe("mise en ligne : conditions pour les clients, téléphone et e-mail obligatoires", () => {
  it("en ligne sans conditions (ou trop courtes), sans téléphone ni e-mail : refusé, sur chaque champ", () => {
    const res = bookingSiteSchema.safeParse({ ...site("elite-paris"), legal_mentions: "Paiement à bord.", phone: "", email: "" });
    expect(res.success).toBe(false);
    expect(res.error?.issues.map((i) => i.path[0]).sort()).toEqual(["email", "legal_mentions", "phone"]);
  });

  it("hors ligne : les mêmes réglages incomplets s'enregistrent", () => {
    expect(bookingSiteSchema.safeParse({ ...site("elite-paris"), enabled: false, legal_mentions: "", phone: "", email: "" }).success).toBe(true);
  });

  it("bookingSitePublishable : même règle pour un mini-site publié avant elle (réservation refusée)", () => {
    expect(bookingSitePublishable(PUBLISHABLE)).toBe(true);
    expect(bookingSitePublishable({ ...PUBLISHABLE, legal_mentions: "  court  " })).toBe(false);
    expect(bookingSitePublishable({ ...PUBLISHABLE, phone: null })).toBe(false);
    expect(bookingSitePublishable({ ...PUBLISHABLE, email: " " })).toBe(false);
  });
});
