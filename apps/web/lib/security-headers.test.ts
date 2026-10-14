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

async function loadCsp(env: Record<string, string>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  return import("./csp");
}

const directive = (csp: string, name: string) => csp.split("; ").find((d) => d.startsWith(`${name} `))!;

describe("lib/csp.ts : CSP à nonce, connect-src (audit p5 web-4)", () => {
  it("Supabase auto-hébergé : son origine seule, aucun projet *.supabase.co joignable", async () => {
    const { contentSecurityPolicy } = await loadCsp(PROD);
    const connect = directive(contentSecurityPolicy({ nonce: "n", frameAncestors: "'none'" }), "connect-src");
    expect(connect).toContain("https://api.rydardrive.fr wss://api.rydardrive.fr");
    expect(connect).not.toContain("supabase.co");
  });

  it("Supabase hébergé : son origine seule (le joker *.supabase.co ouvrait tout autre projet)", async () => {
    const { contentSecurityPolicy } = await loadCsp({ ...PROD, NEXT_PUBLIC_SUPABASE_URL: "https://abcd.supabase.co" });
    const connect = directive(contentSecurityPolicy({ nonce: "n", frameAncestors: "'none'" }), "connect-src");
    expect(connect).toContain("https://abcd.supabase.co wss://abcd.supabase.co");
    expect(connect).not.toContain("*.supabase.co");
  });

  it("scripts : nonce de la requête + strict-dynamic, jamais 'unsafe-inline' ni joker (scanner Rustine)", async () => {
    const { contentSecurityPolicy, cspNonce } = await loadCsp({ ...PROD, NODE_ENV: "production" });
    const nonce = cspNonce();
    const csp = contentSecurityPolicy({ nonce, frameAncestors: "'none'" });
    expect(directive(csp, "script-src")).toBe(`script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`);
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("nonce : 128 bits en base64, différent à chaque appel", async () => {
    const { cspNonce } = await loadCsp(PROD);
    const all = new Set(Array.from({ length: 50 }, cspNonce));
    expect(all.size).toBe(50);
    for (const n of all) expect(n).toMatch(/^[A-Za-z0-9+/]{22}==$/);
  });

  it("cadre : seuls /book et /embed s'intègrent ailleurs", async () => {
    const { frameableOnAnySite } = await loadCsp(PROD);
    expect(frameableOnAnySite("/book/elite")).toBe(true);
    expect(frameableOnAnySite("/embed")).toBe(true);
    for (const p of ["/", "/booking", "/dashboard", "/login", "/bookx"]) expect(frameableOnAnySite(p), p).toBe(false);
  });

  it("next.config.ts ne pose plus de CSP statique (le proxy la pose, avec son nonce)", async () => {
    const config = await loadConfig(PROD);
    for (const path of ["/", "/dashboard", "/book/elite"]) {
      expect((await headersFor(config, "rydardrive.fr", path)).has("content-security-policy"), path).toBe(false);
    }
  });
});

describe("CSP à nonce : aucune page statique (ses scripts n'auraient pas le nonce)", () => {
  it("ni force-static, ni revalidate de page, ni « use cache » dans app/", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const appDir = join(__dirname, "..", "app");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(tsx?|jsx?)$/.test(e.name) && !/\.test\./.test(e.name)) {
          const src = readFileSync(p, "utf8");
          if (/force-static|export const revalidate\s*=\s*(?!0\b)|^\s*["']use cache["']/m.test(src)) offenders.push(p.slice(appDir.length));
        }
      }
    };
    walk(appDir);
    expect(offenders).toEqual([]);
  });

  it("layout racine : lit la requête (rendu à la demande) et passe le nonce au script en ligne", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(__dirname, "..", "app", "layout.tsx"), "utf8");
    expect(src).toMatch(/\(await headers\(\)\)\.get\("x-nonce"\)/);
    for (const tag of src.match(/<script\b[^>]*>/g) ?? []) expect(tag).toContain("nonce={nonce}");
  });
});
