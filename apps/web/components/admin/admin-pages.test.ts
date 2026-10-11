import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

// Super admin (docs/REFONTE-PANELS.md, R2 et § 3.11) :
//  1. chaque page app/admin/**/page.tsx appelle requireSuperAdmin() AVANT toute lecture. Le layout le fait aussi, mais
//     Next rend le layout et la page EN PARALLÈLE : une page qui lirait d'abord (requête, RPC, client service role) ne
//     serait pas protégée par le seul layout ;
//  2. menu du super admin : quatre groupes métier dans cet ordre, libellés (= titres des pages), adresses, pastilles et
//     ce qu'elles comptent ; « Supervision » active sur ses quatre pages, comme l'onglet de la page.

// Rendu de la coquille : modules « @/ » résolus à la main ; adresse courante pilotée par chaque test
const nav = vi.hoisted(() => ({ pathname: "/admin" }));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  usePathname: () => nav.pathname,
}));
vi.mock("@/lib/utils", async () => await import("../../lib/utils"));
vi.mock("@/lib/wording", async () => await import("../../lib/wording"));
vi.mock("@/lib/run-action", () => ({ runAction: async (fn: () => unknown) => fn() }));
vi.mock("@/app/login/actions", () => ({ signOut: async () => undefined }));
vi.mock("@/components/legal/cookie-notice", () => ({ CookieNotice: () => null }));
vi.mock("@/components/legal/legal-links", async () => await import("../legal/legal-links"));
vi.mock("@/components/brand/logo", async () => await import("../brand/logo"));
vi.mock("@/components/ui/misc", async () => await import("../ui/misc"));
vi.mock("@/components/ui/badge", async () => await import("../ui/badge"));
vi.mock("@/components/ui/filter-tabs", async () => await import("../ui/filter-tabs"));
vi.mock("@/components/shell/sidebar", async () => await import("../shell/sidebar"));
vi.mock("@/components/shell/skip-to-content", async () => await import("../shell/skip-to-content"));
vi.mock("@/components/admin/supervision-tabs", async () => await import("./supervision-tabs"));
// Visite guidée (docs/TUTORIEL.md § 6.11, lot T2) : fournisseur simulé (le moteur a ses propres tests, components/tour) ;
// il reçoit le départ de la visite, la coquille demande les entrées du menu du compte. Mise en page du super admin :
// session, compteurs « À traiter » et coquille simulés (lecture de la progression, urgence).
const tour = vi.hoisted(() => ({
  boots: [] as unknown[],
  menuCalls: 0,
  session: null as any,
  todo: null as any,
  shellComponent: null as unknown,
}));
vi.mock("@/components/tour/tour-provider", () => ({
  TourProvider: ({ boot, children }: { boot?: unknown; children?: unknown }) => {
    tour.boots.push(boot ?? null);
    return children;
  },
  useTourMenu: () => {
    tour.menuCalls++;
    return [];
  },
}));
vi.mock("@/lib/auth", () => ({ requireSuperAdmin: async () => tour.session }));
vi.mock("@/components/admin/platform-data", () => ({ getAdminTodo: async () => tour.todo }));
vi.mock("@/components/admin/admin-todo", async () => await import("./admin-todo"));
vi.mock("@/components/shell/admin-shell", () => {
  const AdminShell = () => null;
  tour.shellComponent = AdminShell;
  return { AdminShell };
});

// Import au chargement du fichier (jamais dans un test : le chargement de Radix et des icônes compterait dans son délai)
const shell = await import("../shell/admin-shell");
const supervision = await import("./supervision-tabs");
const { default: AdminLayout } = await import("../../app/admin/layout");

// ------------------------------------------------------------------------------------------------- 1. Contrôle d'accès

const WEB = join(import.meta.dirname, "..", "..");

function pageFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return pageFiles(path);
    return name === "page.tsx" ? [path] : [];
  });
}

const PAGES = pageFiles(join(WEB, "app", "admin"))
  .map((file) => ({ rel: relative(WEB, file).replace(/\\/g, "/"), src: readFileSync(file, "utf8") }))
  .sort((a, b) => a.rel.localeCompare(b.rel));

