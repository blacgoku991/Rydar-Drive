import { NETWORK_FORBIDDEN_WORDS, formatPrice, type AdminNetworkOrgRow } from "@rydar/shared";
import { describe, expect, it } from "vitest";
import {
  APPROVAL_META, FLAG_META, acceptanceRatio, feeLabel, membershipApproval, missingIdentity, needsFeeWaiver, networkReviewSchema, networkSuspendSchema,
  rowFlags, sortOrgRows, termsLines,
} from "./admin";
import { ORG_A, ORG_B } from "./test-fixtures";

// /admin/reseau : seuils signalés (mêmes valeurs que le SQL), frais, identité à compléter, saisie des décisions.

function row(over: Partial<AdminNetworkOrgRow> = {}, stats: Partial<AdminNetworkOrgRow["stats_30d"]> = {}): AdminNetworkOrgRow {
  return {
    id: ORG_A, name: "Taxi A", legal_name: "Taxi A SAS", siret: "123 456 789 00012", vtc_registration: "EVTC075190001", dispatch_model: "centrale",
    status: "active", share_out: true, share_in: false, approval: "pending", requested_at: "2026-10-01T08:00:00Z", approved_at: null, refused_reason: null,
    terms_version: "2026-11-01", terms_ok: true, fee_waiver: false, platform_fee_percent: 5, platform_fee_fixed_cents: 100, suspended_at: null,
    suspended_reason: null,
    stats_30d: {
      rides_given: 0, rides_received: 0, offers_received: 0, offers_accepted: 0, offers_declined: 0, offers_expired: 0, releases_after_accept: 0,
      giver_cancellations_after_accept: 0, contested_rides: 0, driver_disputes: 0, overdue_payouts: 0, ...stats,
    },
    flags: [],
    ...over,
  };
}

describe("seuils signalés (30 jours)", () => {
  it("acceptation : significative à partir de 20 offres reçues", () => {
    expect(acceptanceRatio(row({}, { offers_received: 19, offers_accepted: 0 }).stats_30d)).toBeNull();
    expect(acceptanceRatio(row({}, { offers_received: 20, offers_accepted: 3 }).stats_30d)).toBe(0.15);
  });

  it("acceptation < 20 %, ≥ 3 retraits, ≥ 2 contestations, versement > 7 j", () => {
    expect(rowFlags(row({}, { offers_received: 25, offers_accepted: 4 }))).toEqual(["low_acceptance"]);
    expect(rowFlags(row({}, { offers_received: 25, offers_accepted: 5 }))).toEqual([]);
    expect(rowFlags(row({}, { releases_after_accept: 3, contested_rides: 2, overdue_payouts: 1 }))).toEqual(["releases", "contests", "payout_overdue"]);
    expect(rowFlags(row({}, { releases_after_accept: 2, contested_rides: 1 }))).toEqual([]);
  });

  it("signalements de la base gardés, jamais en double", () => {
    expect(rowFlags(row({ flags: ["contests"] }, { contested_rides: 2 }))).toEqual(["contests"]);
    expect(rowFlags(row({ flags: ["payout_overdue"] }))).toEqual(["payout_overdue"]);
  });

  it("tri : signalements, puis suspendues, puis nom", () => {
    const rows = [
      row({ id: "1", name: "Bravo" }),
      row({ id: "2", name: "Alpha", suspended_at: "2026-10-01T00:00:00Z" }),
      row({ id: "3", name: "Charlie" }, { overdue_payouts: 1 }),
      row({ id: "4", name: "Alpha" }),
    ];
    expect(sortOrgRows(rows).map((r) => r.id)).toEqual(["3", "2", "4", "1"]);
  });
});

