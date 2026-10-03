import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// Règle de perf (CLAUDE.md) : chaque <Link> du tableau de bord déclare prefetch (un préchargement = rendu serveur complet
// de la page visée, authentification comprise, pour CHAQUE lien visible : une ligne de tableau, un clic sur une course…).
const WEB = join(import.meta.dirname, "..", "..");
// Site public (vitrine, pages légales, mini-sites) et espace super admin : hors tableau de bord des centrales
const SKIP = /components\/(admin|marketing|legal|booking)\/|components\/platform-fees\/admin-/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === "node_modules" || name.startsWith(".")) return [];
    if (statSync(path).isDirectory()) return files(path);
    return /\.tsx$/.test(name) && !/\.test\.tsx$/.test(name) ? [path] : [];
  });
}

describe("liens du tableau de bord", () => {
  it("aucun <Link> sans attribut prefetch explicite (app/dashboard et composants hors site public / super admin)", () => {
    const missing: string[] = [];
    for (const root of ["app/dashboard", "components"]) {
      for (const file of files(join(WEB, root))) {
        const rel = relative(WEB, file).replace(/\\/g, "/");
        if (SKIP.test(rel)) continue;
        const src = readFileSync(file, "utf8");
        if (!src.includes('from "next/link"')) continue;
        for (const m of src.matchAll(/<Link\b/g)) {
          const at = m.index ?? 0;
          // Attributs du lien : jusqu'à la fin de la balise ouvrante (« /> » d'un enfant ou « </Link> » viennent après)
          const rest = src.slice(at);
          const ends = [rest.indexOf("/>"), rest.indexOf("</Link>")].filter((i) => i >= 0);
          const tag = rest.slice(0, ends.length ? Math.min(...ends) : 400);
          if (!/\bprefetch=/.test(tag)) missing.push(`${rel}:${src.slice(0, at).split("\n").length}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
