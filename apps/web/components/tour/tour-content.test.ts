import { RIDE_FILTERS, TOUR_KEYS, TOUR_MAX_STEPS, type TourKey } from "@rydar/shared";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { fr } from "../marketing/typo";
import { dashboardNav } from "../shell/dashboard-nav";
import { TOURS, type TourDef } from "./tour-content";

// Visite guidée (docs/TUTORIEL.md § 7.1, § 9.1, lot T3) : contrôle statique des 5 parcours — nombre d'étapes, longueurs,
// liens « Ouvrir … », typographie française (fr()), lexique de la refonte ; chaque élément désigné existe une fois et
// une seule dans les pages (attribut data-tour) ; chaque adresse mène à une page existante, avec un onglet ou un filtre
// connu ; chaque parcours n'envoie que vers des pages ouvertes à son profil (Flotte Privée : jamais une page masquée et
// refusée). Les écrans sont nommés comme dans le menu ou les onglets.

const WEB = join(import.meta.dirname, "..", "..");
const read = (rel: string) => readFileSync(join(WEB, rel), "utf8");
const NBSP = "\u00a0";
const ALL = TOUR_KEYS.map((key) => TOURS[key]);
const steps = (def: TourDef) => [...def.steps];

/** Sources des pages et composants (tests exclus). */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(WEB, dir), { withFileTypes: true })) {
    const rel = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules" && !entry.name.startsWith(".")) out.push(...sources(rel));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(rel);
  }
  return out;
}
const CODE = [...sources("app"), ...sources("components")].map((file) => ({ file, src: read(file) }));

/** Valeurs posées par `data-tour="…"` ou `data-tour={… "…" …}` dans une source. */
function anchorValues(src: string): string[] {
  const values = [...src.matchAll(/\bdata-tour="([a-z0-9-]+)"/g)].map((m) => m[1]!);
  for (const m of src.matchAll(/\bdata-tour=\{([^}]*)\}/g)) values.push(...[...m[1]!.matchAll(/"([a-z0-9-]+)"/g)].map((v) => v[1]!));
  return values;
}

/** Page d'une adresse : app/<chemin>/page.tsx. */
const pageFile = (pathname: string) => join("app", ...pathname.split("/").filter(Boolean), "page.tsx");
const url = (href: string) => new URL(href, "http://visite.invalid");

