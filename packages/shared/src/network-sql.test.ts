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
  NETWORK_CLOSED_RPCS, NETWORK_EXECUTION_END_REASONS, NETWORK_GIVEN_FILTERS, NETWORK_OFFER_NOTIFICATION_KEYS, NETWORK_PARAMS,
  NETWORK_PARTNERS_NEARBY_MAX, NETWORK_PICKUP_HIDDEN_LABEL, NETWORK_RECEIVED_FILTERS, NETWORK_SHARE_CLOSED_REASONS, NETWORK_SKIP_REASON_LABELS,
  NETWORK_SUSPECT_REASONS, NETWORK_SUSPENDED_CREDITOR_RPCS, NETWORK_UNASSIGN_REASONS, NETWORK_WATCH_CAUSES,
  NETWORK_ONBOARD_STATUSES, NETWORK_RPC_ACCESS, NETWORK_WATCH_CAUSE_LABELS, ORG_NETWORK_READINESS_CODES, networkCancelBlocked, type DriverNetworkSettlementItem, type NetworkDriverMoney,
  type NetworkOfferNotificationData, type NetworkPayoutWarning, type NetworkRpcs, type RemindNetworkDriverResult,
  type NetworkDriverBroadcastFields, type NetworkRideBroadcastFields, NETWORK_ADMIN_THRESHOLDS, type NetworkAdminFlag,
  type SvcNetworkApproveResult,
} from "./network";
import type { PublicRide } from "./api-ride";
import type { EarningsPeriod, RideAlertBroadcast, RideAlertData } from "./types";

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
    // Lot argent (4b) : autre fiche du même chauffeur (mêmes empreintes) débitrice de A
    expect(identity.split("x.network_driver_id = o.driver_id").length - 1).toBe(1);
    expect(identity.split("x.network_driver_org_id is not null").length - 1).toBe(2);
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

  it("lot 7 (performance) : compteur « partenaires à proximité » plafonné (NETWORK_PARTNERS_NEARBY_MAX), un candidat suffit à l'arrêt anticipé, limite de la vague passée aux candidats", () => {
    expect(lastSqlDefinition("private.network_open")).toContain(`p_stage = 'scheduled_window', ${NETWORK_PARTNERS_NEARBY_MAX});`);
    expect(lastSqlDefinition("private.network_search_exhausted")).toContain("private.network_candidates(r, v_radius, false, 1)");
    expect(lastSqlDefinition("private.network_offer")).toContain("private.network_candidates(r, p_radius, v_scheduled, p_limit)");
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

describe("Réseau partagé, argent (partie 4b) : SQL = contrats de @rydar/shared", () => {
  it("RPC de A (argent) : noms des paramètres = NetworkRpcs (appel du web : app/dashboard/reseau-partage/actions.ts) ; droits", () => {
    type Args<K extends keyof NetworkRpcs> = Record<keyof NetworkRpcs[K]["args"], true>;
    const contract = {
      org_network_payout_info: { p_settlement: true } satisfies Args<"org_network_payout_info">,
      validate_network_ride: { p_ride: true } satisfies Args<"validate_network_ride">,
      contest_network_ride: { p_ride: true, p_reason: true } satisfies Args<"contest_network_ride">,
      remind_network_driver: { p_org: true, p_settlement: true } satisfies Args<"remind_network_driver">,
    };
    for (const [fn, args] of Object.entries(contract)) {
      const body = lastSqlDefinition(`public.${fn}`);
      const signature = body.slice(body.indexOf("(") + 1, body.indexOf("\nreturns")).replace(/\)\s*$/, "");
      const params = signature.trim() === "" ? [] : signature.split(",").map((x) => x.trim().split(/\s+/)[0]!);
      expect(params, fn).toEqual(Object.keys(args));
      // Argent : owner / admin de A (assert_network_creditor) ; « Relancer » : tout membre (dispatcher compris)
      expect(body, fn).toContain(fn === "remind_network_driver" ? "private.assert_org_member(p_org)" : "private.assert_network_creditor(");
      expect(NETWORK_RPC_ACCESS[fn as keyof NetworkRpcs], fn).toBe(fn === "remind_network_driver" ? "member" : "owner_admin");
    }
    // Les actions existantes sur un règlement contrôlent owner / admin de A pour une ligne réseau
    for (const fn of ["confirm_settlements", "dispute_settlement", "waive_settlement", "reopen_settlement"]) {
      expect(lastSqlDefinition(`public.${fn}`), fn).toContain("perform private.assert_network_creditor(");
    }
  });

  it("relance manuelle : codes et clés des réponses = RemindNetworkDriverResult (channels compris)", () => {
    const remind = lastSqlDefinition("public.remind_network_driver");
    const sample = {
      ok: true, code: "REMINDED", amount_cents: 1250, count: 1, channels: ["app"], message: "Rappel envoyé au chauffeur (application).",
      next_allowed_at: null,
    } satisfies Required<RemindNetworkDriverResult>;
    const responses = remind.split("return jsonb_build_object(").slice(1).map((r) => r.slice(0, r.indexOf(";")));
    expect(responses).toHaveLength(4);
    for (const r of responses) {
      for (const m of r.matchAll(/'([a-z_]+)', /g)) expect(Object.keys(sample), m[1]).toContain(m[1]);
    }
    const reminded = responses.find((r) => r.includes("'REMINDED'"))!;
    expect([...reminded.matchAll(/'([a-z_]+)', /g)].map((m) => m[1]!).sort()).toEqual(
      Object.keys(sample).filter((k) => k !== "next_allowed_at").sort(),
    );
    expect(reminded).toContain("'channels', jsonb_build_array('app')");
  });

  it("baisse demandée par « Contester la course » : jamais acceptée d'office, montrée à part au super admin (PlatformEntry.network_contest)", () => {
    const stale = lastSqlDefinition("private.accept_stale_platform_reductions");
    expect(stale).toMatch(/and not exists \(select 1 from public\.ride_network_executions n\s+where n\.ride_id = x\.ride_id and n\.contested_at is not null\)/);
    expect(lastSqlDefinition("private.platform_entry_json")).toContain(
      "jsonb_build_object('network_contest', jsonb_build_object('contested_at', n.contested_at))",
    );
  });

  it("gains par période : clés du réseau = EarningsPeriod (partner_rides, partner_part_cents) ; commission sur les seules courses propres", () => {
    const body = lastSqlDefinition("public.driver_earnings");
    const period = { partner_rides: 2, partner_part_cents: 3250 } satisfies Required<Pick<EarningsPeriod, "partner_rides" | "partner_part_cents">>;
    for (const k of Object.keys(period)) expect(body, k).toContain(`'${k}', a.${k}`);
    expect(body).toContain("'commission_cents', case when v_has_net then a.netted_revenue_cents - a.own_net_cents end");
  });

  it("relance manuelle : codes = RemindNetworkDriverResult, 1 par 30 min ; relances automatiques : 3 au plus, 23 h d'écart", () => {
    const remind = lastSqlDefinition("public.remind_network_driver");
    const codes = new Set([...remind.matchAll(/'code', '([A-Z_]+)'/g)].map((m) => m[1]!));
    expect([...codes].sort()).toEqual(["NOTHING_DUE", "REMINDED", "TOO_SOON"] satisfies RemindNetworkDriverResult["code"][]);
    expect(remind).toContain(`interval '${NETWORK_PARAMS.remindIntervalMinutes} minutes'`);
    const auto = lastSqlDefinition("private.settlement_reminders");
    const network = auto.slice(auto.indexOf("x.network_driver_id as driver_id"));
    expect(network).toContain(`having min(x.reminders_sent) < ${NETWORK_PARAMS.autoRemindersMax}`);
    expect(network).toContain(`< now() - interval '${NETWORK_PARAMS.autoRemindIntervalHours} hours'`);
    // Application seulement : jamais private.remind_driver (WhatsApp) pour une ligne réseau
    expect(network).not.toContain("private.remind_driver(");
    expect(network).toContain("private.network_notify(");
  });

  it("RIB : avertissement « recent_change » à 72 h ; contestation dans les 7 jours (NETWORK_PARAMS)", () => {
    const payout = lastSqlDefinition("public.org_network_payout_info");
    expect(payout).toContain(`interval '${NETWORK_PARAMS.payoutRecentChangeHours} hours'`);
    for (const w of ["iban_changed", "recent_change"] satisfies NetworkPayoutWarning[]) expect(payout).toContain(`'${w}'::text`);
    // Audit sans aucune coordonnée bancaire
    const audit = payout.slice(payout.indexOf("insert into public.audit_logs"), payout.indexOf("perform private.network_notify("));
    expect(audit).not.toMatch(/iban|payee|bic/);
    expect(lastSqlDefinition("public.contest_network_ride")).toContain(`interval '${NETWORK_PARAMS.contestDays} days'`);
  });

  it("notifications du chauffeur partenaire (private.network_notify) : data.network, jamais de montant interne", () => {
    const notify = lastSqlDefinition("private.network_notify");
    expect(notify).toContain("jsonb_build_object('type', p_type, 'network', true)");
    for (const fn of ["public.confirm_settlements", "public.dispute_settlement", "public.waive_settlement", "public.reopen_settlement",
      "public.org_network_payout_info", "public.validate_network_ride", "public.contest_network_ride", "public.remind_network_driver"]) {
      const body = lastSqlDefinition(fn);
      for (const call of body.split("private.network_notify(").slice(1)) {
        const args = call.slice(0, call.indexOf(";"));
        expect(args, fn).not.toMatch(/'(commission_cents|platform_fee_cents|driver_payout_cents|giver_cut_cents)'/);
      }
    }
  });
});

describe("Réseau partagé, accès (partie 5a, 20260924007000) : SQL = contrats de @rydar/shared", () => {
  type Args<K extends keyof NetworkRpcs> = Record<keyof NetworkRpcs[K]["args"], true>;
  const contract = {
    driver_offers_v2: {} satisfies Args<"driver_offers_v2">,
    driver_ride: { p_ride: true } satisfies Args<"driver_ride">,
    driver_rides_upcoming: {} satisfies Args<"driver_rides_upcoming">,
    driver_network_state: {} satisfies Args<"driver_network_state">,
    driver_network_ping: {} satisfies Args<"driver_network_ping">,
    driver_set_network: { p_enabled: true, p_version: true } satisfies Args<"driver_set_network">,
    org_network_summary: { p_org: true } satisfies Args<"org_network_summary">,
    org_network_given: {
      p_org: true, p_filter: true, p_partner: true, p_month: true, p_limit: true, p_before: true,
    } satisfies Args<"org_network_given">,
    org_network_ride: { p_ride: true } satisfies Args<"org_network_ride">,
    network_partner_names: { p_org: true } satisfies Args<"network_partner_names">,
    exclude_network_driver: { p_execution: true, p_reason: true } satisfies Args<"exclude_network_driver">,
    org_network_driver_exclusions: { p_org: true } satisfies Args<"org_network_driver_exclusions">,
    lift_network_driver_exclusion: { p_org: true, p_id: true } satisfies Args<"lift_network_driver_exclusion">,
    org_network_received: {
      p_org: true, p_filter: true, p_partner: true, p_month: true, p_limit: true, p_before: true,
    } satisfies Args<"org_network_received">,
    org_network_activity: { p_org: true } satisfies Args<"org_network_activity">,
    org_network_drivers: { p_org: true } satisfies Args<"org_network_drivers">,
    set_driver_network_allowed: { p_driver: true, p_allowed: true } satisfies Args<"set_driver_network_allowed">,
  };

  it("RPC du chauffeur, de A et de B : noms des paramètres = NetworkRpcs (appels du web et de l'app) ; contrôle d'accès dans la fonction", () => {
    for (const [fn, args] of Object.entries(contract)) {
      const body = lastSqlDefinition(`public.${fn}`);
      const signature = body.slice(body.indexOf("(") + 1, body.indexOf("\nreturns")).replace(/\)\s*$/, "");
      const params = signature.trim() === "" ? [] : signature.split(",").map((x) => x.trim().split(/\s+/)[0]!);
      expect(params, fn).toEqual(Object.keys(args));
      expect(body, fn).toContain("security definer");
      const access = NETWORK_RPC_ACCESS[fn as keyof NetworkRpcs];
      if (access === "driver") expect(body, fn).toContain("private.current_driver_id()");
      else if (access === "owner_admin") expect(body, fn).toContain("array['owner', 'admin']::public.org_role[]");
      else expect(body, fn).toMatch(/private\.assert_network_reader\(p_org\)|private\.assert_org_member\((p_org|r\.organization_id)\)/);
      // Réseau fermé : NETWORK_DISABLED, sauf les sommes et courses en cours (NETWORK_CLOSED_RPCS) et les lectures
      // générales de l'app (offres, course, planning)
      const always = (NETWORK_CLOSED_RPCS as readonly string[]).includes(fn) || ["driver_offers_v2", "driver_ride", "driver_rides_upcoming"].includes(fn);
      expect(body.includes("private.assert_network_open()"), fn).toBe(!always);
    }
    // A suspendue : seules les lectures prévues passent par private.assert_network_reader (owner / admin)
    for (const fn of ["org_network_summary", "org_network_given", "network_partner_names"]) {
      expect((NETWORK_SUSPENDED_CREDITOR_RPCS as readonly string[]).includes(fn), fn).toBe(true);
      expect(lastSqlDefinition(`public.${fn}`), fn).toContain("private.assert_network_reader(p_org)");
    }
    for (const fn of ["org_network_received", "org_network_activity"]) {
      expect(lastSqlDefinition(`public.${fn}`), fn).toContain("private.assert_org_member(p_org)");
    }
  });

  it("filtres des listes = NETWORK_GIVEN_FILTERS / NETWORK_RECEIVED_FILTERS", () => {
    const given = lastSqlDefinition("public.org_network_given");
    const received = lastSqlDefinition("public.org_network_received");
    const allowed = (body: string) => [...body.slice(body.indexOf("if v_filter not in (")).split(")")[0]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(allowed(given)).toEqual(NETWORK_GIVEN_FILTERS.map((f) => f.key));
    expect(allowed(received)).toEqual(NETWORK_RECEIVED_FILTERS.map((f) => f.key));
  });

  it("lisibilité de l'organisation (private.org_network_readiness) : codes de ORG_NETWORK_READINESS_CODES, dans le même ordre", () => {
    const body = lastSqlDefinition("private.org_network_readiness");
    const codes = [...body.matchAll(/\|\| '([a-z_]+)'::text/g)].map((m) => m[1]!);
    expect(codes.filter((c) => c !== "terms_grace")).toEqual(ORG_NETWORK_READINESS_CODES.filter((c) => c !== "terms_grace"));
    expect(body).toContain("v_warnings := v_warnings || 'terms_grace'::text");
  });

  it("paramètres fixes (NETWORK_PARAMS) : coordonnées à 0,003°, client de prise en charge − 60 min à fin + 60 min, téléphones 48 h / 30 jours", () => {
    expect(lastSqlDefinition("private.network_round_coord")).toContain(`(p / ${NETWORK_PARAMS.coordStepDegrees})`);
    expect(lastSqlDefinition("private.network_round_coord")).toContain(`* ${NETWORK_PARAMS.coordStepDegrees})`);
    const ride = lastSqlDefinition("private.driver_ride_json");
    expect(ride).toContain(`r.pickup_at - interval '${NETWORK_PARAMS.clientDataBeforeMinutes} minutes'`);
    expect(ride).toContain(`e.ended_at + interval '${NETWORK_PARAMS.clientDataAfterMinutes} minutes'`);
    const phone = lastSqlDefinition("private.network_phone_until");
    expect(phone).toContain(`interval '${NETWORK_PARAMS.phoneAfterHours} hours'`);
    expect(phone).toContain(`interval '${NETWORK_PARAMS.phoneMaxDays} days'`);
    for (const fn of ["public.driver_offers_v2", "private.driver_ride_json"]) {
      expect(lastSqlDefinition(fn), fn).toContain(`'${NETWORK_PICKUP_HIDDEN_LABEL}'`);
    }
  });

  it("offre partenaire : UN montant (NetworkDriverMoney), jamais commission ni frais Rydar ; ni tracé, ni commentaire, ni n° de vol", () => {
    const body = lastSqlDefinition("public.driver_offers_v2");
    const money = body.slice(body.indexOf("'money', jsonb_build_object("));
    const keys = [...money.slice(0, money.indexOf("'counterparty', 'driver'") + 30).matchAll(/'([a-z_]+)', /g)].map((m) => m[1]).slice(1);
    const expected = ["price_cents", "currency", "payment_method", "collects", "driver_part_cents", "giver_part_cents", "direction",
      "amount_cents", "counterparty"] as const satisfies ReadonlyArray<keyof NetworkDriverMoney>;
    expect(keys).toEqual([...expected]);
    for (const k of ["route_polyline", "flight_number", "comment", "commission_cents", "platform_fee_cents", "dispatch_model"]) {
      expect(body, k).toContain(`'${k}', null`);
    }
  });
});

describe("Réseau partagé, partie 5b (20260924007000) : journaux, temps réel, notifications, webhooks = contrats", () => {
  const keysOf = (body: string, after: string) =>
    [...body.slice(body.indexOf(after)).split(")")[0]!.matchAll(/'([a-z_]+)', /g)].map((m) => m[1]!);

  it("diffusions org:{A} / org:{B} : clés « network* » = NetworkRideBroadcastFields / NetworkDriverBroadcastFields", () => {
    const ride = lastSqlDefinition("private.broadcast_ride");
    const rideKeys = ["network", "network_execution_id"] as const satisfies ReadonlyArray<keyof NetworkRideBroadcastFields>;
    expect(keysOf(ride, "then jsonb_build_object('network'")).toEqual([...rideKeys]);
    expect(ride).toContain("'driver_id', case when v_partner then null else v.driver_id end");
    const driver = lastSqlDefinition("private.broadcast_driver");
    const driverKeys = ["network", "network_giver"] as const satisfies ReadonlyArray<keyof NetworkDriverBroadcastFields>;
    expect(keysOf(driver, "then jsonb_build_object('network'")).toEqual([...driverKeys]);
    expect(driver).toContain("'current_ride_id', case when v_giver is null then new.current_ride_id end");
    // Q5 : aucune position diffusée pendant une course d'une autre organisation
    expect(lastSqlDefinition("private.broadcast_driver_location")).toContain("if private.driver_on_foreign_ride(new.driver_id) then");
  });

  it("alertes d'un chauffeur partenaire : clés retirées et ajoutées = RideAlertData / RideAlertBroadcast (facultatives)", () => {
    const apply = lastSqlDefinition("private.apply_ride_alert");
    const removed = [...apply.slice(apply.indexOf("v_data := (v_data - array[")).split("]")[0]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
    const optional = ["driver_id", "driver_number", "lat", "lng"] as const satisfies ReadonlyArray<keyof RideAlertData>;
    expect(removed).toEqual([...optional]);
    // Jamais requises par le contrat (clés absentes pour un partenaire) ; « network » ajoutée
    const sample: RideAlertData = { alert_id: "a", ride_number: 1, driver_name: "Karim T. · Flotte B", actions: ["keep"], network: true };
    expect(sample.driver_id).toBeUndefined();
    expect(apply).toContain("'network', true");
    const payload = lastSqlDefinition("private.ride_alert_payload");
    const broadcast: Pick<RideAlertBroadcast, "driver_id" | "network"> = { driver_id: null, network: true };
    expect(Object.keys(broadcast).every((k) => payload.includes(`'${k}'`))).toBe(true);
  });

  it("notifications : montants retirés (déclencheur notifications_scrub_money) = ceux jamais montrés à un partenaire", () => {
    const scrub = lastSqlDefinition("private.notifications_scrub_money");
    const keys = [...scrub.slice(scrub.indexOf("new.data - array[")).split("]")[0]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
    expect(keys).toEqual(["commission_cents", "platform_fee_cents", "driver_payout_cents"]);
    for (const k of keys) expect(NETWORK_OFFER_NOTIFICATION_KEYS as readonly string[], k).not.toContain(k);
  });

  it("API et webhooks : objet « driver » de public.ride_public_driver = PublicRide.driver (operator du partenaire seulement)", () => {
    const fn = lastSqlDefinition("public.ride_public_driver");
    const keys = [...new Set([...fn.matchAll(/'(first_name|vehicle|operator)'/g)].map((m) => m[1]!))].sort();
    const contract = ["first_name", "operator", "vehicle"] as const satisfies ReadonlyArray<keyof NonNullable<PublicRide["driver"]>>;
    expect(keys).toEqual([...contract]);
    expect(fn).toContain("interval '24 hours'");
    expect(lastSqlDefinition("private.webhook_ride_json")).toContain("'driver', public.ride_public_driver(r)");
    const api = readFileSync(fileURLToPath(new URL("../../../apps/web/lib/api/v1.ts", import.meta.url)), "utf8");
    expect(/PUBLIC_RIDE_SELECT\s*=\s*"([^"]+)"/.exec(api)?.[1]?.endsWith("driver:ride_public_driver")).toBe(true);
  });

  it("journal : clés de chauffeur filtrées par private.network_event_scrub (filet de sécurité de private.log_event)", () => {
    const scrub = lastSqlDefinition("private.network_event_scrub");
    for (const k of ["driver_id", "previous_driver_id", "assigned_driver_id", "driver_ids", "driver_number", "driver_name", "lat", "lng", "network_count"]) {
      expect(scrub, k).toContain(`'${k}'`);
    }
    expect(lastSqlDefinition("private.log_event")).toContain("private.network_event_scrub(p_org, v_message, v_data)");
    expect(lastSqlDefinition("private.log_event")).toContain("private.event_actor(p_org, p_ride, v_type, v_actor)");
    expect(lastSqlDefinition("private.track_ride_status")).toContain("private.event_actor(new.organization_id, new.id,");
  });
});

describe("Réseau partagé, administration (lot 6, 20260924007100) : SQL = contrats de @rydar/shared", () => {
  type Args<K extends keyof NetworkRpcs> = Record<keyof NetworkRpcs[K]["args"], true>;
  const contract = {
    svc_set_shared_network_enabled: { p_actor: true, p_enabled: true } satisfies Args<"svc_set_shared_network_enabled">,
    svc_network_approve: {
      p_actor: true, p_org: true, p_approved: true, p_fee_waiver: true, p_reason: true,
    } satisfies Args<"svc_network_approve">,
    svc_network_suspend: { p_actor: true, p_org: true, p_suspended: true, p_reason: true } satisfies Args<"svc_network_suspend">,
    admin_network_overview: {} satisfies Args<"admin_network_overview">,
    org_network_readiness: { p_org: true } satisfies Args<"org_network_readiness">,
    network_driver_readiness: { p_driver: true } satisfies Args<"network_driver_readiness">,
    set_network_settings: {
      p_org: true, p_share_out: true, p_share_in: true, p_terms_version: true, p_insurance_confirmed: true,
      p_executor_credit_limit_cents: true,
    } satisfies Args<"set_network_settings">,
    set_network_exclusion: { p_org: true, p_partner: true, p_excluded: true } satisfies Args<"set_network_exclusion">,
  };

  it("noms des paramètres = NetworkRpcs (appels du web) ; contrôle d'accès dans la fonction ; réseau fermé : NETWORK_DISABLED, sauf le super admin", () => {
    for (const [fn, args] of Object.entries(contract)) {
      const body = lastSqlDefinition(`public.${fn}`);
      const signature = body.slice(body.indexOf("(") + 1, body.indexOf("\nreturns")).replace(/\)\s*$/, "");
      const params = signature.trim() === "" ? [] : signature.split(",").map((x) => x.trim().split(/\s+/)[0]!);
      expect(params, fn).toEqual(Object.keys(args));
      expect(body, fn).toContain("security definer");
      const access = NETWORK_RPC_ACCESS[fn as keyof NetworkRpcs];
      if (access === "service_role") expect(body, fn).toContain("private.assert_platform_actor(p_actor)");
      else if (access === "super_admin") expect(body, fn).toContain("private.is_super_admin()");
      else if (access === "owner_admin") expect(body, fn).toContain("private.assert_org_member(p_org, array['owner', 'admin']::public.org_role[])");
      else if (access === "owner_admin_or_driver") {
        expect(body, fn).toContain("private.current_driver_id()");
        expect(body, fn).toContain("array['owner', 'admin']::public.org_role[]");
      } else expect(body, fn).toContain("private.assert_org_member(p_org)");
      const platform = access === "service_role" || access === "super_admin";
      expect(body.includes("private.assert_network_open()"), fn).toBe(!platform);
      expect((NETWORK_CLOSED_RPCS as readonly string[]).includes(fn), fn).toBe(false);
    }
  });

  it("super admin : seuils signalés = NETWORK_ADMIN_THRESHOLDS ; validation : codes et champs manquants = SvcNetworkApproveResult", () => {
    const row = lastSqlDefinition("private.admin_network_org_row");
    const T = NETWORK_ADMIN_THRESHOLDS;
    expect(row).toContain(`when v_offers.received >= ${T.minOffersForRatio} then v_offers.accepted::numeric / v_offers.received < ${T.minAcceptanceRatio}`);
    expect(row).toContain(`v_releases >= ${T.releases}`);
    expect(row).toContain(`v_contested >= ${T.contests}`);
    expect(row).toContain(`x.due_at < now() - interval '${T.payoutOverdueDays} days'`);
    const flags = [...row.matchAll(/v_flags := v_flags \|\| '([a-z_]+)'::text/g)].map((m) => m[1]);
    expect(flags).toEqual(["low_acceptance", "releases", "contests", "payout_overdue"] satisfies NetworkAdminFlag[]);
    const approve = lastSqlDefinition("public.svc_network_approve");
    const codes = new Set([...approve.matchAll(/'code', (?:case when p_approved then )?'([A-Z_]+)'(?: else '([A-Z_]+)' end)?/g)].flatMap((m) => [m[1], m[2]].filter(Boolean)));
    expect([...codes].sort()).toEqual((["APPROVED", "IDENTITY_INCOMPLETE", "NOT_FOUND", "REASON_REQUIRED", "REFUSED"] satisfies SvcNetworkApproveResult["code"][]).sort());
    const missing = [...approve.matchAll(/v_missing := v_missing \|\| '([a-z_]+)'::text/g)].map((m) => m[1]);
    expect(missing).toEqual(["legal_name", "siret", "vtc_registration"] satisfies NonNullable<SvcNetworkApproveResult["missing"]>);
  });

  it("« Annuler » masqué (web) pour une course partenaire client à bord : mêmes statuts que private.cancel_ride_internal", () => {
    const cancel = lastSqlDefinition("private.cancel_ride_internal");
    const statuses = NETWORK_ONBOARD_STATUSES.map((x) => `'${x}'`).join(", ");
    expect(cancel).toMatch(new RegExp(`if r\\.status in \\(${statuses}\\) and r\\.driver_id is not null\\s+and r\\.driver_org_id <> r\\.organization_id`));
    expect(cancel).toContain("'NETWORK_RIDE_IN_PROGRESS'");
    expect(networkCancelBlocked("PASSENGER_ONBOARD", true)).toBe(true);
    expect(networkCancelBlocked("IN_PROGRESS", true)).toBe(true);
    expect(networkCancelBlocked("DRIVER_ARRIVED", true)).toBe(false);
    expect(networkCancelBlocked("IN_PROGRESS", false)).toBe(false);
  });

  it("alerte « partenaire indisponible » : causes du chien de garde = mots du journal (private.network_watch)", () => {
    const watch = lastSqlDefinition("private.network_watch");
    for (const [cause, label] of Object.entries(NETWORK_WATCH_CAUSE_LABELS)) {
      if (cause === "driver_withdrawn") expect(watch).toContain(`else '${label}'`);
      else expect(watch).toContain(`when '${cause}' then '${label}'`);
    }
  });
});
