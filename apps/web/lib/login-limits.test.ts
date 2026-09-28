import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
// Pas d'alias « @/ » dans le projet vitest « unit » : même méthode que les autres tests de lib/
vi.mock("@/lib/request", async () => await import("./request"));

const { loginLimits } = await import("./login-limits");

/** Limiteur à fenêtre fixe, comme lib/rate-limit.ts : règles vérifiées dans l'ordre, arrêt à la première dépassée. */
function limiter() {
  const counts = new Map<string, number>();
  return (rules: { key: string; limit: number }[]) => {
    for (const r of rules) {
      const n = (counts.get(r.key) ?? 0) + 1;
      counts.set(r.key, n);
      if (n > r.limit) return false;
    }
    return true;
  };
}

describe("Connexion au tableau de bord : limites (lib/login-limits.ts)", () => {
  const email = "gerant@centrale.fr";

  it("un tiers qui connaît l'adresse ne bloque pas le gérant depuis d'autres IP", () => {
    const allow = limiter();
    // 7 sources différentes épuisent chacune leur couple (adresse, IP) : 42 essais sur l'adresse
    for (let s = 1; s <= 7; s++) for (let i = 0; i < 10; i++) allow(loginLimits(email, `203.0.113.${s}`));
    // Le vrai gérant, depuis son IP, peut toujours se connecter
    expect(allow(loginLimits(email, "198.51.100.20"))).toBe(true);
  });

  it("même IP : 6 essais par adresse, puis refus", () => {
    const allow = limiter();
    const results = Array.from({ length: 7 }, () => allow(loginLimits(email, "198.51.100.20")));
    expect(results).toEqual([true, true, true, true, true, true, false]);
  });

  it("IPv6 : les adresses d'un même /64 partagent le même compteur", () => {
    const allow = limiter();
    for (let i = 1; i <= 6; i++) expect(allow(loginLimits(email, `2001:db8:1:2::${i.toString(16)}`))).toBe(true);
    expect(allow(loginLimits(email, "2001:db8:1:2:ffff::9"))).toBe(false);
    expect(allow(loginLimits(email, "2001:db8:1:3::1"))).toBe(true);
  });

  it("plafond global de l'adresse : une attaque répartie finit refusée", () => {
    const allow = limiter();
    let accepted = 0;
    for (let s = 0; s < 40; s++) for (let i = 0; i < 6; i++) if (allow(loginLimits(email, `192.0.2.${s}`))) accepted++;
    expect(accepted).toBe(60);
  });
});
