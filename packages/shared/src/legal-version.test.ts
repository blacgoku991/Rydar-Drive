import { describe, expect, it } from "vitest";
import { LEGAL_VERSION, ORG_LEGAL_CHANGES, ORG_LEGAL_EFFECTIVE_AT, ORG_LEGAL_VERSION, legalAcceptanceState, noticeMinDay } from "./features";

const realDate = (iso: string) => /^\d{4}-\d{2}-\d{2}$/.test(iso) && new Date(`${iso}T00:00:00Z`).toISOString().slice(0, 10) === iso;
const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 86_400_000;

// accept_legal_documents (20260924004300) refuse une version hors format AAAA-MM-JJ ou postérieure au lendemain
// (heure de Paris) : une version future rendrait l'acceptation impossible (bandeaux web, écran de l'app).
describe.each([
  ["LEGAL_VERSION (CGU + politique de confidentialité)", LEGAL_VERSION],
  ["ORG_LEGAL_VERSION (CGV + accord de traitement)", ORG_LEGAL_VERSION],
])("%s", (_name, version) => {
  it("date AAAA-MM-JJ réelle, jamais dans le futur", () => {
    expect(realDate(version)).toBe(true);
    const tomorrowParis = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" }).format(new Date(Date.now() + 86_400_000));
    expect(version <= tomorrowParis).toBe(true);
  });
});

describe("versions séparées (CGV du 2 octobre 2026)", () => {
  it("CGU + politique de confidentialité inchangées : aucun chauffeur ni dispatcher n'a rien à ré-accepter", () => {
    // Changer LEGAL_VERSION = nouvel écran d'acceptation pour CHAQUE chauffeur, après une mise à jour à distance de
    // l'app qui embarque la valeur (docs/STORES.md § 10), et nouveau bandeau pour chaque membre du tableau de bord.
    expect(LEGAL_VERSION).toBe("2026-09-27");
    expect(legalAcceptanceState(["2026-09-27"], LEGAL_VERSION)).toBe("accepted");
  });

  it("CGV + accord de traitement : une organisation qui avait accepté le 27/09 voit une mise à jour", () => {
    expect(legalAcceptanceState(["2026-09-27"], ORG_LEGAL_VERSION)).toBe("updated");
    expect(legalAcceptanceState([], ORG_LEGAL_VERSION)).toBe("pending");
    expect(legalAcceptanceState(["2026-09-27", ORG_LEGAL_VERSION], ORG_LEGAL_VERSION)).toBe("accepted");
  });

  it("entrée en vigueur pour une organisation déjà cliente : date réelle, au moins 30 jours après la version", () => {
    // CGV art. 16 : modification défavorable annoncée au moins 30 jours à l'avance (à revoir avec chaque version). La
    // date réelle de l'annonce compte : svc_org_terms_notify la refuse moins de 30 jours avant (noticeMinDay)
    expect(realDate(ORG_LEGAL_EFFECTIVE_AT)).toBe(true);
    expect(ORG_LEGAL_EFFECTIVE_AT).toBe("2026-11-05");
    expect(day(ORG_LEGAL_EFFECTIVE_AT) - day(ORG_LEGAL_VERSION)).toBeGreaterThanOrEqual(30);
  });

  it("principaux changements : liste non vide, défavorables compris, typographie à espaces simples (fr_typo / fr à l'affichage)", () => {
    expect(ORG_LEGAL_CHANGES.length).toBeGreaterThanOrEqual(5);
    const all = ORG_LEGAL_CHANGES.join(" ");
    for (const point of ["aux flottes comme aux centrales", "toutes taxes comprises", "n'attend plus le renouvellement", "relance ou l'attribution", "erreur de calcul", "Nouvelle obligation", "L'accord de traitement des données ne change pas"]) {
      expect(all).toContain(point);
    }
    // Texte source à espaces ordinaires : la typographie est appliquée à l'affichage (même règle que private.fr_typo)
    expect(all).not.toContain("\u00a0");
  });
});

describe("noticeMinDay : premier minuit au moins 30 jours après l'annonce (miroir de private.notice_min_on)", () => {
  it("annonce dans la journée : le surlendemain du 30e jour n'est pas requis, le lendemain du 30e jour l'est", () => {
    // 3 octobre 2026, 15:00 à Paris (13:00 UTC) + 30 jours = 2 novembre 15:00 → premier minuit : 3 novembre
    expect(noticeMinDay(new Date("2026-10-03T13:00:00Z"))).toBe("2026-11-03");
    // Dernier jour pour le 5 novembre 2026 : une annonce le 5 octobre (passage à l'heure d'hiver compris)
    expect(noticeMinDay(new Date("2026-10-05T20:00:00Z"))).toBe("2026-11-05");
    expect(noticeMinDay(new Date("2026-10-06T10:00:00Z"))).toBe("2026-11-06");
  });

  it("annonce pile à minuit + 30 jours : ce minuit-là compte (au moins 30 × 24 heures)", () => {
    // 4 novembre 2026, 23:00 UTC = 5 novembre 00:00 à Paris ; 30 jours avant : 5 octobre 23:00 UTC
    expect(noticeMinDay(new Date("2026-10-05T23:00:00Z"))).toBe("2026-11-05");
    expect(noticeMinDay(new Date("2026-10-05T23:00:00.001Z"))).toBe("2026-11-06");
  });

  it("fuseau de l'organisation", () => {
    expect(noticeMinDay(new Date("2026-10-03T13:00:00Z"), "America/Martinique")).toBe("2026-11-03");
    expect(noticeMinDay(new Date("2026-10-03T03:00:00Z"), "America/Martinique")).toBe("2026-11-02");
  });
});