/** Onglets des Réglages (clé, libellé), lus dans la page : organisation standard et Flotte Privée. */
function settingsTabs(name: "TABS" | "PRIVATE_TABS"): { key: string; label: string }[] {
  const src = read("app/dashboard/settings/page.tsx");
  const block = new RegExp(`const ${name} = \\[([\\s\\S]*?)\\] as const;`).exec(src)?.[1] ?? "";
  return [...block.matchAll(/\{ key: "([a-z]+)", label: "([^"]+)" \}/g)].map((m) => ({ key: m[1]!, label: m[2]! }));
}
const TABS = settingsTabs("TABS");
const PRIVATE_TABS = settingsTabs("PRIVATE_TABS");

/** Menu du super admin (adminNav, coquille « use client » : lu dans la source). */
const ADMIN_MENU = [...read("components/shell/admin-shell.tsx").matchAll(/href: "(\/admin[^"]*)",\s*label: "([^"]+)"/g)].map((m) => ({
  href: m[1]!,
  label: m[2]!,
}));

/** Entrées du menu d'un profil du tableau de bord (adresse, libellé). */
const menu = (privateFleet: boolean, model: "fleet" | "centrale", role: string) =>
  dashboardNav({ privateFleet, model, role, flags: { bookingSites: true, rydarFees: true } }).flatMap((s) => s.items.map((i) => ({ href: i.href, label: i.label })));

/** Écrans ouverts à chaque parcours : entrées de menu (et onglets des Réglages permis). */
const PROFILE: Record<TourKey, { menus: { href: string; label: string }[][]; tabs: { key: string; label: string }[] }> = {
  super_admin: { menus: [ADMIN_MENU], tabs: [] },
  fleet: { menus: [menu(false, "fleet", "owner"), menu(false, "fleet", "admin")], tabs: TABS.filter((t) => t.key !== "centrale") },
  centrale: { menus: [menu(false, "centrale", "owner"), menu(false, "centrale", "admin")], tabs: TABS },
  dispatcher: { menus: [menu(false, "fleet", "dispatcher"), menu(false, "centrale", "dispatcher")], tabs: [] },
  private_fleet: { menus: [menu(true, "fleet", "owner")], tabs: PRIVATE_TABS },
};

const NUMBERS = ["Zéro", "Une", "Deux", "Trois", "Quatre", "Cinq"];
const PAUSE = fr("Vous pouvez arrêter à tout moment : la visite se reprend depuis votre nom, en bas du menu.");

/** Mots que l'écran ne dit plus (docs/REFONTE-PANELS.md § 4 ; docs/TUTORIEL.md § 7.1). */
const FORBIDDEN: RegExp[] = [
  /dashboard/i,
  /\btenant/i,
  /rattacheur/i,
  /\bOption [12]\b/i,
  /\bpush\b/i,
  /instantanée/i,
  /créer et dispatcher/i,
  /frais plateforme/i,
  /webhook/i,
  /\bAPI\b/,
  /messages? signalés?/i,
  /commission reçue/i,
  /identité de la centrale/i,
  /relancer le dispatch/i,
  /\btimeline\b/i,
  /\bMRR\b/,
  /annuler la dette/i,
];

/** Tous les textes affichés d'un parcours. */
const texts = (def: TourDef) => [
  def.intro.title,
  def.intro.text,
  ...def.steps.flatMap((s) => [s.title, s.text, s.linkLabel]),
];

describe("parcours : structure (§ 7.1)", () => {
  it("un parcours par clé de TOUR_KEYS, de 1 à 5 étapes (TOUR_MAX_STEPS)", () => {
    expect(Object.keys(TOURS).sort()).toEqual([...TOUR_KEYS].sort());
    for (const key of TOUR_KEYS) {
      expect(TOURS[key].key).toBe(key);
      expect(TOURS[key].steps.length, key).toBeGreaterThanOrEqual(1);
      expect(TOURS[key].steps.length, key).toBeLessThanOrEqual(TOUR_MAX_STEPS);
    }
  });

  it("identifiants d'étape uniques (tous parcours confondus) ; titres uniques dans un parcours", () => {
    const ids = ALL.flatMap((def) => def.steps.map((s) => s.id));
    expect(new Set(ids).size).toBe(ids.length);
    for (const def of ALL) expect(new Set(def.steps.map((s) => s.title)).size, def.key).toBe(def.steps.length);
  });
});

describe("parcours : textes (§ 7.1)", () => {
  it("accueil : titre ≤ 48 caractères ; texte ≤ 180, qui commence par le nombre d'étapes en lettres et finit par la phrase de pause", () => {
    for (const def of ALL) {
      expect(def.intro.title.length, def.key).toBeLessThanOrEqual(48);
      expect(def.intro.text.length, def.key).toBeLessThanOrEqual(180);
      const count = def.steps.length;
      expect(def.intro.text.startsWith(`${NUMBERS[count]} étape${count > 1 ? "s" : ""} `), def.key).toBe(true);
      expect(def.intro.text.endsWith(` ${PAUSE}`), def.key).toBe(true);
    }
  });

  it("étapes : titre ≤ 40 caractères, texte ≤ 180, lien ≤ 32 commençant par « Ouvrir »", () => {
    for (const s of ALL.flatMap(steps)) {
      expect(s.title.length, s.id).toBeLessThanOrEqual(40);
      expect(s.text.length, s.id).toBeLessThanOrEqual(180);
      expect(s.linkLabel.length, s.id).toBeLessThanOrEqual(32);
      expect(s.linkLabel, s.id).toMatch(/^Ouvrir /);
      expect(s.title.trim(), s.id).toBe(s.title);
      expect(s.text, s.id).toMatch(/[.?!»)]$/);
    }
  });

  it("typographie française : textes passés par fr() (espace insécable avant « : ; ! ? » et dans les guillemets)", () => {
    for (const def of ALL) {
      for (const t of texts(def)) {
        expect(fr(t), def.key).toBe(t);
        expect(t, def.key).not.toMatch(/ [:;!?»]/);
        expect(t, def.key).not.toMatch(/« /);
        expect(t, def.key).not.toMatch(/\s{2,}/);
      }
    }
    // Garde-fou : le contrôle voit bien une espace ordinaire avant les deux-points
    expect(fr("Visite : étape")).toContain(`${NBSP}:`);
  });

  it("lexique de la refonte : aucun mot retiré de l'écran (« dashboard », « API », « frais plateforme »…)", () => {
    for (const def of ALL) {
      for (const t of texts(def)) for (const word of FORBIDDEN) expect(t, `${def.key} : ${word}`).not.toMatch(word);
    }
    // Les clés de parcours ne s'affichent jamais (« centrale » et « dispatcher » restent des mots de l'écran)
    for (const def of ALL) for (const t of texts(def)) for (const key of ["super_admin", "private_fleet", "fleet"]) expect(t).not.toMatch(new RegExp(`\\b${key}\\b`));
  });
});

