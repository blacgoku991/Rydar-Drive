import {
  DRIVER_NETWORK_READINESS_META, ORG_NETWORK_READINESS_CODES, ORG_NETWORK_READINESS_META, formatDate,
  type NetworkDriverReadiness,
} from "@rydar/shared";
import { describe, expect, it } from "vitest";
import {
  driverActionHref, driverReadinessView, networkTermsDue, orgActionHref, orgReadinessView, shareOutRequested, sideSummary,
  termsCardUpFront,
} from "./readiness";
import { readiness } from "./test-fixtures";

// Lisibilité « pourquoi rien n'arrive » (spec §6.4) : chaque manque est affiché une fois, avec UNE action au plus,
// et chaque action mène quelque part (lien de l'onglet, des réglages ou de la fiche chauffeur).

const TZ = "Europe/Paris";

describe("en-tête : état de l'organisation", () => {
  it("rien de demandé : deux sens désactivés, chacun avec « Activer », aucun manque listé", () => {
    const v = orgReadinessView(readiness(), "fleet", TZ);
    expect(v.idle).toBe(true);
    expect(v.items).toEqual([]);
    expect(v.sides.out).toMatchObject({ state: "off", text: "Désactivé", action: { label: "Activer le partage", href: "/dashboard/reseau-partage?tab=reglages#partager" } });
    expect(v.sides.in).toMatchObject({ state: "off", action: { label: "Activer la réception", href: "/dashboard/reseau-partage?tab=reglages#recevoir" } });
  });

  it("sens demandé mais incomplet : ses manques, une seule fois chacun ; ceux d'un sens désactivé ne s'affichent pas", () => {
    const r = readiness({
      share_out: { active: false, missing: ["terms", "approval_pending", "online_payment_method"], warnings: [] },
      share_in: { active: false, missing: ["not_receiving", "terms", "insurance"], warnings: [] },
    });
    const v = orgReadinessView(r, "fleet", TZ);
    expect(v.sides.out.state).toBe("pending");
    expect(v.sides.in.state).toBe("off");
    expect(v.items.map((i) => i.code)).toEqual(["terms", "approval_pending", "online_payment_method"]);
    expect(v.items.find((i) => i.code === "terms")?.sides).toEqual(["out"]);
  });

  it("manque commun aux deux sens : listé une fois, rattaché aux deux", () => {
    const r = readiness({
      share_out: { active: false, missing: ["terms"], warnings: [] },
      share_in: { active: false, missing: ["terms", "insurance"], warnings: [] },
    });
    const v = orgReadinessView(r, "centrale", TZ);
    expect(v.items.map((i) => i.code)).toEqual(["terms", "insurance"]);
    expect(v.items[0]!.sides).toEqual(["out", "in"]);
  });

  it("UNE action par manque, toujours avec un lien (sauf attente de Rydar)", () => {
    const all = ORG_NETWORK_READINESS_CODES.filter((c) => !["network_off", "not_sharing", "not_receiving"].includes(c));
    const r = readiness({
      share_out: { active: false, missing: all.filter((c) => c !== "terms_grace" && c !== "insurance"), warnings: ["terms_grace"] },
      share_in: { active: false, missing: ["insurance"], warnings: [] },
      terms: { version: "2026-11-01", min_version: "2026-06-01", grace_until: "2026-12-01T10:00:00.000Z", accepted_version: "2026-06-01", accepted_at: null },
    });
    const v = orgReadinessView(r, "fleet", TZ);
    expect(v.items.map((i) => i.code)).toEqual(all);
    for (const item of v.items) {
      const meta = ORG_NETWORK_READINESS_META[item.code];
      if (meta.action) expect(item.action?.href, item.code).toBeTruthy();
      else expect(item.action, item.code).toBeNull();
    }
    expect(v.items.find((i) => i.code === "terms_grace")).toMatchObject({ blocking: false });
    expect(v.items.find((i) => i.code === "terms_grace")!.hint).toContain(formatDate("2026-12-01T10:00:00.000Z", TZ));
  });

  it("assurance : centrale → celle de ses chauffeurs indépendants ; flotte → la sienne", () => {
    const r = readiness({ share_in: { active: false, missing: ["insurance"], warnings: [] } });
    expect(orgReadinessView(r, "centrale", TZ).items[0]!.hint).toBe(
      "Confirmez que l'assurance de vos chauffeurs couvre les courses faites pour d'autres organisations.",
    );
    expect(orgReadinessView(r, "fleet", TZ).items[0]!.hint).toBe(ORG_NETWORK_READINESS_META.insurance.hint);
  });

  it("motifs de Rydar ajoutés à l'explication (refus, suspension)", () => {
    const r = readiness({
      share_out: { active: false, missing: ["suspended", "approval_refused"], warnings: [] },
      approval: { status: "refused", requested_at: null, approved_at: null, refused_reason: "SIRET introuvable" },
      suspended_reason: "Versements non effectués",
    });
    const v = orgReadinessView(r, "fleet", TZ);
    expect(v.items.find((i) => i.code === "approval_refused")!.hint).toMatch(/Motif : SIRET introuvable$/);
    expect(v.items.find((i) => i.code === "suspended")!.hint).toMatch(/Motif : Versements non effectués$/);
  });

  it("résumé d'un sens : actif, désactivé, en attente de validation par Rydar ou du premier manque", () => {
    expect(sideSummary(readiness({ share_out: { active: true, missing: [], warnings: [] } }), "out")).toBe("Actif");
    expect(sideSummary(readiness(), "in")).toBe("Désactivé");
    expect(sideSummary(readiness({ share_out: { active: false, missing: ["approval_pending"], warnings: [] } }), "out")).toBe("En attente de validation par Rydar");
    expect(sideSummary(readiness({ share_in: { active: false, missing: ["insurance"], warnings: [] } }), "in")).toBe("En attente\u00a0: assurance à confirmer");
  });

  it("résumé d'un sens : seule la première lettre du manque passe en minuscule (sigles et noms propres intacts)", () => {
    const pending = (code: "vtc_registration" | "platform_fee" | "approval_refused") =>
      sideSummary(readiness({ share_out: { active: false, missing: [code], warnings: [] } }), "out");
    expect(pending("vtc_registration")).toBe("En attente\u00a0: n° d'inscription VTC manquant");
    expect(pending("platform_fee")).toBe("En attente\u00a0: frais Rydar à définir");
    expect(pending("approval_refused")).toBe("En attente\u00a0: inscription refusée par Rydar");
  });
});

