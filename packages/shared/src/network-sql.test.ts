// Textes et paramètres du réseau partagé écrits en SQL (dispatch 20260924006800, argent 20260924006900) = ceux de
// @rydar/shared : messages de blocage (private.network_blocker_message ↔ NETWORK_BLOCKER_META), raisons de non-partage du
// journal (private.network_skip_label ↔ NETWORK_SKIP_REASON_LABELS), paramètres fixes de la v1 (NETWORK_PARAMS), motifs
// de retrait, causes du chien de garde et de la clôture, raisons « à vérifier » ; argent : clés d'un règlement partenaire
// (DriverNetworkSettlementItem), noms des paramètres des RPC du chauffeur (NetworkRpcs), lisibilité du chauffeur.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ACCEPT_OFFER_CODES, DRIVER_NETWORK_READINESS_CODES, NETWORK_BLOCKER_META, NETWORK_BLOCKERS, NETWORK_CLOSE_CAUSES,
  NETWORK_EXECUTION_END_REASONS, NETWORK_OFFER_NOTIFICATION_KEYS, NETWORK_PARAMS, NETWORK_SHARE_CLOSED_REASONS,
  NETWORK_SKIP_REASON_LABELS, NETWORK_SUSPECT_REASONS, NETWORK_UNASSIGN_REASONS, NETWORK_WATCH_CAUSES,
  type DriverNetworkSettlementItem, type NetworkOfferNotificationData, type NetworkRpcs,
} from "./network";

const MIGRATIONS = fileURLToPath(new URL("../../../supabase/migrations/", import.meta.url));

/**
 * Corps de la DERNIÈRE définition d'une fonction SQL dans les migrations (« private.x » ; pour une surcharge, début
 * exact de la signature : « private.x(d public.drivers, … »).
 */
function lastSqlDefinition(signature: string): string {
  let body: string | null = null;
  // « create or replace function » : jamais une ligne de droits (« grant execute on function public.x(uuid) … »)
  const head = signature.includes("(") ? `create or replace function ${signature}` : `create or replace function ${signature}(`;
  for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith(".sql")).sort()) {
    const sql = readFileSync(`${MIGRATIONS}${f}`, "utf8");
    const at = sql.lastIndexOf(head);
    if (at === -1) continue;
    body = sql.slice(at, sql.indexOf("$$;", at));
  }
  if (!body) throw new Error(`${signature} introuvable`);
  return body;
}

/** « when 'clé' then 'texte' » d'un CASE SQL → { clé: texte } (apostrophes doublées rendues simples). */
function sqlCases(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/when '([a-z_]+)' then '((?:[^']|'')*)'/g)) out[m[1]!] = m[2]!.replace(/''/g, "'");
  return out;
}