describe("éléments désignés (§ 9.1)", () => {
  const anchors = [...new Set(ALL.flatMap((def) => def.steps.map((s) => s.anchor.id)))];

  it("chaque ancre est posée une fois et une seule (data-tour) dans apps/web/app et apps/web/components", () => {
    for (const id of anchors) {
      const where = CODE.flatMap(({ file, src }) => anchorValues(src).filter((v) => v === id).map(() => file));
      expect(where, id).toHaveLength(1);
    }
  });

  it("aucune ancre posée hors des parcours (rien d'orphelin)", () => {
    const posed = CODE.flatMap(({ src }) => anchorValues(src));
    expect([...new Set(posed)].sort()).toEqual([...anchors].sort());
  });

  it("21 ancres, aux emplacements du § 9.1 (contrôles : boutons ; zones : cartes, listes)", () => {
    const where = Object.fromEntries(anchors.map((id) => [id, CODE.find(({ src }) => anchorValues(src).includes(id))!.file]));
    expect(where).toEqual({
      "sa-legal-editor": "components/admin/legal-form.tsx",
      "sa-billing": "components/platform-fees/admin-billing.tsx",
      "sa-new-plan": "components/admin/admin-widgets.tsx",
      "sa-new-client": "components/admin/new-client.tsx",
      "sa-todo": "app/admin/page.tsx",
      "org-identity": "components/settings/organization-form.tsx",
      "pricing-grid": "components/settings/pricing-editor.tsx",
      "centrale-commission": "components/settlements/centrale-settings-form.tsx",
      "drivers-add": "components/drivers/driver-form-sheet.tsx",
      "join-link": "components/network/join-link-card.tsx",
      "live-new-ride": "components/command/command-center.tsx",
      "live-panel": "components/command/command-center.tsx",
      "team-add-member": "components/settings/team-panel.tsx",
      "rides-filters": "app/dashboard/rides/page.tsx",
      "messages-threads": "components/chat/messages-view.tsx",
      "dispatch-journal": "components/dispatch/dispatch-journal.tsx",
      "fp-first-steps": "components/private-fleet/private-home.tsx",
      "fp-to-treat": "components/private-fleet/private-home.tsx",
      "fp-booking-settings": "components/settings/private-booking-settings.tsx",
      "agenda-views": "components/agenda/agenda-views.tsx",
      "fp-site-status": "app/dashboard/site/page.tsx",
    });
    // « Nouvelle offre » seulement (pas « Modifier » d'une offre existante)
    expect(read("components/admin/admin-widgets.tsx")).toContain('data-tour={plan ? undefined : "sa-new-plan"}');
  });

  it("type d'ancre : un contrôle est ancré à côté (côté et alignement connus) ; une zone n'a ni côté ni alignement", () => {
    for (const s of ALL.flatMap(steps)) {
      expect(["control", "zone"], s.id).toContain(s.anchor.kind);
      if (s.anchor.kind === "zone") expect([s.anchor.side, s.anchor.align], s.id).toEqual([undefined, undefined]);
      else {
        expect(["top", "right", "bottom", "left"], s.id).toContain(s.anchor.side);
        expect(["start", "center", "end"], s.id).toContain(s.anchor.align);
      }
    }
  });
});