/** Lecture de données : requête PostgREST ou RPC (`.from(`, `.rpc(`), client service role. */
const isRead = (callee: string) => /\.(from|rpc)$/.test(callee) || callee === "createAdminClient";
/** Seuls appels permis AVANT le contrôle : paramètres de l'adresse, test d'un format, adresse invalide → introuvable. */
const allowedBefore = (callee: string) => callee === "Promise.all" || callee === "notFound" || /\.test$/.test(callee);
/** Le contrôle, seul dans son instruction (jamais en parallèle d'une lecture). */
const GUARD = /^(?:(?:const|let)\s+\w+\s*=\s*)?await\s+requireSuperAdmin\(\);$/;

/**
 * Écarts d'une page (vide : conforme). Analyse par le compilateur TypeScript : fonctions exportées (page par défaut,
 * generateMetadata…), instructions de leur corps dans l'ordre, appels qu'elles contiennent.
 */
function accessFindings(rel: string, src: string): string[] {
  const sf = ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const callees = (node: ts.Node): string[] => {
    const out: string[] = [];
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n)) out.push(n.expression.getText(sf));
      ts.forEachChild(n, visit);
    };
    visit(node);
    return out;
  };
  const findings: string[] = [];
  const imports = new Map<string, string>();
  const exported: { name: string; fn: ts.FunctionDeclaration }[] = [];
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
      const clause = st.importClause;
      if (!clause || clause.isTypeOnly) continue;
      if (clause.name) imports.set(clause.name.text, st.moduleSpecifier.text);
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const el of bindings.elements) if (!el.isTypeOnly) imports.set(el.name.text, st.moduleSpecifier.text);
      }
    } else if (ts.isFunctionDeclaration(st)) {
      const mods = ts.getModifiers(st) ?? [];
      if (mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
        const isDefault = mods.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
        exported.push({ name: isDefault ? "page" : (st.name?.text ?? "export"), fn: st });
      }
    } else if (ts.isVariableStatement(st)) {
      // Fonctions du module : lues seulement à l'appel ; toute autre valeur est calculée au chargement du module
      for (const d of st.declarationList.declarations) {
        const init = d.initializer;
        if (!init || ts.isArrowFunction(init) || ts.isFunctionExpression(init)) continue;
        if (callees(init).some(isRead)) findings.push(`lecture au chargement du module : ${d.name.getText(sf)}`);
      }
    } else if (ts.isExpressionStatement(st) && callees(st).some(isRead)) {
      findings.push("lecture au chargement du module");
    }
  }
  if (!exported.some((e) => e.name === "page")) findings.push("aucune fonction de page exportée par défaut (analyse impossible)");
  if (imports.get("requireSuperAdmin") !== "@/lib/auth") findings.push("requireSuperAdmin n'est pas importé de @/lib/auth");
  for (const { name, fn } of exported) {
    const body = fn.body?.statements ?? [];
    // Export sans aucun appel (métadonnées fixes…) : rien à protéger ; la page, elle, contrôle toujours
    if (name !== "page" && !body.some((st) => callees(st).length > 0)) continue;
    const at = body.findIndex((st) => callees(st).includes("requireSuperAdmin"));
    if (at < 0) {
      findings.push(`${name} : aucun appel à requireSuperAdmin()`);
      continue;
    }
    const guard = body[at]!.getText(sf);
    if (!GUARD.test(guard)) findings.push(`${name} : contrôle mêlé à d'autres appels ou conditionnel : ${guard.slice(0, 120)}`);
    for (const st of body.slice(0, at)) {
      for (const callee of callees(st)) if (!allowedBefore(callee)) findings.push(`${name} : ${callee}() avant requireSuperAdmin()`);
    }
  }
  return findings;
}