describe("Réseau partagé : textes SQL = @rydar/shared", () => {
  it("private.network_blocker_message : mêmes modèles que NETWORK_BLOCKER_META (noms {giver} / {executor} insérés)", () => {
    const sql = sqlCases(lastSqlDefinition("private.network_blocker_message"));
    expect(Object.keys(sql).sort()).toEqual([...NETWORK_BLOCKERS].sort());
    for (const reason of NETWORK_BLOCKERS) expect(sql[reason], reason).toBe(NETWORK_BLOCKER_META[reason].message);
    // Mêmes replis que networkBlockerMessage()
    const body = lastSqlDefinition("private.network_blocker_message");
    expect(body).toContain("'{giver}', coalesce(nullif(btrim(p_giver), ''), 'l''organisation')");
    expect(body).toContain("'{executor}', coalesce(nullif(btrim(p_executor), ''), 'votre organisation')");
  });

  it("public.accept_ride_offer : codes de réponse = ACCEPT_OFFER_CODES", () => {
    const body = lastSqlDefinition("public.accept_ride_offer");
    const codes = new Set<string>();
    for (const m of body.matchAll(/'code', '([A-Z_]+)'/g)) codes.add(m[1]!);
    // Codes du refus tardif (v_code := case … end)
    const late = body.slice(body.indexOf("v_code := case"), body.indexOf("end;", body.indexOf("v_code := case")));
    for (const m of late.matchAll(/then '([A-Z_]+)'/g)) codes.add(m[1]!);
    for (const m of late.matchAll(/else '([A-Z_]+)'/g)) codes.add(m[1]!);
    expect([...codes].sort()).toEqual([...ACCEPT_OFFER_CODES].sort());
  });

  it("private.network_skip_label : mêmes libellés que NETWORK_SKIP_REASON_LABELS", () => {
    const sql = sqlCases(lastSqlDefinition("private.network_skip_label"));
    expect(sql).toEqual(NETWORK_SKIP_REASON_LABELS);
  });

  it("notification d'offre partenaire (private.network_offer) : clés = NetworkOfferNotificationData, jamais de montant interne", () => {
    const body = lastSqlDefinition("private.network_offer");
    const at = body.indexOf("jsonb_build_object(", body.indexOf("insert into public.notifications"));
    expect(at).toBeGreaterThan(-1);
    const data = body.slice(at, body.indexOf("'high'", at));
    // Clés de jsonb_build_object : chaînes suivies d'une virgule (les valeurs littérales sont suivies de « end, » ou « ) »)
    const keys = [...data.matchAll(/'([a-z_]+)',\s/g)].map((m) => m[1]!);
    expect(keys.sort()).toEqual([...NETWORK_OFFER_NOTIFICATION_KEYS].sort());
    const sample = {
      type: "ride_offer", offer_id: "o", ride_id: "r", ride_type: "instant", network: true, giver: "Flotte A", pickup: "75008 Paris",
      dropoff: "Roissy-en-France", pickup_at: "2026-10-03T10:00:00Z", price_cents: 7200, distance_m: 800, passengers: 2,
      expires_at: "2026-10-03T09:00:30Z",
    } satisfies NetworkOfferNotificationData;
    expect(Object.keys(sample).sort()).toEqual([...NETWORK_OFFER_NOTIFICATION_KEYS].sort());
    for (const key of ["commission_cents", "platform_fee_cents", "driver_payout_cents", "giver_cut_cents", "pickup_lat", "pickup_lng"]) {
      expect(data, key).not.toContain(`'${key}'`);
    }
  });
});

describe("Réseau partagé : index partiel des lignes réseau (ride_settlements_network_driver_idx)", () => {
  // L'index ne sert que si la requête porte son prédicat « network_driver_org_id is not null » : sans lui, chaque
  // partenaire évalué parcourt tous les règlements ouverts propres de A (ride_settlements_org_status_idx).
  it("private.network_blocker et private.network_identity_block : chaque lecture par network_driver_id porte le prédicat", () => {
    const blocker = lastSqlDefinition("private.network_blocker");
    expect(blocker.split("x.network_driver_id = p_driver").length - 1).toBe(3);
    expect(blocker.split("x.network_driver_org_id is not null").length - 1).toBe(3);
    const identity = lastSqlDefinition("private.network_identity_block");
    expect(identity.split("x.network_driver_id = n.driver_id").length - 1).toBe(1);
    expect(identity.split("x.network_driver_org_id is not null").length - 1).toBe(1);
  });
});

describe("Réseau partagé : paramètres fixes de la v1 (NETWORK_PARAMS) appliqués par le SQL", () => {
  it("fenêtre des planifiées : prise en charge − 120 min, jamais moins de 15 min après le début", () => {
    const body = lastSqlDefinition("private.network_window_at");
    expect(body).toContain(`interval '${NETWORK_PARAMS.scheduledLeadMinutes} minutes'`);
    expect(body).toContain(`interval '${NETWORK_PARAMS.scheduledMinAfterStartMinutes} minutes'`);
  });

  it("application déclarée depuis moins de 7 jours ; 50 courses réseau par passage ; 3 erreurs avant la fin", () => {
    const reason = lastSqlDefinition("private.network_driver_reason(d public.drivers, r public.rides, p_amount integer)");
    expect(reason).toContain(`interval '${NETWORK_PARAMS.appCapableDays} days'`);
    expect(lastSqlDefinition("private.dispatch_tick")).toContain(`v_network_max constant integer := ${NETWORK_PARAMS.maxPerTick};`);
    expect(lastSqlDefinition("private.network_dispatch_failed")).toContain(`if v_errors < ${NETWORK_PARAMS.maxErrors} then`);
    expect(lastSqlDefinition("private.network_open")).toContain(`>= ${NETWORK_PARAMS.maxErrors} then`);
  });
});

