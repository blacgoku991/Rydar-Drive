// Flotte Privée : textes et paramètres écrits en SQL (20260924007600, 20260924007700) = ceux de @rydar/shared —
// profils posés par les RPC, limites imposées, titres et motifs des notifications, règles des rappels, fenêtre de
// sonnerie, délais (« La prendre », agenda), états des réservations à traiter, raisons d'un passage refusé. Garde-fou
// pour toute redéfinition future : la DERNIÈRE définition de private.start_dispatch appelle la branche Flotte Privée
// avant le test auto_dispatch, celle de private.org_limits impose les limites après l'offre et la surcharge, celle de
// private.sync_ride_settlement exempte la fiche du gérant.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  PRIVATE_FLEET_AGENDA_MAX_DAYS, PRIVATE_FLEET_BLOCKERS, PRIVATE_FLEET_BOOKING_STATES, PRIVATE_FLEET_DISPATCH_PROFILE,
  PRIVATE_FLEET_LIMITS, PRIVATE_FLEET_NOTIFICATION_KINDS, PRIVATE_FLEET_REMINDER_RULES, PRIVATE_FLEET_RING_WINDOW_S,
  PRIVATE_FLEET_TAKE_MAX_AGE_HOURS, PRIVATE_FLEET_TITLES, PRIVATE_FLEET_UNCONFIRMED_REASONS, STANDARD_DISPATCH_PROFILE,
} from "./private-fleet";
import { ERROR_MESSAGES } from "./domain";

const MIGRATIONS = fileURLToPath(new URL("../../../supabase/migrations/", import.meta.url));
const files = readdirSync(MIGRATIONS).filter((x) => x.endsWith(".sql")).sort();

/** Corps de la DERNIÈRE définition d'une fonction SQL (« private.x »). */
function lastSqlDefinition(name: string): string {
  let body: string | null = null;
  const head = `create or replace function ${name}(`;
  for (const f of files) {
    const sql = readFileSync(`${MIGRATIONS}${f}`, "utf8");
    const at = sql.lastIndexOf(head);
    if (at === -1) continue;
    body = sql.slice(at, sql.indexOf("$$;", at));
  }
  if (!body) throw new Error(`${name} introuvable`);
  return body;
}

/** Littéraux JSON « '{…}'::jsonb » d'un corps SQL, dans l'ordre. */
const jsonLiterals = (body: string) => [...body.matchAll(/'(\{[^']*\})'::jsonb/g)].map((m) => JSON.parse(m[1]!) as Record<string, unknown>);

