// Contrats du réseau partagé (lot 0) : exhaustivité des libellés, codes d'erreur, vocabulaire interdit, version de la
// convention alignée sur la migration qui la fixe.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DRIVER_BLOCKER_META } from "./centrale";
import { ERROR_MESSAGES, humanizeError } from "./domain";
import * as network from "./network";
import {
  DRIVER_NETWORK_READINESS_CODES, DRIVER_NETWORK_READINESS_META, NETWORK_BLOCKERS, NETWORK_BLOCKER_META, NETWORK_COUNTERPARTIES,
  NETWORK_ERROR_CODES, NETWORK_EXECUTION_END_LABELS, NETWORK_EXECUTION_END_REASONS, NETWORK_FORBIDDEN_WORDS, NETWORK_ORG_REASONS,
  NETWORK_READINESS_META, NETWORK_RPC_ACCESS, NETWORK_RPC_NAMES, NETWORK_SHARE_CLOSED_LABELS, NETWORK_SHARE_CLOSED_REASONS,
  NETWORK_SKIP_REASON_LABELS, NETWORK_SUSPECT_REASONS, NETWORK_SUSPECT_REASON_META, NETWORK_TERMS_VERSION,
  ORG_NETWORK_READINESS_CODES, ORG_NETWORK_READINESS_META, isNetworkBlocker, networkBlockerMessage, networkTermsOk,
} from "./network";

const MIGRATIONS = fileURLToPath(new URL("../../../supabase/migrations/", import.meta.url));

/** Toutes les chaînes d'une valeur (objets, tableaux) : pour le contrôle du vocabulaire. */
function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) strings(v, out);
  else if (value && typeof value === "object") for (const v of Object.values(value)) strings(v, out);
  return out;
}

describe("lisibilité (NETWORK_READINESS_META)", () => {
  it("chaque code de l'organisation a un libellé, une explication et au plus une action", () => {
    expect(Object.keys(ORG_NETWORK_READINESS_META).sort()).toEqual([...ORG_NETWORK_READINESS_CODES].sort());
    expect(new Set(ORG_NETWORK_READINESS_CODES).size).toBe(ORG_NETWORK_READINESS_CODES.length);
    for (const code of ORG_NETWORK_READINESS_CODES) {
      const m = ORG_NETWORK_READINESS_META[code];
      expect(m.label.length, code).toBeGreaterThan(3);
      expect(m.hint.length, code).toBeGreaterThan(10);
      if (m.action) expect(m.action.label.length, code).toBeGreaterThan(3);
    }
    expect(NETWORK_READINESS_META.organization).toBe(ORG_NETWORK_READINESS_META);
  });

  it("chaque code d'un chauffeur a un libellé, une explication et ses actions (app / organisation)", () => {
    expect(Object.keys(DRIVER_NETWORK_READINESS_META).sort()).toEqual([...DRIVER_NETWORK_READINESS_CODES].sort());
    expect(new Set(DRIVER_NETWORK_READINESS_CODES).size).toBe(DRIVER_NETWORK_READINESS_CODES.length);
    for (const code of DRIVER_NETWORK_READINESS_CODES) {
      const m = DRIVER_NETWORK_READINESS_META[code];
      expect(m.label.length, code).toBeGreaterThan(3);
      expect(m.hint.length, code).toBeGreaterThan(10);
      for (const step of [m.driver, m.organization]) if (step) expect(step.label.length, code).toBeGreaterThan(3);
    }
    expect(NETWORK_READINESS_META.driver).toBe(DRIVER_NETWORK_READINESS_META);
  });

  it("seul le délai de grâce de la convention est un simple avertissement", () => {
    const warnings = (meta: Record<string, { blocking: boolean }>) => Object.keys(meta).filter((k) => !meta[k]!.blocking);
    expect(warnings(ORG_NETWORK_READINESS_META)).toEqual(["terms_grace"]);
    expect(warnings(DRIVER_NETWORK_READINESS_META)).toEqual(["terms_grace"]);
    expect(ORG_NETWORK_READINESS_META.terms_grace.hint).toContain("{date}");
    expect(DRIVER_NETWORK_READINESS_META.excluded_until.hint).toContain("{date}");
  });

  it("les raisons SQL d'organisation (network_org_reason) sont toutes lisibles par l'organisation", () => {
    for (const r of NETWORK_ORG_REASONS) expect(ORG_NETWORK_READINESS_CODES as readonly string[], r).toContain(r);
  });

  it("les blocages « blocked:… » d'un chauffeur sont des règles de B (jamais celles d'une donneuse)", () => {
    const blocked = DRIVER_NETWORK_READINESS_CODES.filter((c) => c.startsWith("blocked:")).map((c) => c.slice("blocked:".length));
    expect(blocked).toEqual(["own_unpaid", "executor_limit"]);
    for (const b of blocked) expect(isNetworkBlocker(b), b).toBe(true);
  });
});