describe("Réseau partagé : retraits, chien de garde, clôture et contrôles de fin (partie 3b)", () => {
  /** Valeurs « 'a', 'b' » d'une liste SQL repérée par son début (« in ('… », « array['… »). */
  const sqlList = (body: string, start: string): string[] => {
    const at = body.indexOf(start);
    expect(at, start).toBeGreaterThan(-1);
    const list = body.slice(at + start.length, body.indexOf(")", at + start.length));
    return [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
  };

  it("motifs de retrait (private.unassign_network_ride) = NETWORK_UNASSIGN_REASONS, fins d'exécution et clôtures du partage", () => {
    const body = lastSqlDefinition("private.unassign_network_ride");
    expect(sqlList(body, "p_reason not in (")).toEqual([...NETWORK_UNASSIGN_REASONS]);
    for (const reason of NETWORK_UNASSIGN_REASONS) {
      expect(NETWORK_EXECUTION_END_REASONS).toContain(reason);
      expect(NETWORK_SHARE_CLOSED_REASONS).toContain(reason);
    }
  });

  it("retraits répétés : 3 en 30 jours → exclu 30 jours (NETWORK_PARAMS)", () => {
    const body = lastSqlDefinition("private.unassign_network_ride");
    expect(body).toContain(`if v_releases >= ${NETWORK_PARAMS.releasesLimit} then`);
    expect(body).toContain(`x.ended_at > now() - interval '${NETWORK_PARAMS.releasesWindowDays} days'`);
    expect(body).toContain(`v_until := now() + interval '${NETWORK_PARAMS.autoExclusionDays} days'`);
  });

  it("causes du chien de garde et de la clôture = NETWORK_WATCH_CAUSES / NETWORK_CLOSE_CAUSES", () => {
    const watch = lastSqlDefinition("private.network_watch");
    const watchCauses = [...watch.slice(watch.indexOf("v_cause := case"), watch.indexOf("end;", watch.indexOf("v_cause := case")))
      .matchAll(/then '([a-z_]+)'/g)].map((m) => m[1]!);
    expect(watchCauses).toEqual([...NETWORK_WATCH_CAUSES]);
    const close = lastSqlDefinition("public.close_network_ride");
    const closeCauses = [...close.slice(close.indexOf("v_cause := case"), close.indexOf("end;", close.indexOf("v_cause := case")))
      .matchAll(/then '([a-z_]+)'/g)].map((m) => m[1]!);
    expect(closeCauses).toEqual([...NETWORK_CLOSE_CAUSES]);
  });

  it("raisons « à vérifier » posées par les contrôles de fin et la clôture ⊂ NETWORK_SUSPECT_REASONS ; retenue de 72 h", () => {
    const checks = lastSqlDefinition("private.network_completion_checks");
    const reasons = [...checks.matchAll(/v_reasons \|\| '([a-z_]+)'::text/g)].map((m) => m[1]!);
    expect(reasons.sort()).toEqual(["far_from_dropoff", "far_from_pickup", "no_gps", "too_fast"]);
    const close = lastSqlDefinition("public.close_network_ride");
    expect(close).toContain("array['closed_by_giver']::text[]");
    expect([...reasons, "closed_by_giver"].sort()).toEqual([...NETWORK_SUSPECT_REASONS].sort());
    expect(checks).toContain(`now() + interval '${NETWORK_PARAMS.payoutHoldHours} hours'`);
    expect(close).toContain(`now() + interval '${NETWORK_PARAMS.payoutHoldHours} hours'`);
  });
});

describe("Réseau partagé, argent (partie 4a) : SQL = contrats de @rydar/shared", () => {
  it("private.network_settlement_item : clés = DriverNetworkSettlementItem (un montant par sens, jamais commission ni frais)", () => {
    const body = lastSqlDefinition("private.network_settlement_item");
    const top = body.slice(body.indexOf("jsonb_build_object("), body.indexOf("'ride', jsonb_build_object("));
    const keys = [...top.matchAll(/^\s*'([a-z_]+)',/gm)].map((m) => m[1]!).concat("ride");
    const sample = {
      id: "s", ride_id: "r", reference: "R1783", direction: "driver_owes", amount_cents: 1250, price_cents: 5000,
      driver_part_cents: 3750, giver_part_cents: 1250, currency: "EUR", payment_method: "cash", status: "due", overdue: false,
      on_hold: false, hold_until: null, due_at: "2026-10-05T10:00:00Z", declared_at: null, declared_method: null, settled_at: null,
      settled_method: null, disputed_at: null, driver_disputed_at: null, driver_dispute_reason: null, can_dispute: false,
      ride: { number: 1783, pickup: "75008 Paris", dropoff: "Roissy-en-France", completed_at: null },
    } satisfies DriverNetworkSettlementItem;
    expect(keys.sort()).toEqual(Object.keys(sample).sort());
    const ride = body.slice(body.indexOf("'ride', jsonb_build_object(") + "'ride', jsonb_build_object(".length);
    expect([...ride.matchAll(/^\s*'([a-z_]+)',/gm)].map((m) => m[1]!).sort()).toEqual(Object.keys(sample.ride).sort());
    expect(body).not.toMatch(/'(commission_cents|platform_fee_cents)'/);
    // Diffusion au chauffeur : son élément, jamais settlement_json ; jamais l'organisation du chauffeur
    const broadcast = lastSqlDefinition("private.broadcast_settlement");
    expect(broadcast).toContain("jsonb_build_object('action', p_action, 'network', true, 'item', private.network_settlement_item(x))");
    expect(broadcast).toContain("'driver:' || x.network_driver_id::text");
    expect(broadcast).not.toContain("network_driver_org_id::text");
  });

  it("RPC du chauffeur (argent) : noms des paramètres = NetworkRpcs (appel de l'app : apps/driver/src/lib/api.ts)", () => {
    type Args<K extends keyof NetworkRpcs> = Record<keyof NetworkRpcs[K]["args"], true>;
    const contract = {
      driver_payout_info: {} satisfies Args<"driver_payout_info">,
      driver_set_payout_details: { p_payee: true, p_iban: true, p_bic: true } satisfies Args<"driver_set_payout_details">,
      driver_delete_payout_details: {} satisfies Args<"driver_delete_payout_details">,
      driver_network_settlements: {} satisfies Args<"driver_network_settlements">,
      driver_declare_network_payment: { p_org: true, p_ids: true, p_method: true, p_note: true } satisfies Args<"driver_declare_network_payment">,
      driver_dispute_network_settlement: { p_id: true, p_reason: true } satisfies Args<"driver_dispute_network_settlement">,
    };
    for (const [fn, args] of Object.entries(contract)) {
      const body = lastSqlDefinition(`public.${fn}`);
      const signature = body.slice(body.indexOf("(") + 1, body.indexOf("\nreturns")).replace(/\)\s*$/, "");
      const params = signature.trim() === "" ? [] : signature.split(",").map((x) => x.trim().split(/\s+/)[0]!);
      expect(params, fn).toEqual(Object.keys(args));
      // Portée : le chauffeur connecté seulement
      expect(body, fn).toContain("private.current_driver_id()");
    }
  });

  it("échéances : reversement au moins 48 h (délai de A), versement sous 7 jours (NETWORK_PARAMS)", () => {
    expect(lastSqlDefinition("private.network_grace_hours")).toContain(`, 24), ${NETWORK_PARAMS.minDriverGraceHours});`);
    expect(lastSqlDefinition("private.sync_network_settlement")).toContain(`now() + interval '${NETWORK_PARAMS.payoutDays} days'`);
  });

  it("lisibilité du chauffeur (private.network_driver_readiness) : codes de DRIVER_NETWORK_READINESS_CODES, dans le même ordre", () => {
    const body = lastSqlDefinition("private.network_driver_readiness");
    const codes: string[] = [];
    for (const m of body.matchAll(/v_missing \|\| '([a-z_:]+)'::text|foreach v_type in array array\[([^\]]+)\]/g)) {
      if (m[1]) codes.push(m[1]);
      else codes.push(...[...m[2]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]!));
    }
    const expected = DRIVER_NETWORK_READINESS_CODES.filter((c) => c !== "terms_grace");
    expect(codes).toEqual([...expected]);
    expect(body).toContain("v_warnings := v_warnings || 'terms_grace'::text");
    expect(body).toContain(`interval '${NETWORK_PARAMS.appCapableDays} days'`);
  });
});
