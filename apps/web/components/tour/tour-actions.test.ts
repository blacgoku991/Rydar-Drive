import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Visite guidée (docs/TUTORIEL.md § 4.3) : action serveur saveTourProgress (app/visite/actions.ts). Entrée contrôlée
// par le schéma partagé AVANT toute session ou écriture ; écriture par la seule RPC save_user_tour, pour l'utilisateur
// connecté (aucun identifiant transmis) ; erreur de la base → message, jamais d'exception. Session et base simulées.

const h = vi.hoisted(() => ({
  calls: [] as { fn: string; args: Record<string, unknown> }[],
  sessions: 0,
  error: null as { code?: string; message?: string } | null,
}));

vi.mock("@/lib/auth", () => ({
  requireUser: async () => {
    h.sessions++;
    return {
      user: { id: "u1" },
      supabase: {
        rpc: async (fn: string, args: Record<string, unknown>) => {
          h.calls.push({ fn, args });
          return h.error ? { data: null, error: h.error } : { data: { tour: args.p_tour }, error: null };
        },
      },
    };
  },
}));
vi.mock("@/lib/errors", async () => await import("../../lib/errors"));

const { saveTourProgress } = await import("../../app/visite/actions");

beforeEach(() => {
  h.calls.length = 0;
  h.sessions = 0;
  h.error = null;
});

describe("saveTourProgress", () => {
  it("entrée invalide : refusée sans session ni appel à la base", async () => {
    const bad = [
      { tour: "inconnu", status: "active", step: 0 },
      { tour: "fleet", status: "termine", step: 0 },
      { tour: "fleet", status: "active", step: -1 },
      { tour: "fleet", status: "active", step: 5 },
      { tour: "fleet", status: "active", step: 1.5 },
      { tour: "fleet", status: "active", step: Number.NaN },
      { tour: "fleet", status: "active" } as unknown as { tour: string; status: string; step: number },
      null as unknown as { tour: string; status: string; step: number },
    ];
    for (const input of bad) {
      expect(await saveTourProgress(input)).toEqual({ ok: false, error: "Visite guidée : étape inconnue." });
    }
    expect(h.sessions).toBe(0);
    expect(h.calls).toEqual([]);
  });

  it("entrée valide : rpc(\"save_user_tour\", { p_tour, p_status, p_step }) pour l'utilisateur connecté", async () => {
    expect(await saveTourProgress({ tour: "centrale", status: "active", step: 2 })).toEqual({ ok: true });
    expect(await saveTourProgress({ tour: "super_admin", status: "completed", step: 4 })).toEqual({ ok: true });
    expect(await saveTourProgress({ tour: "private_fleet", status: "paused", step: 0 })).toEqual({ ok: true });
    expect(h.calls).toEqual([
      { fn: "save_user_tour", args: { p_tour: "centrale", p_status: "active", p_step: 2 } },
      { fn: "save_user_tour", args: { p_tour: "super_admin", p_status: "completed", p_step: 4 } },
      { fn: "save_user_tour", args: { p_tour: "private_fleet", p_status: "paused", p_step: 0 } },
    ]);
  });

  it("clé en plus (identifiant d'un autre utilisateur) : jamais transmise", async () => {
    const input = { tour: "fleet", status: "active", step: 1, user_id: "u2", p_user: "u2" } as { tour: string; status: string; step: number };
    expect(await saveTourProgress(input)).toEqual({ ok: true });
    expect(h.calls).toEqual([{ fn: "save_user_tour", args: { p_tour: "fleet", p_status: "active", p_step: 1 } }]);
  });

  it("erreur de la base : { ok: false } avec un message, jamais d'exception", async () => {
    h.error = { code: "42501", message: "FORBIDDEN: authentification requise" };
    expect(await saveTourProgress({ tour: "fleet", status: "active", step: 1 })).toEqual({ ok: false, error: "Accès refusé." });
    h.error = { code: "PGRST202", message: "Could not find the function public.save_user_tour" };
    expect(await saveTourProgress({ tour: "fleet", status: "active", step: 1 })).toEqual({
      ok: false,
      error: "Progression de la visite non enregistrée.",
    });
    h.error = { code: "08006", message: "connection failure" };
    const r = await saveTourProgress({ tour: "dispatcher", status: "paused", step: 3 });
    expect(r.ok).toBe(false);
  });

  it("fichier « use server » : une seule exportation, asynchrone, sans client service role ni audit", () => {
    const src = readFileSync(join(import.meta.dirname, "..", "..", "app", "visite", "actions.ts"), "utf8");
    expect(src.startsWith('"use server";')).toBe(true);
    expect([...src.matchAll(/^export\s+(\w+(?:\s+\w+)?)/gm)].map((m) => m[1])).toEqual(["async function"]);
    const code = src.replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/createAdminClient|audit\(|revalidatePath/);
    expect(code).toContain('rpc("save_user_tour"');
  });
});
