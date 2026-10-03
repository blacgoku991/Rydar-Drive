import { formatPrice, type OrgNetworkSummary } from "@rydar/shared";
import { describe, expect, it } from "vitest";
import { hasOpenNetworkSettlements, openNetworkSummaryText } from "./suspended";

// Organisation suspendue (C12) : lien « Réseau partagé : règlements en cours » seulement s'il reste quelque chose.

const given = (over: Partial<OrgNetworkSummary["given"]> = {}): OrgNetworkSummary["given"] => ({
  searching: 0, in_progress: 0, to_collect_cents: 0, to_confirm_count: 0, to_pay_cents: 0, to_check_count: 0, overdue_cents: 0, overdue_count: 0,
  disputed_count: 0, ...over,
});

describe("organisation suspendue : règlements réseau ouverts", () => {
  it("rien d'ouvert (ou résumé illisible) : pas de lien", () => {
    expect(hasOpenNetworkSettlements(given())).toBe(false);
    expect(hasOpenNetworkSettlements(given({ searching: 2 }))).toBe(false);
    expect(hasOpenNetworkSettlements(null)).toBe(false);
  });

  it("à encaisser, à verser, à confirmer, en retard, contesté, à vérifier ou en cours : lien", () => {
    for (const over of [
      { to_collect_cents: 1250 }, { to_pay_cents: 3750 }, { to_confirm_count: 1 }, { overdue_count: 1 }, { disputed_count: 1 }, { to_check_count: 1 },
      { in_progress: 1 },
    ]) {
      expect(hasOpenNetworkSettlements(given(over)), JSON.stringify(over)).toBe(true);
    }
  });

  it("résumé en une ligne", () => {
    expect(openNetworkSummaryText(given({ to_collect_cents: 1250, to_pay_cents: 3750, in_progress: 1 }), "EUR")).toBe(
      `${formatPrice(1250)} à encaisser · ${formatPrice(3750)} à verser · 1 en cours chez un partenaire`,
    );
    expect(openNetworkSummaryText(given({ disputed_count: 1 }), "EUR")).toBe("Règlements à suivre avec les chauffeurs partenaires");
  });
});