describe("validation", () => {
  it("frais Rydar en clair, dérogation « frais à 0 » proposée seulement sans frais", () => {
    expect(feeLabel(row())).toBe(`5 % + ${formatPrice(100)}`);
    expect(feeLabel(row({ platform_fee_percent: 1.15, platform_fee_fixed_cents: 0 }))).toBe("1,15 %");
    expect(feeLabel(row({ platform_fee_percent: 0, platform_fee_fixed_cents: 0, fee_waiver: true }))).toBe("Aucun · dérogation");
    expect(needsFeeWaiver(row())).toBe(false);
    expect(needsFeeWaiver(row({ platform_fee_percent: 0, platform_fee_fixed_cents: 0 }))).toBe(true);
  });

  it("identité de l'instantané : SIRET normalisé (espaces, points, tirets), champs vides signalés", () => {
    expect(missingIdentity(row())).toEqual([]);
    expect(missingIdentity(row({ siret: "123.456.789-00012" }))).toEqual([]);
    expect(missingIdentity(row({ legal_name: " ", siret: "12345", vtc_registration: null }))).toEqual(["legal_name", "siret", "vtc_registration"]);
  });

  it("saisie : refus et suspension motivés (5 à 300 caractères), rétablissement sans motif", () => {
    expect(networkReviewSchema.safeParse({ orgId: ORG_B, approved: true }).data).toEqual({ orgId: ORG_B, approved: true, feeWaiver: false });
    expect(networkReviewSchema.safeParse({ orgId: ORG_B, approved: false, reason: "n° VTC introuvable au registre" }).success).toBe(true);
    expect(networkReviewSchema.safeParse({ orgId: ORG_B, approved: false, reason: "non" }).success).toBe(false);
    expect(networkReviewSchema.safeParse({ orgId: "x", approved: true }).success).toBe(false);
    expect(networkSuspendSchema.safeParse({ orgId: ORG_B, suspended: true, reason: "" }).success).toBe(false);
    expect(networkSuspendSchema.safeParse({ orgId: ORG_B, suspended: false }).data).toEqual({ orgId: ORG_B, suspended: false, reason: null });
  });
});

describe("convention et vocabulaire", () => {
  it("version en vigueur et délai de grâce", () => {
    const now = Date.parse("2026-11-10T00:00:00Z");
    expect(termsLines({ version: "2026-11-01", min_version: null, grace_until: null }, "Europe/Paris", now)).toEqual({ current: "Version 2026-11-01", grace: null });
    expect(termsLines({ version: "2027-01-01", min_version: "2026-11-01", grace_until: "2026-12-01T00:00:00Z" }, "Europe/Paris", now).grace).toBe(
      "Version précédente (2026-11-01) encore valable jusqu'au 01/12/2026",
    );
    expect(termsLines({ version: "2027-01-01", min_version: "2026-11-01", grace_until: "2026-11-01T00:00:00Z" }, "Europe/Paris", now).grace).toBe(
      "Délai de grâce de la version 2026-11-01 terminé le 01/11/2026",
    );
  });

  it("aucun mot interdit dans les libellés du super admin", () => {
    const texts = [...Object.values(APPROVAL_META).map((m) => m.label), ...Object.values(FLAG_META).flatMap((m) => [m.label, m.hint])].map((t) => t.toLowerCase());
    for (const word of NETWORK_FORBIDDEN_WORDS) expect(texts.some((t) => t.includes(word)), word).toBe(false);
  });
});

describe("fiche organisation : état de validation", () => {
  const m = { approved_at: null, approved_by: null, refused_reason: null, requested_at: null };
  it("pas de demande, à valider, validée, refusée, à revalider (nom ou n° changé)", () => {
    expect(membershipApproval(null)).toBe("none");
    expect(membershipApproval(m)).toBe("none");
    expect(membershipApproval({ ...m, requested_at: "2026-10-01T08:00:00Z" })).toBe("pending");
    expect(membershipApproval({ ...m, requested_at: "2026-10-01T08:00:00Z", approved_at: "2026-10-02T08:00:00Z", approved_by: "u1" })).toBe("approved");
    expect(membershipApproval({ ...m, requested_at: "2026-10-01T08:00:00Z", refused_reason: "n° VTC introuvable" })).toBe("refused");
    expect(membershipApproval({ ...m, requested_at: "2026-10-01T08:00:00Z", approved_by: "u1" })).toBe("lost");
  });
});
