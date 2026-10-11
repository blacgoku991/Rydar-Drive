import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// Rôles ARIA posés à la main sur des éléments HTML (ARIA in HTML du W3C ; règles axe « aria-allowed-role » et
// « listitem »). Constat de la revue de la refonte : cinq zones défilantes du super admin écrites
// <ul tabIndex={0} role="region">. Le rôle « region » remplace celui de liste : la liste disparaît et ses <li> n'ont plus
// de liste parente (WCAG 1.3.1, niveau A). Forme attendue : un div nommé qui défile et CONTIENT la liste,
//   <div className="max-h-… overflow-y-auto" tabIndex={0} role="region" aria-label="…"><ul className="divide-y …">…</ul></div>
// (`divide-y` sur la liste : il vise ses enfants directs ; `@container` sur la zone : les variantes `@…:` des lignes
// interrogent l'ancêtre conteneur le plus proche).
const WEB = join(import.meta.dirname, "..", "..");
const ROOTS = ["app", "components"];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === "node_modules" || name.startsWith(".")) return [];
    if (statSync(path).isDirectory()) return files(path);
    return /\.tsx$/.test(name) && !/\.test\.tsx$/.test(name) ? [path] : [];
  });
}

/** Attribut JSX : texte brut de sa valeur et chaînes littérales qu'elle peut prendre (`{ouvert ? "dialog" : undefined}`). */
type Attr = { raw: string; strings: string[] };
/** Élément HTML (balise en minuscules, jamais un composant) d'un fichier, avec ses attributs écrits en clair. */
type Tag = { at: string; tag: string; attrs: Map<string, Attr> };

/** Éléments HTML d'un fichier, lus par le compilateur TypeScript (attributs sur plusieurs lignes compris). */
function tagsOf(rel: string, src: string): Tag[] {
  const sf = ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: Tag[] = [];
  const visit = (node: ts.Node) => {
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && /^[a-z][\w-]*$/.test(node.tagName.getText(sf))) {
      const attrs = new Map<string, Attr>();
      for (const attr of node.attributes.properties) {
        if (!ts.isJsxAttribute(attr)) continue;
        const strings: string[] = [];
        const collect = (n: ts.Node) => {
          if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) strings.push(n.text);
          ts.forEachChild(n, collect);
        };
        if (attr.initializer) collect(attr.initializer);
        attrs.set(attr.name.getText(sf), { raw: attr.initializer?.getText(sf) ?? "", strings });
      }
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      out.push({ at: `${rel}:${line}`, tag: node.tagName.getText(sf), attrs });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

const TAGS = ROOTS.flatMap((root) => files(join(WEB, root))).flatMap((file) =>
  tagsOf(relative(WEB, file).replace(/\\/g, "/"), readFileSync(file, "utf8")),
);

const roles = (t: Tag) => t.attrs.get("role")?.strings ?? [];
const named = (t: Tag) => t.attrs.has("aria-label") || t.attrs.has("aria-labelledby");

/**
 * Rôles permis par ARIA in HTML (https://www.w3.org/TR/html-aria/) en plus du rôle implicite : liste (ul, ol) et
 * élément de liste (li). Ni « region » ni aucun autre repère : une zone qui défile entoure la liste.
 */
const LIST_ROLES = ["list", "group", "listbox", "menu", "menubar", "none", "presentation", "radiogroup", "tablist", "toolbar", "tree"];
const ALLOWED: Record<string, readonly string[]> = {
  ul: LIST_ROLES,
  ol: LIST_ROLES,
  li: ["listitem", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "none", "presentation", "radio", "separator", "tab", "treeitem"],
};

/** Zone qui défile d'elle-même, rendue atteignable au clavier (flèches) : tabIndex={0} et débordement « auto » ou « scroll ». */
const isScrollZone = (t: Tag) =>
  /^\{\s*0\s*\}$/.test(t.attrs.get("tabIndex")?.raw ?? "") && /\boverflow-(?:[xy]-)?(?:auto|scroll)\b/.test(t.attrs.get("className")?.raw ?? "");

describe("rôles ARIA posés à la main (ARIA in HTML)", () => {
  it("le relevé lit bien les pages (super admin compris) et les attributs écrits sur plusieurs lignes", () => {
    expect(TAGS.some((t) => t.at.startsWith("app/admin/dispatch/page.tsx:") && t.tag === "ul")).toBe(true);
    // <div / role="region" / aria-label=…> écrit sur plusieurs lignes (bandeau des conditions)
    expect(TAGS.some((t) => t.at.startsWith("components/legal/terms-banner.tsx:") && roles(t).includes("region") && named(t))).toBe(true);
  });

  it("listes (ul, ol) et éléments de liste (li) : seulement un rôle permis pour eux, jamais « region »", () => {
    const misused = TAGS.filter((t) => t.tag in ALLOWED)
      .flatMap((t) => roles(t).filter((role) => !ALLOWED[t.tag]!.includes(role)).map((role) => `${t.at} <${t.tag} role="${role}">`));
    expect(misused).toEqual([]);
  });

  it("zone défilante atteignable au clavier : un div role=\"region\" nommé (jamais la liste elle-même)", () => {
    const zones = TAGS.filter(isScrollZone);
    // Super admin : alertes et courses sans chauffeur (Dispatch & erreurs), chauffeurs connectés, alertes et
    // notifications (fiche client) ; pages légales : tableaux larges
    expect(zones.filter((t) => t.at.startsWith("app/admin/")).length).toBeGreaterThanOrEqual(5);
    const wrong = zones.filter((t) => t.tag !== "div" || !roles(t).includes("region") || !named(t)).map((t) => `${t.at} <${t.tag}>`);
    expect(wrong).toEqual([]);
  });

  it("toute zone role=\"region\" est nommée (aria-label ou aria-labelledby) : sans nom, ce n'est pas un repère", () => {
    const regions = TAGS.filter((t) => roles(t).includes("region"));
    expect(regions.length).toBeGreaterThanOrEqual(8);
    expect(regions.filter((t) => !named(t)).map((t) => t.at)).toEqual([]);
  });
});