describe("blocages réseau (NETWORK_BLOCKER_META)", () => {
  it("un libellé et un message par raison, séparés des blocages propres (DRIVER_BLOCKER_META, aligné sur le SQL)", () => {
    expect(Object.keys(NETWORK_BLOCKER_META).sort()).toEqual([...NETWORK_BLOCKERS].sort());
    for (const b of NETWORK_BLOCKERS) expect(Object.keys(DRIVER_BLOCKER_META), b).not.toContain(b);
  });

  it("noms des organisations insérés : un impayé envers A ne bloque que les courses de A", () => {
    const m = networkBlockerMessage("giver_unpaid", { giver: "Taxi Bleu", executor: "Flotte Nord" });
    expect(m.message).toBe("Un impayé envers Taxi Bleu bloque seulement les courses de Taxi Bleu : réglez-le pour en recevoir à nouveau.");
    expect(networkBlockerMessage("executor_limit", { giver: "Taxi Bleu", executor: "Flotte Nord" }).message)
      .toBe("Plafond de Flotte Nord atteint : réglez d'abord vos courses partenaires.");
    for (const b of NETWORK_BLOCKERS) {
      const msg = networkBlockerMessage(b, { giver: "A", executor: "B" });
      expect(`${msg.label} ${msg.message}`, b).not.toMatch(/\{[a-z_]+\}/);
    }
    expect(isNetworkBlocker("unpaid")).toBe(false);
  });
});

describe("codes d'erreur SQL du réseau", () => {
  it("chaque code a un libellé dans ERROR_MESSAGES", () => {
    const missing = NETWORK_ERROR_CODES.filter((c) => !ERROR_MESSAGES[c]);
    expect(missing).toEqual([]);
    expect(new Set(NETWORK_ERROR_CODES).size).toBe(NETWORK_ERROR_CODES.length);
  });

  it("message PostgreSQL → libellé", () => {
    expect(humanizeError("NETWORK_RIDE_LOCKED: course confiée à un partenaire")).toBe(
      "Course confiée à un partenaire : retirez-la-lui pour la modifier.",
    );
    expect(humanizeError("OFFER_CHANGED")).toBe("La course a été modifiée : elle vous sera reproposée si elle est encore disponible.");
  });
});

describe("vocabulaire (§7.1) : Rydar est un logiciel de dispatch", () => {
  it("aucun mot interdit dans les libellés du réseau ni dans ses messages d'erreur", () => {
    const texts = [
      ...strings(Object.values(network).filter((v) => typeof v !== "function" && v !== NETWORK_FORBIDDEN_WORDS)),
      ...NETWORK_ERROR_CODES.map((c) => ERROR_MESSAGES[c]!),
    ].map((s) => s.toLowerCase());
    expect(texts.length).toBeGreaterThan(50);
    for (const word of NETWORK_FORBIDDEN_WORDS) {
      expect(texts.filter((t) => t.includes(word)), word).toEqual([]);
    }
  });
});

