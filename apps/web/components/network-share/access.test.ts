import { formatPrice, type OrgNetworkSummary } from "@rydar/shared";
import { describe, expect, it } from "vitest";
import { defaultNetworkTab, networkMenuShown, networkPendingWork, partnerSettlementsLine, type NetworkAccess } from "./access";
import { orgReadinessView } from "./readiness";
import { readiness } from "./test-fixtures";

// Réseau fermé par Rydar après avoir été ouvert : l'onglet (réduit) reste tant que des sommes ou des courses sont en
// cours ; jamais membre : rien (contrat NETWORK_CLOSED_RPCS). Sous-onglet ouvert sans paramètre d'URL.

const given = (over: Partial<OrgNetworkSummary["given"]> = {}): OrgNetworkSummary["given"] => ({
  searching: 0, in_progress: 0, to_collect_cents: 0, to_confirm_count: 0, to_pay_cents: 0, to_check_count: 0, overdue_cents: 0, overdue_count: 0,
  disputed_count: 0, ...over,
});
const received = (over: Partial<OrgNetworkSummary["received"]> = {}): OrgNetworkSummary["received"] => ({ in_progress: 0, month_rides: 0, ...over });
const summary = (g: Partial<OrgNetworkSummary["given"]> = {}, r: Partial<OrgNetworkSummary["received"]> = {}) => ({ given: given(g), received: received(r) });

describe("réseau fermé par Rydar : sommes en cours", () => {
  it("rien en cours (ou résumé illisible) : rien à montrer", () => {
    expect(networkPendingWork(summary())).toBe(false);
    expect(networkPendingWork(summary({ searching: 1 }, { month_rides: 4 }))).toBe(false);
    expect(networkPendingWork(null)).toBe(false);
  });

  it("courses confiées : à encaisser, à verser, à confirmer, en retard, contesté, à vérifier, en cours", () => {
    for (const g of [{ to_collect_cents: 1250 }, { to_pay_cents: 3750 }, { to_confirm_count: 1 }, { overdue_count: 1 }, { disputed_count: 1 }, { to_check_count: 1 }, { in_progress: 1 }]) {
      expect(networkPendingWork(summary(g)), JSON.stringify(g)).toBe(true);
    }
  });

  it("courses reçues : chauffeur en course partenaire, ou règlements de ses chauffeurs encore ouverts", () => {
    expect(networkPendingWork(summary({}, { in_progress: 1 }))).toBe(true);
    expect(networkPendingWork(summary({}, { open_count: 2 }))).toBe(true);
  });

  it("menu : réseau ouvert toujours ; fermé seulement avec des sommes en cours ; jamais membre : non", () => {
    const open: NetworkAccess = { mode: "open", summary: null };
    expect(networkMenuShown(open)).toBe(true);
    expect(networkMenuShown({ mode: "closed", summary: null, pending: true })).toBe(true);
    expect(networkMenuShown({ mode: "closed", summary: null, pending: false })).toBe(false);
    expect(networkMenuShown(null)).toBe(false);
  });
});

describe("sous-onglet sans paramètre d'URL", () => {
  const TZ = "Europe/Paris";
  const fleet = (r = readiness()) => orgReadinessView(r, "fleet", TZ);

  it("rien de demandé : Réglages ; des sommes à régler : Courses confiées d'abord", () => {
    expect(defaultNetworkTab({ mode: "open", summary: summary(), view: fleet(), receivedVisible: false })).toBe("reglages");
    expect(defaultNetworkTab({ mode: "open", summary: summary({ to_pay_cents: 3750 }), view: fleet(), receivedVisible: false })).toBe("confiees");
  });

  it("réception seule demandée : Courses reçues ; partage demandé : Courses confiées", () => {
    const receiving = fleet(readiness({ share_in: { active: false, missing: ["approval_pending"], warnings: [] } }));
    expect(defaultNetworkTab({ mode: "open", summary: summary(), view: receiving, receivedVisible: true })).toBe("recues");
    const sharing = fleet(readiness({ share_out: { active: true, missing: [], warnings: [] }, share_in: { active: true, missing: [], warnings: [] } }));
    expect(defaultNetworkTab({ mode: "open", summary: summary(), view: sharing, receivedVisible: true })).toBe("confiees");
  });

  it("réseau fermé : Courses reçues s'il ne reste que des courses de ses chauffeurs, sinon Courses confiées", () => {
    expect(defaultNetworkTab({ mode: "closed", summary: summary({}, { open_count: 1 }), view: null, receivedVisible: true })).toBe("recues");
    expect(defaultNetworkTab({ mode: "closed", summary: summary({ to_collect_cents: 500 }, { open_count: 1 }), view: null, receivedVisible: true })).toBe("confiees");
    expect(defaultNetworkTab({ mode: "closed", summary: null, view: null, receivedVisible: false })).toBe("confiees");
  });
});

describe("Encaissements : renvoi vers les règlements des chauffeurs partenaires", () => {
  it("montants et compteurs non nuls seulement ; rien d'ouvert : pas de renvoi", () => {
    expect(partnerSettlementsLine(given({ to_collect_cents: 1250, to_pay_cents: 3750, to_confirm_count: 1 }), "EUR")).toBe(
      `${formatPrice(1250)} à encaisser · ${formatPrice(3750)} à verser · 1 paiement à confirmer`,
    );
    expect(partnerSettlementsLine(given({ overdue_count: 2 }), "EUR")).toBe("2 règlements en retard");
    expect(partnerSettlementsLine(given({ in_progress: 2, to_check_count: 1 }), "EUR")).toBeNull();
    expect(partnerSettlementsLine(null, "EUR")).toBeNull();
  });
});
