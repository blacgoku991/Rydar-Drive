import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// « Mot de passe oublié » du tableau de bord par le serveur (audit p5, admin-public-2) : le navigateur n'appelle plus
// /auth/v1/recover (429 au second envoi seulement si le compte existe) ; réponse identique, envoi après la réponse,
// limites par IP et par adresse.

const h = vi.hoisted(() => ({
  later: [] as (() => Promise<void>)[],
  sent: [] as { email: string; redirectTo?: string; flowType?: string }[],
  limited: false,
  keys: [] as string[],
}));

vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({ after: (fn: () => Promise<void>) => void h.later.push(fn) }));
vi.mock("@/lib/env", () => ({ env: { supabaseUrl: "https://supabase.test", supabaseAnonKey: "anon", appUrl: "https://app.rydar.test" } }));
vi.mock("@/lib/server-fetch", () => ({ serverFetch: fetch }));
vi.mock("@/lib/request", async () => ({ ...(await import("./request")), clientIp: async () => "203.0.113.7" }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/rate-limit", () => ({
  rateLimitAll: async (checks: { key: string }[]) => {
    h.keys.push(...checks.map((c) => c.key));
    return { ok: !h.limited, remaining: 0, resetAt: Date.now() + 120_000, limit: 1 };
  },
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: (_url: string, _key: string, opts: { auth?: { flowType?: string } }) => ({
    auth: {
      resetPasswordForEmail: async (email: string, o: { redirectTo?: string }) => {
        h.sent.push({ email, redirectTo: o.redirectTo, flowType: opts.auth?.flowType });
        // Compte inconnu ou limite d'envoi de Supabase : erreur journalisée côté serveur, jamais renvoyée
        return { error: email.startsWith("inconnu") ? { status: 429, code: "over_email_send_rate_limit", message: "only request this after 59 seconds" } : null };
      },
    },
  }),
}));

const { requestPasswordReset } = await import("../app/forgot-password/actions");

beforeEach(() => {
  h.later.length = 0;
  h.sent.length = 0;
  h.keys.length = 0;
  h.limited = false;
});

describe("requestPasswordReset (tableau de bord)", () => {
  it("réponse identique, compte existant ou non ; e-mail envoyé après la réponse, flux implicite vers /auth/set-password", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const a = await requestPasswordReset({ email: "  Gerant@Exemple.FR " });
    const b = await requestPasswordReset({ email: "inconnu@exemple.fr" });
    expect(a).toEqual({ ok: true });
    expect(b).toEqual(a);
    expect(h.sent).toEqual([]); // rien avant la réponse
    for (const fn of h.later) await fn();
    expect(h.sent).toEqual([
      { email: "gerant@exemple.fr", redirectTo: "https://app.rydar.test/auth/set-password", flowType: "implicit" },
      { email: "inconnu@exemple.fr", redirectTo: "https://app.rydar.test/auth/set-password", flowType: "implicit" },
    ]);
    expect(h.keys).toContain("reset:ip:203.0.113.7");
    expect(h.keys).toContain("reset:email:gerant@exemple.fr");
  });

  it("adresse invalide ou limite atteinte : refus, aucun envoi", async () => {
    expect(await requestPasswordReset({ email: "pas-une-adresse" })).toEqual({ ok: false, error: "Adresse e-mail invalide." });
    h.limited = true;
    expect(await requestPasswordReset({ email: "gerant@exemple.fr" })).toMatchObject({ ok: false, error: expect.stringMatching(/^Trop de demandes/) });
    expect(h.later).toEqual([]);
  });

  it("la page n'appelle plus Supabase Auth depuis le navigateur", () => {
    const page = readFileSync(join(import.meta.dirname, "..", "app", "forgot-password", "page.tsx"), "utf8");
    expect(page).not.toMatch(/resetPasswordForEmail|getBrowserClient/);
    expect(page).toContain("requestPasswordReset");
  });
});
