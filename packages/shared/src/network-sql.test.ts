// Textes et paramètres du réseau partagé écrits en SQL (dispatch, 20260924006800) = ceux de @rydar/shared : messages
// de blocage (private.network_blocker_message ↔ NETWORK_BLOCKER_META), raisons de non-partage du journal
// (private.network_skip_label ↔ NETWORK_SKIP_REASON_LABELS), paramètres fixes de la v1 (NETWORK_PARAMS).
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ACCEPT_OFFER_CODES, NETWORK_BLOCKER_META, NETWORK_BLOCKERS, NETWORK_PARAMS, NETWORK_SKIP_REASON_LABELS,
} from "./network";

const MIGRATIONS = fileURLToPath(new URL("../../../supabase/migrations/", import.meta.url));

/**
 * Corps de la DERNIÈRE définition d'une fonction SQL dans les migrations (« private.x » ; pour une surcharge, début
 * exact de la signature : « private.x(d public.drivers, … »).
 */
function lastSqlDefinition(signature: string): string {
  let body: string | null = null;
  const head = signature.includes("(") ? `function ${signature}` : `function ${signature}(`;
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
