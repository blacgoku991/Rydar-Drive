import { describe, expect, it } from "vitest";
import { bookingSiteSchema, bookingSiteSchemaFor } from "./schemas";

// Contre-audit « web_api » (web_public#6) : le contrôle des sous-domaines réservés ne s'applique qu'à un CHANGEMENT de
// sous-domaine, comme le trigger SQL booking_sites_reserved_subdomain (migration 004900).

const site = (subdomain: string | null) => ({
  enabled: true, subdomain, primary_color: "#C8F03C", vehicle_categories: ["standard"], show_price_estimate: true,
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