describe("Flotte Privée : SQL = @rydar/shared", () => {
  it("profils de dispatch posés par les RPC (private.dispatch_profile) = PRIVATE_FLEET_DISPATCH_PROFILE / STANDARD_DISPATCH_PROFILE", () => {
    const body = lastSqlDefinition("private.dispatch_profile");
    // 1er littéral : branche « then » (Flotte Privée) ; 2e : branche « else » (standard)
    expect(body).toMatch(/case when p_private\s+then '\{[^']*\}'::jsonb\s+else '\{[^']*\}'::jsonb\s+end/);
    const [privateProfile, standardProfile] = jsonLiterals(body);
    expect(privateProfile).toEqual(PRIVATE_FLEET_DISPATCH_PROFILE);
    expect(standardProfile).toEqual(STANDARD_DISPATCH_PROFILE);
    // Toutes les clés du profil sont écrites par private.apply_dispatch_profile
    const apply = lastSqlDefinition("private.apply_dispatch_profile");
    for (const key of Object.keys(PRIVATE_FLEET_DISPATCH_PROFILE)) expect(apply, key).toContain(`${key} = `);
    expect(lastSqlDefinition("public.svc_platform_create_private_fleet")).toContain("private.apply_dispatch_profile(v_org, true)");
    const set = lastSqlDefinition("public.svc_platform_set_private_fleet");
    expect(set).toContain("private.apply_dispatch_profile(p_org, true)");
    expect(set).toContain("private.apply_dispatch_profile(p_org, false)");
  });

  it("dernière définition de private.org_limits : 1 chauffeur et 1 accès imposés APRÈS l'offre et la surcharge", () => {
    const body = lastSqlDefinition("private.org_limits");
    const clause = body.indexOf("case when o.private_fleet then");
    expect(clause).toBeGreaterThan(body.indexOf("coalesce(o.limits_override, '{}'::jsonb))"));
    expect(jsonLiterals(body.slice(clause)).at(0)).toEqual(PRIVATE_FLEET_LIMITS);
  });

  it("dernière définition de private.start_dispatch : branche Flotte Privée avant le test auto_dispatch", () => {
    const body = lastSqlDefinition("private.start_dispatch");
    const branch = body.indexOf("perform private.private_fleet_dispatch(r.id);");
    expect(branch).toBeGreaterThan(-1);
    expect(branch).toBeLessThan(body.indexOf("if not coalesce(s.auto_dispatch, true) then"));
    expect(body).toContain("select name, timezone, private_fleet into v_org_name, v_tz, v_private");
  });

  it("dernière définition de private.sync_ride_settlement : aucun règlement pour la fiche du gérant (20260924007700)", () => {
    const body = lastSqlDefinition("private.sync_ride_settlement");
    const check = body.indexOf("own.owner_driver");
    expect(check).toBeGreaterThan(body.indexOf("if new.status <> 'COMPLETED' or new.driver_id is null or new.price_cents is null then"));
    expect(check).toBeLessThan(body.indexOf("insert into public.ride_settlements"));
  });

  it("titres, genres et motifs des notifications", () => {
    const dispatch = lastSqlDefinition("private.private_fleet_dispatch");
    const reminders = lastSqlDefinition("private.ride_offers_private_fleet_reminders");
    const unconfirmed = lastSqlDefinition("private.rides_private_fleet_unconfirmed");
    expect(dispatch).toContain(`title = '${PRIVATE_FLEET_TITLES.newBooking}'`);
    expect(dispatch).toContain(`'ride_unconfirmed', '${PRIVATE_FLEET_TITLES.toCheck}'`);
    expect(reminders).toContain(`'${PRIVATE_FLEET_TITLES.reminder}'`);
    expect(unconfirmed).toContain(`'ride_unconfirmed', '${PRIVATE_FLEET_TITLES.unconfirmed}'`);
    const [newKind, reminderKind] = PRIVATE_FLEET_NOTIFICATION_KINDS;
    expect(dispatch).toContain(`'kind', '${newKind}'`);
    expect(reminders).toContain(`'kind', '${reminderKind}'`);
    expect(reminders).toContain(`n.data ->> 'kind' = '${reminderKind}'`);
    const [notConfirmed, toCheck] = PRIVATE_FLEET_UNCONFIRMED_REASONS;
    expect(unconfirmed).toContain(`'reason', '${notConfirmed}'`);
    expect(dispatch).toContain(`'reason', '${toCheck}'`);
    // Jamais de ride_id dans les données d'une notification « ride_unconfirmed » (l'app 1.1.0 ouvrirait /ride/[id])
    for (const body of [dispatch, unconfirmed]) {
      const data = body.slice(body.indexOf("jsonb_build_object('type', 'ride_unconfirmed'"));
      expect(data.slice(0, data.indexOf("'high'"))).not.toContain("'ride_id'");
    }
  });

  it("fenêtre de sonnerie et règles des rappels", () => {
    expect(lastSqlDefinition("private.private_fleet_dispatch")).toContain(
      `c_ring_window constant interval := interval '${PRIVATE_FLEET_RING_WINDOW_S} seconds';`,
    );
    const reminders = lastSqlDefinition("private.ride_offers_private_fleet_reminders");
    const r = PRIVATE_FLEET_REMINDER_RULES;
    expect(reminders).toContain(`c_min_ahead constant interval := interval '${r.minAheadMinutes} minutes';`);
    expect(reminders).toContain(`c_last_call constant interval := interval '${r.lastCallMinutes} minutes';`);
    expect(reminders).toContain(`c_end_margin constant interval := interval '${r.endMarginMinutes} minutes';`);
    expect(reminders).toContain(`c_min_gap constant interval := interval '${r.minGapMinutes} minutes';`);
    expect(reminders).toContain(`c_max constant integer := ${r.max};`);
  });

  it("délais : « La prendre » (6 h après l'heure prévue), période de l'agenda (62 jours)", () => {
    expect(lastSqlDefinition("public.driver_take_ride")).toContain(`make_interval(hours => ${PRIVATE_FLEET_TAKE_MAX_AGE_HOURS})`);
    expect(lastSqlDefinition("private.private_fleet_unassigned")).toContain(`interval '${PRIVATE_FLEET_TAKE_MAX_AGE_HOURS} hours'`);
    expect(lastSqlDefinition("public.driver_agenda")).toContain(`interval '${PRIVATE_FLEET_AGENDA_MAX_DAYS} days'`);
  });

  it("états d'une réservation à traiter (private.private_fleet_unassigned) = PRIVATE_FLEET_BOOKING_STATES", () => {
    const body = lastSqlDefinition("private.private_fleet_unassigned");
    const states = [...body.matchAll(/(?:then|else) '([a-z_]+)'/g)].map((m) => m[1]!);
    expect([...new Set(states)].sort()).toEqual([...PRIVATE_FLEET_BOOKING_STATES].sort());
    // driver_home compte les réservations à vérifier ou non confirmées (ni offre en attente, ni refus)
    expect(lastSqlDefinition("public.driver_home")).toContain("u.state in ('to_check', 'not_confirmed')");
  });

  it("raisons d'un passage refusé (private.private_fleet_blockers) = PRIVATE_FLEET_BLOCKERS, dans l'ordre", () => {
    const body = lastSqlDefinition("private.private_fleet_blockers");
    expect([...body.matchAll(/then '([a-z_]+)' end/g)].map((m) => m[1]!)).toEqual([...PRIVATE_FLEET_BLOCKERS]);
  });

  it("codes renvoyés en JSON par les RPC de la Flotte Privée : libellés (annexe A)", () => {
    const rpcs = ["public.svc_platform_create_private_fleet", "public.svc_platform_attach_private_fleet_driver",
      "public.svc_platform_set_private_fleet", "public.driver_take_ride"].map(lastSqlDefinition).join("\n");
    const codes = new Set([...rpcs.matchAll(/'code', '([A-Z_]+)'/g)].map((m) => m[1]!));
    // Réponses de succès et codes génériques (message toujours renvoyé avec la réponse)
    for (const ok of ["CREATED", "UNCHANGED", "ACCEPTED", "INVALID", "NOT_FOUND", "RIDE_NOT_ASSIGNABLE"]) codes.delete(ok);
    const missing = [...codes].filter((c) => !ERROR_MESSAGES[c]);
    expect(missing).toEqual([]);
    expect(codes.size).toBeGreaterThanOrEqual(12);
  });
});
