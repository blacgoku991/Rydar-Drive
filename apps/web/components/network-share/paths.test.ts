import { describe, expect, it } from "vitest";
import {
  NETWORK_LIST_MAX, NETWORK_LIST_PAGE, NETWORK_SUSPENDED_PATH, monthInZone, monthLabel, networkExportHref, networkShareHref,
  parseMonth, parseNetworkShareParams, recentMonths, shiftMonth,
} from "./paths";

// Contrat d'URL de /dashboard/reseau-partage : paramètres lus sans confiance (valeur inconnue → défaut).

const PARTNER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("paramètres de l'onglet", () => {
  it("défauts : sous-onglet choisi par la page (null), toutes, sans partenaire ni mois, 50 lignes", () => {
    expect(parseNetworkShareParams({})).toEqual({ tab: null, given: "all", received: "all", partner: null, month: null, limit: NETWORK_LIST_PAGE });
    expect(parseNetworkShareParams({ tab: "confiees" }).tab).toBe("confiees");
    expect(parseNetworkShareParams({ filtre: "to_collect" }).given).toBe("to_collect");
  });

  it("sous-onglet et filtres valides conservés, filtre inconnu de l'onglet ignoré", () => {
    const p = parseNetworkShareParams({ tab: "recues", filtre: "open", partenaire: PARTNER, mois: "2026-09", n: "150" });
    expect(p).toMatchObject({ tab: "recues", received: "open", given: "all", partner: PARTNER, month: "2026-09", limit: 150 });
    // « open » n'est pas un filtre des courses confiées ; « to_pay » pas un filtre des courses reçues
    expect(parseNetworkShareParams({ filtre: "to_pay" })).toMatchObject({ given: "to_pay", received: "all" });
  });

  it("valeurs invalides ou injectées → défauts", () => {
    const p = parseNetworkShareParams({ tab: "admin", filtre: "'; drop", partenaire: "pas-un-uuid", mois: "2026-13", n: "999999" });
    expect(p).toEqual({ tab: null, given: "all", received: "all", partner: null, month: null, limit: NETWORK_LIST_MAX });
    expect(parseNetworkShareParams({ n: "-4" }).limit).toBe(NETWORK_LIST_PAGE);
    expect(parseNetworkShareParams({ tab: ["reglages", "recues"] }).tab).toBe("reglages");
  });

  it("mois AAAA-MM seulement", () => {
    expect(parseMonth("2026-01")).toBe("2026-01");
    expect(parseMonth("2026-1")).toBeNull();
    expect(parseMonth("2026-00")).toBeNull();
    expect(parseMonth(null)).toBeNull();
  });
});

describe("liens", () => {
  it("sous-onglet toujours écrit (sans lui, la page choisit selon l'état), filtres par défaut omis, ancre facultative", () => {
    expect(networkShareHref({ tab: "confiees" })).toBe("/dashboard/reseau-partage?tab=confiees");
    expect(networkShareHref({ tab: "reglages" }, "convention")).toBe("/dashboard/reseau-partage?tab=reglages#convention");
    expect(networkShareHref({ tab: "confiees", filter: "overdue", partner: PARTNER, month: "2026-09", n: 100 })).toBe(
      `/dashboard/reseau-partage?tab=confiees&filtre=overdue&partenaire=${PARTNER}&mois=2026-09&n=100`,
    );
    expect(networkShareHref({ tab: "recues", filter: "all", n: NETWORK_LIST_PAGE })).toBe("/dashboard/reseau-partage?tab=recues");
    // Organisation suspendue : une seule vue, sans sous-onglet
    expect(networkShareHref({ tab: "confiees", filter: "to_pay" }, undefined, NETWORK_SUSPENDED_PATH)).toBe("/suspended/reseau-partage?filtre=to_pay");
  });

  it("export CSV / relevé mensuel", () => {
    expect(networkExportHref({ view: "confiees", month: "2026-09" })).toBe("/dashboard/reseau-partage/export?vue=confiees&mois=2026-09");
    expect(networkExportHref({ view: "recues", month: "2026-09", partner: PARTNER })).toBe(
      `/dashboard/reseau-partage/export?vue=recues&mois=2026-09&partenaire=${PARTNER}`,
    );
  });
});

describe("mois au fuseau de l'organisation", () => {
  it("le 30 septembre à 23 h 30 UTC est déjà en octobre à Paris", () => {
    expect(monthInZone(new Date("2026-09-30T23:30:00Z"), "Europe/Paris")).toBe("2026-10");
    expect(monthInZone(new Date("2026-09-30T23:30:00Z"), "America/Martinique")).toBe("2026-09");
    expect(monthInZone(new Date("2026-09-30T23:30:00Z"), "Pas/UnFuseau")).toBe("2026-09");
  });

  it("décalage de mois à travers les années, libellés FR, 12 derniers mois", () => {
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(monthLabel("2026-09")).toBe("septembre 2026");
    const months = recentMonths(new Date("2026-02-10T12:00:00Z"), "Europe/Paris", 3);
    expect(months).toEqual([
      { value: "2026-02", label: "février 2026" },
      { value: "2026-01", label: "janvier 2026" },
      { value: "2025-12", label: "décembre 2025" },
    ]);
  });
});
