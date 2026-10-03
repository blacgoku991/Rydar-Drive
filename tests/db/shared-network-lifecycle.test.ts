// Réseau partagé, lot 6 — cycle de vie (20260924007100_shared_network_admin) : nouvelle version de la convention (délai
// de grâce puis partage inactif), suppression du compte d'un chauffeur partenaire (G7, empreintes chez la créancière,
// traces effacées chez elle, débiteur reconnu par son lien d'inscription, purge une fois la dette close). Scénarios
// §14.1 n° 28 et 29 de la spécification. L'interrupteur est rouvert avant chaque test et recoupé à la fin du fichier.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { as, createAuthUser, expectPgError, networkTermsVersion, pool, setSharedNetwork, sql } from "./helpers";
import { networkPair, pendingOffer, rideAtNetworkStep, rpc, sharedRide, siteMaker, svc, tag } from "./network-fixtures";

afterAll(async () => {
  await setSharedNetwork(false);
  await pool.end();
});

beforeEach(async () => {
  await setSharedNetwork(true);
});

const nextSite = siteMaker(-60);
const IBAN_FR = "FR7630006000011234567890189";

// =============================================================================
// n° 28 — Convention : version précédente valable jusqu'à grace_until, puis partage inactif (« terms »)
// =============================================================================
describe("Nouvelle convention du réseau (§6.3, §14.1 n° 28)", () => {
  it("version précédente valable pendant la grâce (avertissement), puis partage et réception inactifs (terms), offres fermées ; seule la version en vigueur s'accepte", async () => {
    const p = await networkPair(nextSite());
    const old = await networkTermsVersion();
    const next = "2099-01-01";
    try {
      await sql(
        `update public.platform_settings set network_terms_version = $1, network_terms_min_version = $2,
                network_terms_grace_until = now() + interval '1 day' where id`,
        [next, old],
      );
      let r = await rpc(p.A.ownerId, "org_network_readiness", [p.A.id]);
      expect(r.share_out).toEqual({ active: true, missing: [], warnings: ["terms_grace"] });
      expect(r.terms).toMatchObject({ version: next, min_version: old, accepted_version: old });
      expect((await rpc(p.partner.userId, "network_driver_readiness", [null])).warnings).toEqual(["terms_grace"]);
      const ride = await rideAtNetworkStep(p);
      const offer = await pendingOffer(ride.id, p.partner.id);
      expect(offer, "offre réseau pendant la grâce").toBeTruthy();
      expect((await expectPgError(rpc(p.A.ownerId, "set_network_settings", [p.A.id, null, null, old, null, null]))).message).toMatch(
        /^NETWORK_TERMS_OUTDATED/,
      );

      // Fin de la grâce : partage et réception inactifs avec la raison « terms », offres en attente fermées par le chien de garde
      await sql(`update public.platform_settings set network_terms_grace_until = now() - interval '1 minute' where id`);
      r = await rpc(p.A.ownerId, "org_network_readiness", [p.A.id]);
      expect(r.share_out).toEqual({ active: false, missing: ["terms"], warnings: [] });
      expect((await rpc(p.B.ownerId, "org_network_readiness", [p.B.id])).share_in).toEqual({ active: false, missing: ["terms"], warnings: [] });
      expect((await sql(`select private.network_org_reason($1, 'out') as r`, [p.A.id]))[0].r).toBe("terms");
      expect((await rpc(p.partner.userId, "network_driver_readiness", [null])).missing).toEqual(["org_reception_off", "terms"]);
      await sql(`select private.network_watch()`);
      expect((await sql(`select status, closed_reason from public.ride_offers where id = $1`, [offer!.id]))[0]).toEqual({
        status: "closed", closed_reason: "network_unavailable",
      });
      // Réactiver avec l'ancienne convention : refusé ; la version en vigueur acceptée : partage actif de nouveau
      await rpc(p.A.ownerId, "set_network_settings", [p.A.id, false, null, null, null, null]);
      expect((await expectPgError(rpc(p.A.ownerId, "set_network_settings", [p.A.id, true, null, null, null, null]))).message).toMatch(
        /^NETWORK_TERMS_REQUIRED/,
      );
      const accepted = await rpc(p.A.ownerId, "set_network_settings", [p.A.id, true, null, next, null, null]);
      expect(accepted.readiness.share_out).toEqual({ active: true, missing: [], warnings: [] });
      expect(accepted.membership).toMatchObject({ terms_version: next, share_out: true });
      expect(await sql(`select version from public.legal_acceptances where organization_id = $1 and document = 'network'`, [p.A.id])).toEqual([
        { version: next },
      ]);
    } finally {
      await sql(
        `update public.platform_settings set network_terms_version = $1, network_terms_min_version = null, network_terms_grace_until = null
          where id`,
        [old],
      );
    }
  });
});