describe("adresses des étapes", () => {
  it("chaque adresse mène à une page existante (app/<chemin>/page.tsx), sans fragment", () => {
    for (const s of ALL.flatMap(steps)) {
      const u = url(s.href);
      expect(u.hash, s.id).toBe("");
      expect(s.href.startsWith("/"), s.id).toBe(true);
      expect(existsSync(join(WEB, pageFile(u.pathname))), `${s.id} : ${pageFile(u.pathname)}`).toBe(true);
    }
  });

  it("paramètres connus : tab ∈ onglets des Réglages permis au profil, filter ∈ RIDE_FILTERS, rien d'autre", () => {
    const filters = RIDE_FILTERS.map((f) => f.key as string);
    for (const def of ALL) {
      for (const s of def.steps) {
        const u = url(s.href);
        for (const [param, value] of u.searchParams) {
          if (param === "tab") {
            expect(u.pathname, s.id).toBe("/dashboard/settings");
            expect(PROFILE[def.key].tabs.map((t) => t.key), s.id).toContain(value);
          } else if (param === "filter") {
            expect(u.pathname, s.id).toBe("/dashboard/rides");
            expect(filters, s.id).toContain(value);
          } else throw new Error(`${s.id} : paramètre inconnu ${param}`);
        }
      }
    }
    // Onglets lus dans la page : le contrôle ne tourne pas à vide
    expect(TABS.map((t) => t.key)).toEqual(["org", "pricing", "dispatch", "centrale", "team", "billing"]);
    expect(PRIVATE_TABS.map((t) => t.key)).toEqual(["org", "pricing", "bookings", "billing"]);
  });

  it("chaque parcours n'envoie que vers des pages de son menu (Flotte Privée : et Réglages)", () => {
    for (const def of ALL) {
      for (const menuOfProfile of PROFILE[def.key].menus) {
        const open = new Set(menuOfProfile.map((i) => i.href));
        for (const s of def.steps) expect(open.has(url(s.href).pathname), `${def.key} : ${s.href}`).toBe(true);
      }
    }
    // Garde-fou : le menu du super admin est bien lu
    expect(ADMIN_MENU.length).toBeGreaterThanOrEqual(10);
  });

  it("Flotte Privée : aucune page masquée et refusée (privateFleetPage), aucun renvoi vers une page standard", () => {
    for (const s of TOURS.private_fleet.steps) {
      const src = read(pageFile(url(s.href).pathname));
      expect(src, s.href).not.toContain("privateFleetPage(");
      expect(src, s.href).not.toMatch(/if \(isPrivateFleet\(ctx\.org\)\) redirect\(/);
    }
  });

  it("« Ouvrir X » : un écran nommé comme dans le menu ou les onglets, et qui mène bien à cet écran", () => {
    for (const def of ALL) {
      const items = PROFILE[def.key].menus[0]!;
      for (const s of def.steps) {
        const name = s.linkLabel.slice("Ouvrir ".length);
        // « Ouvrir les réglages », « Ouvrir la commission »… : pas un nom d'écran
        if (!/^\p{Lu}/u.test(name)) continue;
        const u = url(s.href);
        const tab = PROFILE[def.key].tabs.find((t) => t.label === name);
        const item = items.find((i) => i.label === name);
        expect(!!tab || !!item, `${s.id} : « ${name} »`).toBe(true);
        if (tab) expect(u.searchParams.get("tab"), s.id).toBe(tab.key);
        else expect(u.pathname, s.id).toBe(item!.href);
      }
    }
  });
});

describe("garde-fous du contrôle", () => {
  it("le parcours des sources voit les pages et les composants", () => {
    expect(CODE.some((c) => relative("app", c.file).startsWith("dashboard"))).toBe(true);
    expect(CODE.some((c) => c.file.startsWith("components/tour/"))).toBe(true);
    expect(CODE.some((c) => /\.test\.tsx?$/.test(c.file))).toBe(false);
  });
  it("anchorValues : formes attendues reconnues, attributs voisins ignorés", () => {
    expect(anchorValues('<Card data-tour="x-1">')).toEqual(["x-1"]);
    expect(anchorValues('data-tour={plan ? undefined : "y-2"}')).toEqual(["y-2"]);
    expect(anchorValues('<div data-tour-avoid="" data-tour-card="" />')).toEqual([]);
    expect(anchorValues("document.querySelector(`[data-tour=\"${id}\"]`)")).toEqual([]);
  });
});
