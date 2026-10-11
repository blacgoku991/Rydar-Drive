import { describe, expect, it, vi } from "vitest";

// Audit p5 (admin-public-1) : Supabase Auth répond « user_banned » AVANT de vérifier le mot de passe ; le grant
// « password » est donc réservé au serveur web (/api/auth/driver-login, aucun oracle). L'app ne s'adresse jamais
// directement à Supabase Auth pour se connecter, même sans adresse d'API configurée.

const h = vi.hoisted(() => ({ direct: vi.fn(async () => ({ data: {}, error: { message: "User is banned", code: "user_banned" } })) }));

vi.mock("./config", () => ({ appConfig: { supabaseUrl: "https://abcdefghijklmnop.supabase.co", supabaseAnonKey: "anon", apiUrl: "" } }));
vi.mock("./supabase", () => ({ supabase: { auth: { signInWithPassword: h.direct, setSession: vi.fn() } } }));

const { signIn } = await import("./api");

describe("signIn sans adresse d'API", () => {
  it("refus « serveur non configuré », sans appel direct à Supabase Auth", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(signIn("chauffeur@exemple.fr", "mauvais")).rejects.toMatchObject({ code: "CONFIG" });
    expect(h.direct).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