// =============================================================================
// n° 29 — Suppression du compte d'un chauffeur partenaire (§10.10, S2, S4, S5)
// =============================================================================
describe("Suppression d'un compte chauffeur partenaire (§10.10, §14.1 n° 29)", () => {
  it("G7 refuse la suppression de la fiche ; compte supprimé : empreintes chez la créancière, traces effacées chez elle, débiteur reconnu par son lien d'inscription ; purge une fois la dette close", async () => {
    const p = await networkPair(nextSite());
    const cash = await sharedRide(p, { payment_method: "cash" });
    expect(cash.settlement).toMatchObject({ direction: "driver_owes", status: "due", driver_label: `Karim T. · ${p.bName}` });
    await rpc(p.partner.userId, "driver_set_payout_details", ["Karim Tazi", IBAN_FR, null]);
    expect(await rpc(p.partner.userId, "driver_declare_network_payment", [p.A.id, [cash.settlement.id], "link", "Virement de Karim T. ce matin"]))
      .toMatchObject({ ok: true });
    await rpc(p.A.ownerId, "exclude_network_driver", [cash.execution.id, "Retards"]);
    const [identity] = await sql(`select phone, vtc_card_number from public.drivers where id = $1`, [p.partner.id]);
    const eventsBefore = await sql(`select message from public.ride_events where ride_id = $1 and message like '%Karim T.%'`, [cash.ride.id]);
    expect(eventsBefore.length).toBeGreaterThan(0);

    // G7 : l'organisation du chauffeur ne supprime pas une fiche qui doit encore une somme à une organisation partenaire
    const g7 = await expectPgError(as({ sub: p.B.ownerId }, (q) => q(`delete from public.drivers where id = $1`, [p.partner.id])));
    expect(g7.message).toMatch(/^DRIVER_HAS_NETWORK_OBLIGATIONS/);

    expect(await svc("svc_delete_driver_account", [p.partner.userId])).toMatchObject({ ok: true, code: "DELETED" });

    // Chez A : libellés « Chauffeur supprimé », note de paiement retirée, contrôles réduits aux échéances, exclusion gardée
    const [settlement] = await sql(`select driver_label, declared_note, status from public.ride_settlements where id = $1`, [cash.settlement.id]);
    expect(settlement).toEqual({ driver_label: `Chauffeur supprimé · ${p.bName}`, declared_note: null, status: "declared" });
    const [execution] = await sql(`select driver_label, checks, operator, vehicle from public.ride_network_executions where id = $1`, [cash.execution.id]);
    expect(execution.driver_label).toBe("Chauffeur supprimé");
    expect(execution.checks).not.toHaveProperty("vtc_card_number");
    expect(execution.checks).toHaveProperty("vtc_card_expires_on");
    expect(execution.operator).toMatchObject({ name: p.bName });
    const events = await sql(`select message, data from public.ride_events where organization_id = $1 and ride_id = $2`, [p.A.id, cash.ride.id]);
    expect(events.filter((e) => /Karim|Tazi/.test(e.message + JSON.stringify(e.data)))).toEqual([]);
    expect(events.some((e) => e.message.includes("Chauffeur supprimé"))).toBe(true);
    const [exclusion] = await sql(`select label, cardinality(value_hashes) as keys from private.network_driver_exclusions where execution_id = $1`, [cash.execution.id]);
    expect(exclusion).toEqual({ label: `Chauffeur supprimé · ${p.bName}`, keys: expect.any(Number) });
    expect(exclusion.keys).toBeGreaterThan(0);
    expect(await sql(`select 1 from public.notifications where driver_id = $1`, [p.partner.id])).toEqual([]);
    expect(await sql(`select 1 from public.driver_payout_details where driver_id = $1`, [p.partner.id])).toEqual([]);
    const [audit] = await sql(`select metadata from public.audit_logs where action = 'driver.deleted' and entity_id = $1`, [p.partner.id]);
    expect(audit.metadata.network_traces).toMatchObject({ organizations: 1, executions: 1, settlements: 1, exclusions: 1, payout_details: 1 });
    const kept = await sql(`select creditor_org_id, kind from private.network_debtor_identities where driver_id = $1`, [p.partner.id]);
    expect(new Set(kept.map((k) => k.creditor_org_id))).toEqual(new Set([p.A.id]));

    // Lien d'inscription de A : même téléphone → candidature jamais validée d'office, journal sans fiche, n° ni nom de B
    await sql(`update public.organizations set join_enabled = true, join_auto_approve = true where id = $1`, [p.A.id]);
    const match = await sql(`select * from private.debtor_match($1, $2, null, null)`, [p.A.id, identity.phone]);
    expect(match).toEqual([{ driver_id: null, driver_number: null, owed_cents: String(cash.settlement.amount_cents), owed_count: 1 }]);
    const applicant = await createAuthUser(`revenu-${tag()}@test.dev`, "Karim Revenu");
    const applied = await svc("svc_driver_apply", [
      p.A.id, applicant, "Karim", "Tazi", identity.phone, `revenu-${tag()}@test.dev`, null, { model: "Classe E", plate: `AB${tag()}` }, null,
    ]);
    expect(applied).toMatchObject({ ok: true, code: "PENDING" });
    const [journal] = await sql(`select message, data from public.ride_events where organization_id = $1 and type = 'driver.applied_debtor'`, [p.A.id]);
    expect(journal.message).toContain("qu'un chauffeur partenaire qui a supprimé son compte");
    expect(journal.message).not.toContain("Chauffeur supprimé (#");
    expect(journal.message).not.toContain(p.bName);
    expect(journal.data).toMatchObject({ debtor_driver_ids: [], debtor_numbers: [], network_owed_cents: cash.settlement.amount_cents });

    // A encaisse : dette close → empreintes purgées par le ménage, plus reconnu
    expect(await rpc(p.A.ownerId, "confirm_settlements", [[cash.settlement.id], "link", null])).toMatchObject({ ok: true });
    const [{ r }] = await sql(`select private.housekeeping() as r`);
    expect(r.debtor_identities_purged).toBeGreaterThanOrEqual(1);
    expect(await sql(`select 1 from private.network_debtor_identities where driver_id = $1`, [p.partner.id])).toEqual([]);
    expect(await sql(`select * from private.debtor_match($1, $2, null, null)`, [p.A.id, identity.phone])).toEqual([]);
  });

  it("chauffeur sans aucune trace réseau : suppression inchangée (aucune clé « network_traces »)", async () => {
    const p = await networkPair(nextSite());
    expect(await svc("svc_delete_driver_account", [p.partner.userId])).toMatchObject({ ok: true, code: "DELETED" });
    const [audit] = await sql(`select metadata from public.audit_logs where action = 'driver.deleted' and entity_id = $1`, [p.partner.id]);
    expect(audit.metadata).not.toHaveProperty("network_traces");
    expect(audit.metadata).not.toHaveProperty("network_debtor_identities");
  });
});
