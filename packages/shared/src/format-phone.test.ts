import { describe, expect, it } from "vitest";
import { joinApplicationSchema, normalizePhone, phoneSchema } from "./index";

// Audit « bannissement » (sql-rpc-argent#2, flux-comptes#4) : le même numéro écrit autrement ne doit plus
// contourner un bannissement (empreinte = private.identity_normalize, mêmes règles).
describe("normalizePhone : préfixe national après l'indicatif", () => {
  it("« (0) » et 0 après +33 retirés : même numéro que « 06… »", () => {
    for (const input of [
      "06 33 33 33 33",
      "+33 (0)6 33 33 33 33",
      "+33(0)633333333",
      "+33 ( 0 ) 6 33 33 33 33",
      "+33 06 33 33 33 33",
      "+33 0 6 33 33 33 33",
      "0033 (0)6 33 33 33 33",
      "0033 06 33 33 33 33",
      "+33.6.33.33.33.33",
      "33 6 33 33 33 33",
    ]) {
      expect(normalizePhone(input), input).toBe("+33633333333");
    }
  });

  it("DOM (numérotation française) : 0 retiré après +262 / +590 / +594 / +596", () => {
    expect(normalizePhone("+262 (0)692 12 34 56")).toBe("+262692123456");
    expect(normalizePhone("+590 0690 12 34 56")).toBe("+590690123456");
    expect(normalizePhone("+594 694 12 34 56")).toBe("+594694123456");
  });

  it("autres pays : « (0) » retiré, 0 significatif conservé (Italie)", () => {
    expect(normalizePhone("+44 (0)20 7946 0958")).toBe("+442079460958");
    expect(normalizePhone("+39 06 1234 5678")).toBe("+390612345678");
    expect(normalizePhone("+32 470 12 34 56")).toBe("+32470123456");
  });

  it("« + » implicite seulement à partir de 10 chiffres ; numéros tronqués refusés", () => {
    expect(normalizePhone("6 33 33 33 33")).toBeNull();
    expect(normalizePhone("633333333")).toBeNull();
    expect(normalizePhone("0033")).toBeNull();
    expect(normalizePhone("+33 (0)")).toBeNull();
    expect(normalizePhone("+33 06 33")).toBeNull();
  });

  it("formulaires : stocké en E.164 réel (candidature par lien, fiches, courses)", () => {
    expect(phoneSchema.parse("+33 (0)6 12 34 56 78")).toBe("+33612345678");
    const application = joinApplicationSchema.safeParse({
      firstName: "Sami", lastName: "F.", phone: "+33 (0)6 33 33 33 33", email: "sami@test.dev", password: "motdepasse-solide",
      vehicle: { model: "Clio", plate: "AB-123-CD", category: "standard", seats: 4 }, acceptTerms: true,
    });
    expect(application.success).toBe(true);
    if (application.success) expect(application.data.phone).toBe("+33633333333");
  });
});