describe("pages du super admin : requireSuperAdmin() avant toute lecture (§ 3.11)", () => {
  it("toutes les pages de app/admin sont analysées, dont celles du lot R2", () => {
    const rels = PAGES.map((p) => p.rel);
    expect(rels.length).toBeGreaterThanOrEqual(19);
    for (const page of ["app/admin/page.tsx", "app/admin/signalements/page.tsx", "app/admin/emails/page.tsx", "app/admin/reglages/page.tsx"]) {
      expect(rels).toContain(page);
    }
  });

  it.each(PAGES.map((p) => [p.rel, p.src] as const))("%s", (rel, src) => {
    expect(accessFindings(rel, src)).toEqual([]);
  });

  it("garde-fou du test : une lecture avant le contrôle, une lecture en parallèle ou un contrôle absent sont repérés", () => {
    const head = `import { requireSuperAdmin } from "@/lib/auth";\nimport { createAdminClient } from "@/lib/supabase/admin";\n`;
    const before = `${head}export default async function P() {\n  const rows = await createAdminClient().from("t").select("*");\n  const session = await requireSuperAdmin();\n  return rows;\n}`;
    const parallel = `${head}export default async function P({ db }: any) {\n  const [session, rows] = await Promise.all([requireSuperAdmin(), db.rpc("x")]);\n  return rows;\n}`;
    const helper = `${head}async function load() { return createAdminClient().from("t").select("*"); }\nexport default async function P() {\n  const rows = await load();\n  const session = await requireSuperAdmin();\n  return rows;\n}`;
    const missing = `${head}export default async function P({ db }: any) {\n  return db.from("t").select("*");\n}`;
    const moduleRead = `${head}const rows = createAdminClient().from("t").select("*");\nexport default async function P() {\n  const session = await requireSuperAdmin();\n  return rows;\n}`;
    const ok = `${head}export default async function P({ params }: any) {\n  const { id } = await params;\n  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();\n  const session = await requireSuperAdmin();\n  return session.supabase.from("t").select("*").eq("id", id);\n}`;
    for (const bad of [before, parallel, helper, missing, moduleRead]) expect(accessFindings("cas.tsx", bad)).not.toEqual([]);
    expect(accessFindings("cas.tsx", ok)).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------------------------ 2. Menu

describe("menu du super admin (R2)", () => {
  it("groupes, ordre, libellés, adresses, pastilles et ce qu'elles comptent : tableau du § R2", () => {
    const sections = shell.adminNav({ contactsToReview: 2, openReports: 1, networkToReview: 3, platformToReview: 1, deletionsToReview: 2 });
    expect(sections).toEqual([
      {
        title: "Pilotage",
        items: [
          { href: "/admin", label: "Vue d'ensemble", icon: "dashboard", exact: true },
          { href: "/admin/carte", label: "Carte en direct", icon: "globe" },
        ],
      },
      {
        title: "Clients",
        items: [
          { href: "/admin/organizations", label: "Clients", icon: "building" },
          { href: "/admin/contacts", label: "Demandes de contact", icon: "mail", badge: 2, badgeTone: "brand", badgeLabel: "2 nouvelles demandes de contact" },
          {
            href: "/admin/signalements",
            label: "Signalements de fraude",
            icon: "shield",
            badge: 1,
            badgeTone: "red",
            badgeLabel: "1 signalement de fraude à examiner",
          },
          {
            href: "/admin/reseau",
            label: "Réseau partagé",
            icon: "share",
            badge: 3,
            badgeTone: "amber",
            badgeLabel: "3 organisations à valider pour le réseau partagé",
          },
        ],
      },
      {
        title: "Argent",
        items: [
          {
            href: "/admin/frais",
            label: "Frais Rydar",
            icon: "landmark",
            badge: 1,
            badgeTone: "amber",
            badgeLabel: "1 élément à confirmer (paiements, baisses de frais)",
          },
          { href: "/admin/centrales", label: "Commissions des centrales", icon: "wallet" },
          { href: "/admin/plans", label: "Offres & limites", icon: "card" },
        ],
      },
      {
        title: "Plateforme",
        items: [
          { href: "/admin/reglages", label: "Réglages de la plateforme", icon: "settings" },
          { href: "/admin/legal", label: "Informations légales", icon: "scroll" },
          {
            href: "/admin/suppressions",
            label: "Suppressions de comptes",
            icon: "userX",
            badge: 2,
            badgeTone: "red",
            badgeLabel: "2 suppressions de compte en échec ou en retard",
          },
          { href: "/admin/dispatch", label: "Supervision", icon: "radar", match: ["/admin/notifications", "/admin/emails", "/admin/audit"] },
        ],
      },
    ]);
  });

  it("pastilles : singulier et pluriel ; aucune à zéro ; chaque adresse une seule fois", () => {
    const one = shell.adminNav({ contactsToReview: 1, networkToReview: 1, platformToReview: 2, deletionsToReview: 1 }).flatMap((s) => s.items);
    const label = (href: string) => one.find((i) => i.href === href)?.badgeLabel;
    expect(label("/admin/contacts")).toBe("1 nouvelle demande de contact");
    expect(label("/admin/reseau")).toBe("1 organisation à valider pour le réseau partagé");
    expect(label("/admin/frais")).toBe("2 éléments à confirmer (paiements, baisses de frais)");
    expect(label("/admin/suppressions")).toBe("1 suppression de compte en échec ou en retard");
    const none = shell.adminNav().flatMap((s) => s.items);
    expect(none.filter((i) => i.badge)).toEqual([]);
    const hrefs = none.map((i) => i.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it("« Mon espace » seulement pour un super admin aussi membre d'une centrale, après les quatre groupes", () => {
    expect(shell.adminNav({}, null).map((s) => s.title)).toEqual(["Pilotage", "Clients", "Argent", "Plateforme"]);
    const withOrg = shell.adminNav({}, "Centrale Express Paris");
    expect(withOrg.map((s) => s.title)).toEqual(["Pilotage", "Clients", "Argent", "Plateforme", "Mon espace"]);
    expect(withOrg.at(-1)!.items).toEqual([{ href: "/dashboard", label: "Centrale Express Paris", icon: "building" }]);
  });

  it("vocabulaire : ni « rattacheur », ni « tenant », ni « Frais plateforme » dans le menu et la coquille", () => {
    const text = JSON.stringify(shell.adminNav({ contactsToReview: 2, openReports: 2, networkToReview: 2, platformToReview: 2, deletionsToReview: 2 }));
    nav.pathname = "/admin";
    const html = renderToStaticMarkup(createElement(shell.AdminShell, { user: { name: "Équipe Rydar", email: "admin@rydar.app" }, children: null }));
    for (const visible of [text, html]) expect(visible).not.toMatch(/rattacheur|tenant|Frais plateforme|Mode plateforme/i);
    expect(html).toContain("Super admin");
  });

  /** Liens rendus : adresse, texte visible, page courante. */
  const anchors = (html: string) =>
    [...html.matchAll(/<a\s([^>]*)>([\s\S]*?)<\/a>/g)].map((m) => ({
      href: /href="([^"]*)"/.exec(m[1]!)?.[1] ?? null,
      current: /aria-current="page"/.test(m[1]!),
      text: m[2]!
        .replace(/<[^>]+>/g, "")
        .replace(/&amp;/g, "&")
        .replace(/&#x27;/g, "'")
        .trim(),
    }));

  it.each([
    ["/admin/dispatch", "Dispatch & erreurs", "dispatch"],
    ["/admin/notifications", "Notifications", "notifications"],
    ["/admin/emails", "E-mails", "emails"],
    ["/admin/audit", "Sécurité & audit", "audit"],
  ] as const)("%s : « Supervision » (menu) et l'onglet « %s » portent aria-current=\"page\"", (path, tab, key) => {
    nav.pathname = path;
    const html = renderToStaticMarkup(
      createElement(shell.AdminShell, {
        user: { name: "Équipe Rydar", email: "admin@rydar.app" },
        children: createElement(supervision.SupervisionTabs, { current: key }),
      }),
    );
    const links = anchors(html);
    expect(links.filter((a) => a.current).map((a) => a.text).sort()).toEqual(["Supervision", tab].sort());
    // Les quatre rubriques, dans l'ordre, sans préchargement d'aucune (les adresses ne changent pas)
    const tabs = links.filter((a) => ["/admin/dispatch", "/admin/notifications", "/admin/emails", "/admin/audit"].includes(a.href ?? "") && a.text !== "Supervision");
    expect(tabs.map((a) => a.text)).toEqual(["Dispatch & erreurs", "Notifications", "E-mails", "Sécurité & audit"]);
    expect(html).toContain('aria-label="Rubriques de la supervision"');
  });

  it("hors Supervision, l'entrée de la page est la seule active (ex. Signalements de fraude)", () => {
    nav.pathname = "/admin/signalements";
    const html = renderToStaticMarkup(createElement(shell.AdminShell, { user: { name: "Équipe Rydar", email: "admin@rydar.app" }, children: null }));
    expect(anchors(html).filter((a) => a.current).map((a) => a.text)).toEqual(["Signalements de fraude"]);
  });
});

// ------------------------------------------------------------------------------------------------ 3. Visite guidée

describe("visite guidée du super admin (docs/TUTORIEL.md § 4.2, § 6.11)", () => {
  type Read = { table: string; columns: string; filters: unknown[][] };
  const reads: Read[] = [];
  const sessionWith = (row: unknown, error: unknown = null) => ({
    user: { id: "sa-1" },
    profile: { full_name: "Équipe Rydar", email: "admin@rydar.app", is_super_admin: true },
    memberships: [],
    supabase: {
      from(table: string) {
        const read: Read = { table, columns: "", filters: [] };
        reads.push(read);
        const b: any = {
          select: (columns: string) => ((read.columns = columns), b),
          eq: (...args: unknown[]) => (read.filters.push(["eq", ...args]), b),
          maybeSingle: async () => ({ data: row, error }),
        };
        return b;
      },
    },
  });
  const todo = (o: Record<string, number | null> = {}) => ({
    openReports: 0,
    declaredPayments: 0,
    pendingReductions: 0,
    failedDeletions: 0,
    newContacts: 0,
    networkToReview: 0,
    ...o,
  });
  const layout = async (row: unknown, t = todo(), error: unknown = null) => {
    reads.length = 0;
    tour.session = sessionWith(row, error);
    tour.todo = t;
    // Élément rendu par la mise en page : la coquille (simulée) et ses propriétés
    const el = (await AdminLayout({ children: null })) as any;
    expect(el.type).toBe(tour.shellComponent);
    return el.props.tour;
  };

  it("jamais vue, rien d'urgent : parcours « super_admin », progression lue pour l'utilisateur et ce parcours seulement", async () => {
    expect(await layout(null)).toEqual({
      key: "super_admin",
      saved: null,
      blocked: false,
      urgent: false,
      scope: { userId: "sa-1", orgId: null, driverId: null },
    });
    expect(reads).toEqual([{ table: "user_tours", columns: "status, step, shown_at", filters: [["eq", "user_id", "sa-1"], ["eq", "tour", "super_admin"]] }]);
  });

  it("signalement de fraude à examiner, ou suppression de compte en échec : ouverture d'office différée", async () => {
    expect((await layout(null, todo({ openReports: 1 }))).urgent).toBe(true);
    expect((await layout(null, todo({ failedDeletions: 2 }))).urgent).toBe(true);
    // Les autres pastilles ne diffèrent rien (paiements, contacts, réseau)
    expect((await layout(null, todo({ declaredPayments: 3, newContacts: 2, networkToReview: 1 }))).urgent).toBe(false);
    // Compteur illisible : pas d'urgence inventée
    expect((await layout(null, todo({ openReports: null }))).urgent).toBe(false);
  });

  it("progression lue (en pause, étape 3) ; lecture en échec : inconnue (aucune ouverture d'office)", async () => {
    expect((await layout({ status: "paused", step: 2, shown_at: "2026-10-11T08:00:00Z" })).saved).toEqual({ status: "paused", step: 2, shown: true });
    expect((await layout(null, todo(), { code: "42P01", message: "relation does not exist" })).saved).toBeUndefined();
  });

  it("coquille : sans visite, rendu inchangé (fournisseur sans départ) ; menu du compte et réserve de défilement", () => {
    tour.boots.length = 0;
    tour.menuCalls = 0;
    nav.pathname = "/admin";
    const html = renderToStaticMarkup(createElement(shell.AdminShell, { user: { name: "Équipe Rydar", email: "admin@rydar.app" }, children: null }));
    expect(tour.boots).toEqual([null]);
    expect(tour.menuCalls).toBeGreaterThan(0);
    expect(html).toMatch(/<main id="contenu" tabindex="-1" class="[^"]*pb-\[var\(--tour-reserve,0px\)\]/);
    const boot = { key: "super_admin" as const, saved: null, blocked: false, urgent: false, scope: { userId: "sa-1", orgId: null, driverId: null } };
    renderToStaticMarkup(createElement(shell.AdminShell, { user: { name: "Équipe Rydar", email: "admin@rydar.app" }, tour: boot, children: null }));
    expect(tour.boots.at(-1)).toEqual(boot);
    // Entrées du menu du compte : passées à la barre latérale (avant « Se déconnecter »)
    const src = readFileSync(join(WEB, "components", "shell", "admin-shell.tsx"), "utf8");
    expect(src).toMatch(/const accountItems = useTourMenu\(\);[\s\S]*<Sidebar[\s\S]*accountItems=\{accountItems\}/);
  });
});
