import { describe, expect, it } from "vitest";
import { EMPTY_NETWORK_NAV, networkNavItem, networkNavState } from "./nav";

// Entrée « Réseau partagé » : absente tant que la plateforme n'a pas ouvert le réseau (rien ne change pour personne),
// pastille = à confirmer + en retard + à vérifier.

const given = { searching: 0, in_progress: 0, to_collect_cents: 0, to_confirm_count: 2, to_pay_cents: 0, to_check_count: 1, overdue_cents: 0, overdue_count: 0, disputed_count: 0 };

describe("menu « Réseau partagé »", () => {
  it("réseau fermé (aucun état transmis par la mise en page) : aucune entrée", () => {
    expect(networkNavItem(null)).toBeNull();
    expect(networkNavItem(undefined)).toBeNull();
  });

  it("réseau ouvert sans rien à traiter : entrée sans pastille", () => {
    expect(networkNavItem(EMPTY_NETWORK_NAV)).toEqual({
      href: "/dashboard/reseau-partage",
      label: "Réseau partagé",
      icon: "share",
      badge: 0,
      badgeTone: "amber",
      badgeLabel: "Réseau partagé",
    });
  });

  it("pastille : badge SQL, libellé détaillé ; rouge dès qu'un règlement est en retard", () => {
    const state = networkNavState({ badge: 3, given });
    expect(state).toEqual({ badge: 3, toConfirm: 2, overdue: 0, toCheck: 1 });
    expect(networkNavItem(state)).toMatchObject({ badge: 3, badgeTone: "amber", badgeLabel: "2 paiements à confirmer · 1 course à vérifier" });
    const late = networkNavState({ badge: 4, given: { ...given, overdue_count: 1 } });
    expect(networkNavItem(late)).toMatchObject({ badgeTone: "red", badgeLabel: "2 paiements à confirmer · 1 règlement en retard · 1 course à vérifier" });
  });

  it("résumé illisible : pastille à zéro (le menu reste, le réseau étant ouvert)", () => {
    expect(networkNavState(null)).toEqual(EMPTY_NETWORK_NAV);
    expect(networkNavState({ badge: Number.NaN, given })).toMatchObject({ badge: 3 });
  });
});