describe("actions de l'organisation", () => {
  it("moyens de paiement : une seule source (centrale → Commission & encaissement, flotte → carte de l'onglet)", () => {
    expect(orgActionHref("edit_payment_methods", "centrale")).toBe("/dashboard/settings?tab=centrale");
    expect(orgActionHref("edit_payment_methods", "fleet")).toBe("/dashboard/reseau-partage?tab=reglages#encaissement");
  });

  it("chaque action d'organisation des libellés partagés mène à une page", () => {
    for (const meta of Object.values(ORG_NETWORK_READINESS_META)) {
      if (!meta.action) continue;
      expect(orgActionHref(meta.action.action, "fleet"), meta.action.action).toMatch(/^\//);
      expect(orgActionHref(meta.action.action, "centrale"), meta.action.action).toMatch(/^\//);
    }
    expect(orgActionHref("accept_terms", "fleet")).toBe("/dashboard/reseau-partage?tab=reglages#convention");
    expect(orgActionHref("edit_organization", "fleet")).toBe("/dashboard/settings?tab=org");
    expect(orgActionHref("view_payouts", "fleet")).toBe("/dashboard/reseau-partage?tab=confiees&filtre=to_pay");
    expect(orgActionHref("contact_rydar", "fleet")).toBe("/contact");
    // Actions de l'application chauffeur : jamais un lien du tableau de bord
    expect(orgActionHref("update_app", "fleet")).toBeNull();
  });

  it("chaque action « organisation » d'un manque de chauffeur mène à une page, sauf l'interrupteur « Autorisé » de la ligne", () => {
    for (const meta of Object.values(DRIVER_NETWORK_READINESS_META)) {
      const step = meta.organization;
      if (!step) continue;
      if (step.action === "allow_driver") expect(driverActionHref(step.action, "d-1")).toBeNull();
      else expect(driverActionHref(step.action, "d-1"), step.action).toMatch(/^\//);
    }
    expect(driverActionHref("review_documents", "d-1")).toBe("/dashboard/drivers/d-1");
    expect(driverActionHref("view_settlements", "d-1")).toBe("/dashboard/settlements?driver=d-1");
  });
});

describe("liste des chauffeurs de B (« Prêt » / « Manque : … »)", () => {
  const base: NetworkDriverReadiness = { ready: true, missing: [], warnings: [], terms_grace_until: null, excluded_until: null };

  it("prêt", () => {
    expect(driverReadinessView(base, "d-1", TZ)).toMatchObject({ ready: true, text: "Prêt", missing: [], action: null });
  });

  it("tous les manques en clair (sans infobulle), UNE action (la première qui en propose une)", () => {
    const v = driverReadinessView({ ...base, ready: false, missing: ["org_disallowed", "vtc_card", "insurance"] }, "d-1", TZ);
    expect(v.text).toBe("Manque\u00a0: non autorisé par l'organisation · carte VTC à valider · assurance à valider");
    expect(v.missing.map((m) => m.code)).toEqual(["org_disallowed", "vtc_card", "insurance"]);
    expect(v.needsAllow).toBe(true);
    expect(v.action).toEqual({ label: "Voir les documents", href: "/dashboard/drivers/d-1", kind: "review_documents" });
  });

  it("réception de l'organisation non active : jamais répétée sur la ligne (ni son bouton) ; seul manque → « Prêt »", () => {
    const only = driverReadinessView({ ...base, ready: false, missing: ["org_reception_off"] }, "d-1", TZ);
    expect(only).toMatchObject({ ready: true, text: "Prêt", missing: [], action: null });
    const more = driverReadinessView({ ...base, ready: false, missing: ["org_reception_off", "vtc_card"] }, "d-1", TZ);
    expect(more).toMatchObject({ ready: false, text: "Manque\u00a0: carte VTC à valider" });
    expect(more.missing.map((m) => m.code)).toEqual(["vtc_card"]);
    expect(more.action?.kind).toBe("review_documents");
  });

  it("exclusion automatique : date de fin dans l'explication", () => {
    const v = driverReadinessView({ ...base, ready: false, missing: ["excluded_until"], excluded_until: "2026-10-20T08:00:00.000Z" }, "d-1", TZ);
    expect(v.missing[0]!.hint).toContain(formatDate("2026-10-20T08:00:00.000Z", TZ));
  });
});

describe("bandeau « nouvelle convention »", () => {
  const future = new Date(Date.now() + 10 * 86_400_000).toISOString();
  const past = new Date(Date.now() - 86_400_000).toISOString();

  it("jamais acceptée (première activation dans l'onglet) ou version courante : pas de bandeau", () => {
    expect(networkTermsDue(readiness())).toBeNull();
    expect(networkTermsDue(readiness({ terms: { version: "2026-11-01", min_version: null, grace_until: null, accepted_version: "2026-11-01", accepted_at: null } }))).toBeNull();
    expect(networkTermsDue(null)).toBeNull();
  });

  // Partage demandé (actif pendant la grâce) : l'organisation participe au réseau
  const sharing = { share_out: { active: true, missing: [], warnings: ["terms_grace" as const] } };

  it("ancienne version en délai de grâce : bandeau avec la date limite", () => {
    const r = readiness({ ...sharing, terms: { version: "2026-11-01", min_version: "2026-06-01", grace_until: future, accepted_version: "2026-06-01", accepted_at: null } });
    expect(networkTermsDue(r)).toEqual({ version: "2026-11-01", graceUntil: future, expired: false });
  });

  it("délai dépassé (ou version trop ancienne) : bandeau « réseau arrêté »", () => {
    const stopped = { share_out: { active: false, missing: ["terms" as const], warnings: [] } };
    const r = readiness({ ...stopped, terms: { version: "2026-11-01", min_version: "2026-06-01", grace_until: past, accepted_version: "2026-06-01", accepted_at: null } });
    expect(networkTermsDue(r)).toEqual({ version: "2026-11-01", graceUntil: null, expired: true });
    const old = readiness({ ...stopped, terms: { version: "2026-11-01", min_version: "2026-06-01", grace_until: future, accepted_version: "2025-01-01", accepted_at: null } });
    expect(networkTermsDue(old)?.expired).toBe(true);
  });

  it("partage et réception désactivés : pas de bandeau (l'organisation ne participe plus), même délai dépassé", () => {
    const r = readiness({ terms: { version: "2026-11-01", min_version: "2026-06-01", grace_until: past, accepted_version: "2026-06-01", accepted_at: null } });
    expect(networkTermsDue(r)).toBeNull();
    // Réception seule demandée : bandeau
    const receiving = readiness({
      share_in: { active: false, missing: ["terms"], warnings: [] },
      terms: { version: "2026-11-01", min_version: "2026-06-01", grace_until: past, accepted_version: "2026-06-01", accepted_at: null },
    });
    expect(networkTermsDue(receiving)?.expired).toBe(true);
  });

  it("Réglages : carte de la convention en tête seulement si un sens est demandé et la version courante non acceptée", () => {
    const old = readiness({ terms: { version: "2026-11-01", min_version: null, grace_until: null, accepted_version: "2026-06-01", accepted_at: null } });
    expect(termsCardUpFront(old, { share_out: true, share_in: false, terms_version: "2026-06-01" }, "2026-11-01")).toBe(true);
    expect(termsCardUpFront(old, { share_out: false, share_in: false, terms_version: "2026-06-01" }, "2026-11-01")).toBe(false);
    expect(termsCardUpFront(readiness(), { share_out: true, share_in: false, terms_version: "2026-11-01" }, "2026-11-01")).toBe(false);
    // Résumé illisible : version de l'adhésion
    expect(termsCardUpFront(null, { share_out: false, share_in: true, terms_version: "2026-06-01" }, "2026-11-01")).toBe(true);
  });

  it("réseau fermé par la plateforme : jamais de bandeau", () => {
    const r = readiness({ enabled: false, terms: { version: "2026-11-01", min_version: null, grace_until: null, accepted_version: "2026-06-01", accepted_at: null } });
    expect(networkTermsDue(r)).toBeNull();
  });
});

describe("avertissement du formulaire de course (commentaire lisible par un partenaire)", () => {
  it("partage demandé (actif ou en attente) : oui ; désactivé, réseau fermé ou état illisible : non", () => {
    expect(shareOutRequested(readiness())).toBe(false);
    expect(shareOutRequested(readiness({ share_out: { active: true, missing: [], warnings: [] } }))).toBe(true);
    expect(shareOutRequested(readiness({ share_out: { active: false, missing: ["approval_pending"], warnings: [] } }))).toBe(true);
    expect(shareOutRequested(readiness({ enabled: false, share_out: { active: false, missing: ["network_off"], warnings: [] } }))).toBe(false);
    expect(shareOutRequested(null)).toBe(false);
  });
});
