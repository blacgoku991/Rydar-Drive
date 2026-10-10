import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// Règle de perf (CLAUDE.md) : chaque <Link> des espaces connectés déclare prefetch (un préchargement = rendu serveur
// complet de la page visée, authentification comprise, pour CHAQUE lien visible : une ligne de tableau, un clic sur une
// course…). Tableau de bord ET super admin (docs/REFONTE-PANELS.md § 3.11 : app/admin, components/admin et
// components/platform-fees/admin-* ne sont plus exclus).
// Accessibilité (RGAA 13.2, WCAG 3.2.5) : un lien qui ouvre un nouvel onglet (target="_blank") le dit, par NewTabHint
// dans son contenu ou un aria-label qui dit « nouvel onglet ».
const WEB = join(import.meta.dirname, "..", "..");
const ROOTS = ["app/dashboard", "app/admin", "components"];
// Site public (vitrine, pages légales, mini-sites, test d'éligibilité) : hors espaces connectés
const SKIP = /components\/(marketing|legal|booking|eligibility)\//;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === "node_modules" || name.startsWith(".")) return [];
    if (statSync(path).isDirectory()) return files(path);
    return /\.tsx$/.test(name) && !/\.test\.tsx$/.test(name) ? [path] : [];
  });
}

/** Fichiers des espaces connectés : chemin relatif à apps/web et contenu. */
function sources(): { rel: string; src: string }[] {
  return ROOTS.flatMap((root) =>
    files(join(WEB, root))
      .map((file) => ({ rel: relative(WEB, file).replace(/\\/g, "/"), file }))
      .filter(({ rel }) => !SKIP.test(rel))
      .map(({ rel, file }) => ({ rel, src: readFileSync(file, "utf8") })),
  );
}

const lineOf = (src: string, at: number) => src.slice(0, at).split("\n").length;

/**
 * Élément JSX ouvert à `at` (« <a », « <Link ») : balise ouvrante et contenu jusqu'à sa fermeture (« /> » de la
 * balise, sinon la fermeture du même nom au même niveau).
 */
function element(src: string, at: number): { open: string; whole: string } {
  const name = /^<([A-Za-z]+)/.exec(src.slice(at))![1]!;
  // Fin de la balise ouvrante : premier « > » hors accolades et hors chaînes
  let depth = 0;
  let quote: string | null = null;
  let end = at + 1;
  for (; end < src.length; end++) {
    const c = src[end]!;
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0) break;
  }
  const open = src.slice(at, end + 1);
  if (open.endsWith("/>")) return { open, whole: open };
  // Contenu : jusqu'à la fermeture correspondante (éléments du même nom imbriqués comptés)
  const re = new RegExp(`<${name}\\b|</${name}>`, "g");
  re.lastIndex = end + 1;
  let level = 1;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    level += m[0].startsWith("</") ? -1 : 1;
    if (level === 0) return { open, whole: src.slice(at, m.index + m[0].length) };
  }
  return { open, whole: src.slice(at) };
}

describe("liens des espaces connectés (tableau de bord et super admin)", () => {
  it("aucun <Link> sans attribut prefetch explicite (app/dashboard, app/admin, composants hors site public)", () => {
    const missing: string[] = [];
    for (const { rel, src } of sources()) {
      if (!src.includes('from "next/link"')) continue;
      for (const m of src.matchAll(/<Link\b/g)) {
        const at = m.index ?? 0;
        // Attributs du lien : jusqu'à la fin de la balise ouvrante (« /> » d'un enfant ou « </Link> » viennent après)
        const rest = src.slice(at);
        const ends = [rest.indexOf("/>"), rest.indexOf("</Link>")].filter((i) => i >= 0);
        const tag = rest.slice(0, ends.length ? Math.min(...ends) : 400);
        if (!/\bprefetch=/.test(tag)) missing.push(`${rel}:${lineOf(src, at)}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("le super admin est bien contrôlé (pages, composants, cartes des frais Rydar)", () => {
    const rels = sources().map((s) => s.rel);
    for (const expected of ["app/admin/page.tsx", "components/admin/headcount.tsx", "components/platform-fees/admin-platform-sections.tsx"]) {
      expect(rels).toContain(expected);
    }
  });

  it("tout lien target=\"_blank\" annonce le nouvel onglet (NewTabHint ou aria-label « nouvel onglet »)", () => {
    const silent: string[] = [];
    let checked = 0;
    for (const { rel, src } of sources()) {
      for (const m of src.matchAll(/<(a|Link)\b/g)) {
        const at = m.index ?? 0;
        const { open, whole } = element(src, at);
        if (!/\btarget=(\{\s*)?["']_blank["']/.test(open)) continue;
        checked++;
        const hinted = /<NewTabHint\b/.test(whole) || /aria-label=[^>]*nouvel onglet/.test(open);
        if (!hinted) silent.push(`${rel}:${lineOf(src, at)}`);
      }
    }
    expect(checked).toBeGreaterThan(10);
    expect(silent).toEqual([]);
  });
});
