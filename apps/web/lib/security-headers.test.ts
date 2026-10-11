import type { NextConfig } from "next";
import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match";
import { matchHas } from "next/dist/shared/lib/router/utils/prepare-destination";
import { afterEach, describe, expect, it, vi } from "vitest";

// apps/web/next.config.ts : en-têtes de sécurité selon l'hôte, appliqués comme Next le fait (correspondance du chemin
// puis has / missing ; la dernière règle qui correspond l'emporte).

async function loadConfig(env: Record<string, string>): Promise<NextConfig> {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  return (await import("../next.config")).default;
}

async function headersFor(config: NextConfig, host: string, pathname: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const rule of await config.headers!()) {
    if (!getPathMatch(rule.source, { strict: true, removeUnnamedParams: true })(pathname)) continue;
    if ((rule.has || rule.missing) && !matchHas({ headers: { host } } as never, {}, rule.has, rule.missing)) continue;
    for (const h of rule.headers) out.set(h.key.toLowerCase(), h.value);
  }
  return out;
}

const PROD = {
  NEXT_PUBLIC_APP_URL: "https://rydardrive.fr",
  NEXT_PUBLIC_ROOT_DOMAIN: "rydardrive.fr",
  // Supabase auto-hébergé (VPS)
  NEXT_PUBLIC_SUPABASE_URL: "https://api.rydardrive.fr",
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("next.config.ts : HSTS (audit p5 web-3)", () => {
  it("domaines de la plateforme (racine, www, sous-domaines des mini-sites) : includeSubDomains et preload", async () => {
    const config = await loadConfig(PROD);
    for (const host of ["rydardrive.fr", "www.rydardrive.fr", "elite-paris.rydardrive.fr", "eligibilite.rydardrive.fr:443"]) {
      for (const path of ["/", "/cgu", "/book/elite-paris", "/dashboard/rides"]) {
        expect((await headersFor(config, host, path)).get("strict-transport-security"), `${host}${path}`).toBe(
          "max-age=63072000; includeSubDomains; preload",
        );
      }
    }
  });

  it("domaine personnalisé d'une centrale : l'hôte seul, jamais ses autres sous-domaines ni la liste de préchargement", async () => {
    const config = await loadConfig(PROD);
    for (const host of ["taxi-elite.fr", "reservation.taxi-elite.fr", "domaine-tiers.fr", "rydardrive.fr.domaine-tiers.fr", "faux-rydardrive.fr"]) {
      for (const path of ["/", "/cgu", "/book/elite-paris"]) {
        expect((await headersFor(config, host, path)).get("strict-transport-security"), `${host}${path}`).toBe("max-age=31536000");
      }
    }
  });
});

describe("next.config.ts : CSP, connect-src (audit p5 web-4)", () => {
  it("Supabase auto-hébergé : son origine seule, aucun projet *.supabase.co joignable", async () => {
    const csp = (await headersFor(await loadConfig(PROD), "rydardrive.fr", "/dashboard")).get("content-security-policy")!;
    const connect = csp.split("; ").find((d) => d.startsWith("connect-src "))!;
    expect(connect).toContain("https://api.rydardrive.fr wss://api.rydardrive.fr");
    expect(connect).not.toContain("supabase.co");
  });

  it("Supabase hébergé : son origine seule (le joker *.supabase.co ouvrait tout autre projet)", async () => {
    const config = await loadConfig({ ...PROD, NEXT_PUBLIC_SUPABASE_URL: "https://abcd.supabase.co" });
    const csp = (await headersFor(config, "rydardrive.fr", "/")).get("content-security-policy")!;
    const connect = csp.split("; ").find((d) => d.startsWith("connect-src "))!;
    expect(connect).toContain("https://abcd.supabase.co wss://abcd.supabase.co");
    expect(connect).not.toContain("*.supabase.co");
  });
});