describe("états, raisons et catalogue des RPC", () => {
  it("libellés complets", () => {
    expect(Object.keys(NETWORK_SHARE_CLOSED_LABELS).sort()).toEqual([...NETWORK_SHARE_CLOSED_REASONS].sort());
    expect(Object.keys(NETWORK_EXECUTION_END_LABELS).sort()).toEqual([...NETWORK_EXECUTION_END_REASONS].sort());
    expect(Object.keys(NETWORK_SUSPECT_REASON_META).sort()).toEqual([...NETWORK_SUSPECT_REASONS].sort());
    for (const r of [...NETWORK_ORG_REASONS, "no_price", "no_payout", "no_partner_nearby"] as const) {
      expect(NETWORK_SKIP_REASON_LABELS[r], r).toBeTruthy();
    }
  });

  it("contrepartie : toujours le chauffeur (décision Q2)", () => {
    expect(NETWORK_COUNTERPARTIES).toEqual(["driver"]);
  });

  it("catalogue : svc_* réservées au service role, RPC chauffeur au chauffeur", () => {
    expect(NETWORK_RPC_NAMES.length).toBe(Object.keys(NETWORK_RPC_ACCESS).length);
    for (const name of NETWORK_RPC_NAMES) {
      const access = NETWORK_RPC_ACCESS[name];
      expect(name.startsWith("svc_"), name).toBe(access === "service_role");
      if (name.startsWith("driver_")) expect(access, name).toBe("driver");
    }
    // Actions d'argent réseau : owner / admin seulement (S9) ; relance : dispatcher compris
    for (const name of ["org_network_payout_info", "validate_network_ride", "contest_network_ride", "close_network_ride"] as const) {
      expect(NETWORK_RPC_ACCESS[name], name).toBe("owner_admin");
    }
    expect(NETWORK_RPC_ACCESS.remind_network_driver).toBe("member");
  });
});

describe("convention du réseau", () => {
  it("version AAAA-MM-JJ (versionnée à part de LEGAL_VERSION)", () => {
    expect(NETWORK_TERMS_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(new Date(`${NETWORK_TERMS_VERSION}T00:00:00Z`).toISOString().slice(0, 10)).toBe(NETWORK_TERMS_VERSION);
  });

  it("égale au défaut de platform_settings.network_terms_version de la dernière migration qui le fixe", () => {
    let last: string | null = null;
    for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith(".sql")).sort()) {
      const sql = readFileSync(`${MIGRATIONS}${f}`, "utf8");
      for (const m of sql.matchAll(/network_terms_version\s+(?:text\s+not\s+null\s+default|set\s+default)\s+'([^']+)'/gi)) last = m[1]!;
    }
    // Avant la migration du schéma réseau (lot 2), aucune version en base : rien à comparer.
    if (last !== null) expect(NETWORK_TERMS_VERSION).toBe(last);
  });

  it("network_terms_ok : version courante, ou précédente pendant la grâce seulement", () => {
    const terms = { version: "2026-12-01", min_version: "2026-11-01", grace_until: "2026-12-31T23:00:00Z" };
    const before = new Date("2026-12-15T12:00:00Z");
    const after = new Date("2027-01-02T12:00:00Z");
    expect(networkTermsOk("2026-12-01", terms, after)).toBe(true);
    expect(networkTermsOk("2026-11-01", terms, before)).toBe(true);
    expect(networkTermsOk("2026-11-01", terms, after)).toBe(false);
    expect(networkTermsOk("2026-10-01", terms, before)).toBe(false);
    expect(networkTermsOk("9999-12-31", terms, before)).toBe(false);
    expect(networkTermsOk(null, terms, before)).toBe(false);
    expect(networkTermsOk("2026-11-01", { ...terms, grace_until: null }, before)).toBe(false);
  });
});
