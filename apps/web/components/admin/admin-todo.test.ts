import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// Vue d'ensemble et liste des clients du super admin (docs/REFONTE-PANELS.md, R3) :
//  1. « À traiter » : une ligne par sujet (verbe + nombre + lien), pluriels, lecture impossible (jamais 0), liste vide ;
//  2. une seule source pour les pastilles du menu et « À traiter » (getAdminTodo, lue par le layout ET la page) ;
//  3. liste des clients : filtres par type (la somme des types égale « Tous »), recherche sans requête ilike ;
//  4. tableau « Clients » de la vue d'ensemble : fusion de l'activité et des effectifs.

vi.mock("server-only", () => ({}));
vi.mock("@/lib/wording", async () => await import("../../lib/wording"));

const { adminLegalTodo, adminNavCounts, adminTodoItems } = await import("./admin-todo");
const data = await import("./platform-data");

type Todo = import("./admin-todo").AdminTodo;
const NONE: Todo = { openReports: 0, declaredPayments: 0, pendingReductions: 0, failedDeletions: 0, newContacts: 0, networkToReview: 0 };
const LEGAL_OK = { editorMissing: false, missingNotices: 0 };
/** Espaces insécables (typographie française, séparateur des milliers) ramenées à des espaces simples. */
const nb = (s: string) => s.replace(/[\u00a0\u202f]/g, " ");

// ----------------------------------------------------------------------------------------------- 1. « À traiter »

describe("À traiter : lignes de la vue d'ensemble", () => {
  it("rien à faire : aucune ligne (la page dit « Rien à traiter, tout est à jour. »)", () => {
    expect(adminTodoItems(NONE, LEGAL_OK)).toEqual([]);
  });

  it("chaque sujet : verbe + nombre + lien vers la page où le traiter, au singulier", () => {
    const one: Todo = { openReports: 1, declaredPayments: 1, pendingReductions: 1, failedDeletions: 1, newContacts: 1, networkToReview: 1 };
    expect(adminTodoItems(one, LEGAL_OK).map(({ label, href, tone }) => ({ label, href, tone }))).toEqual([
      { label: "Examiner 1 signalement de fraude", href: "/admin/signalements", tone: "red" },
      { label: "Vérifier 1 suppression de compte en échec ou en retard", href: "/admin/suppressions", tone: "red" },
      { label: "Confirmer 1 paiement déclaré", href: "/admin/frais#a-traiter", tone: "amber" },
      { label: "Décider 1 baisse de frais", href: "/admin/frais#a-traiter", tone: "amber" },
      { label: "Valider 1 organisation pour le réseau partagé", href: "/admin/reseau#a-valider", tone: "amber" },
      { label: "Répondre à 1 demande de contact", href: "/admin/contacts", tone: "brand" },
    ]);
  });

  it("pluriels (et nombres au format français)", () => {
    const many: Todo = { openReports: 2, declaredPayments: 3, pendingReductions: 4, failedDeletions: 5, newContacts: 1200, networkToReview: 7 };
    expect(adminTodoItems(many, LEGAL_OK).map((i) => nb(i.label))).toEqual([
      "Examiner 2 signalements de fraude",
      "Vérifier 5 suppressions de compte en échec ou en retard",
      "Confirmer 3 paiements déclarés",
      "Décider 4 baisses de frais",
      "Valider 7 organisations pour le réseau partagé",
      "Répondre à 1 200 demandes de contact",
    ]);
  });

  it("seuls les sujets non nuls ont une ligne", () => {
    const items = adminTodoItems({ ...NONE, declaredPayments: 2, newContacts: 1 }, LEGAL_OK);
    expect(items.map((i) => i.key)).toEqual(["declaredPayments", "newContacts"]);
  });

  it("lecture impossible : « Lecture impossible : … », jamais 0 ni une ligne absente", () => {
    const items = adminTodoItems({ ...NONE, openReports: null, networkToReview: null }, LEGAL_OK);
    expect(items.map((i) => ({ label: nb(i.label), href: i.href, tone: i.tone, unreadable: i.unreadable }))).toEqual([
      { label: "Lecture impossible : signalements de fraude", href: "/admin/signalements", tone: "neutral", unreadable: true },
      { label: "Lecture impossible : réseau partagé", href: "/admin/reseau#a-valider", tone: "neutral", unreadable: true },
    ]);
    for (const item of items) expect(item.label).not.toMatch(/\b0\b/);
  });

  it("toutes les lectures en échec : une ligne par sujet, pas de « tout est à jour »", () => {
    const all: Todo = { openReports: null, declaredPayments: null, pendingReductions: null, failedDeletions: null, newContacts: null, networkToReview: null };
    const items = adminTodoItems(all, null);
    expect(items).toHaveLength(7);
    expect(items.every((i) => i.unreadable && i.label.startsWith("Lecture impossible"))).toBe(true);
  });

  it("informations légales : en tête ; identité absente = blocage (rouge) avec sa conséquence ; mentions seules = ambre", () => {
    const blocking = adminTodoItems({ ...NONE, openReports: 1 }, { editorMissing: true, missingNotices: 0 });
    expect(blocking[0]).toMatchObject({ key: "legal", label: "Compléter les informations légales de l'éditeur", href: "/admin/legal", tone: "red" });
    expect(blocking[0]!.detail).toBe("Sans raison sociale, siège et immatriculation, aucun client ne peut accepter les CGV.");
    expect(blocking[1]!.key).toBe("openReports");

    const notices = adminTodoItems(NONE, { editorMissing: false, missingNotices: 3 });
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ key: "legal", tone: "amber", detail: "3 mentions obligatoires manquantes dans les mentions légales." });
    expect(adminTodoItems(NONE, { editorMissing: false, missingNotices: 1 })[0]!.detail).toBe("1 mention obligatoire manquante dans les mentions légales.");

    const both = adminTodoItems(NONE, { editorMissing: true, missingNotices: 2 })[0]!;
    expect(both.detail).toBe("Sans raison sociale, siège et immatriculation, aucun client ne peut accepter les CGV. 2 mentions obligatoires manquantes dans les mentions légales.");

    const unreadable = adminTodoItems(NONE, null);
    expect(unreadable).toEqual([expect.objectContaining({ key: "legal", href: "/admin/legal", tone: "neutral", unreadable: true })]);
    expect(nb(unreadable[0]!.label)).toBe("Lecture impossible : informations légales de l'éditeur");
  });

  it("identité de l'éditeur : lecture en échec → null ; aucune ligne ou champ vide → à compléter ; complète → rien", () => {
    const full = { company_name: "Rydar SAS", address: "1 rue de Paris", registration: "RCS Paris 000" };
    expect(adminLegalTodo({ error: { message: "boom" }, editor: full, missingNotices: 0 })).toBeNull();
    expect(adminLegalTodo({ error: null, editor: null, missingNotices: 0 })).toEqual({ editorMissing: true, missingNotices: 0 });
    expect(adminLegalTodo({ error: null, editor: { ...full, address: "  " }, missingNotices: 1 })).toEqual({ editorMissing: true, missingNotices: 1 });
    expect(adminLegalTodo({ error: null, editor: { ...full, registration: null }, missingNotices: 0 })!.editorMissing).toBe(true);
    expect(adminLegalTodo({ error: null, editor: full, missingNotices: 0 })).toEqual({ editorMissing: false, missingNotices: 0 });
  });
});

// ------------------------------------------------------------------------------------------- 2. Une seule source

describe("pastilles du menu et « À traiter » : mêmes compteurs (getAdminTodo)", () => {
  it("adminNavCounts : mêmes nombres que les lignes ; Frais Rydar = paiements + baisses ; lecture impossible = pas de pastille", () => {
    const todo: Todo = { openReports: 2, declaredPayments: 1, pendingReductions: 3, failedDeletions: 1, newContacts: 4, networkToReview: 5 };
    expect(adminNavCounts(todo)).toEqual({ openReports: 2, platformToReview: 4, deletionsToReview: 1, contactsToReview: 4, networkToReview: 5 });
    expect(adminNavCounts({ ...todo, declaredPayments: null, openReports: null })).toEqual({
      openReports: 0,
      platformToReview: 3,
      deletionsToReview: 1,
      contactsToReview: 4,
      networkToReview: 5,
    });
  });

  /** Client Supabase factice : chaque requête répond selon sa table (ou « rpc:nom »), quelle que soit la chaîne de filtres. */
  function fakeClient(results: Record<string, { count?: number | null; data?: unknown; error?: unknown }>) {
    const calls: string[] = [];
    const query = (key: string) => {
      calls.push(key);
      const r = results[key] ?? {};
      const done = Promise.resolve({ count: r.count ?? null, data: r.data ?? null, error: r.error ?? null });
      const proxy: unknown = new Proxy(
        {},
        { get: (_t, prop) => (prop === "then" ? done.then.bind(done) : () => proxy) },
      );
      return proxy;
    };
    return { client: { from: (t: string) => query(t), rpc: (fn: string) => query(`rpc:${fn}`) } as never, calls };
  }

  it("getAdminTodo : les 6 lectures du menu ; compteurs exacts ; suppressions = en échec + en retard", async () => {
    const { client, calls } = fakeClient({
      fraud_reports: { count: 2 },
      platform_payments: { count: 1 },
      platform_fee_entries: { count: 0 },
      "rpc:admin_account_deletions": { data: { failed: 1, stalled: 2, pending: 9 } },
      contact_requests: { count: 4 },
      network_memberships: { count: 3 },
    });
    expect(await data.getAdminTodo(client)).toEqual({
      openReports: 2,
      declaredPayments: 1,
      pendingReductions: 0,
      failedDeletions: 3,
      newContacts: 4,
      networkToReview: 3,
    });
    expect(calls.sort()).toEqual(
      ["contact_requests", "fraud_reports", "network_memberships", "platform_fee_entries", "platform_payments", "rpc:admin_account_deletions"].sort(),
    );
  });

  it("getAdminTodo : une lecture en échec donne null (jamais 0), les autres restent lues", async () => {
    const { client } = fakeClient({
      fraud_reports: { error: { message: "permission denied" } },
      platform_payments: { count: 1 },
      "rpc:admin_account_deletions": { error: { message: "timeout" } },
      contact_requests: { count: 0 },
      network_memberships: { error: { message: "relation does not exist" } },
    });
    const todo = await data.getAdminTodo(client);
    expect(todo).toEqual({ openReports: null, declaredPayments: 1, pendingReductions: 0, failedDeletions: null, newContacts: 0, networkToReview: null });
    expect(adminTodoItems(todo, LEGAL_OK).map((i) => nb(i.label))).toEqual([
      "Lecture impossible : signalements de fraude",
      "Lecture impossible : suppressions de comptes",
      "Confirmer 1 paiement déclaré",
      "Lecture impossible : réseau partagé",
    ]);
  });

  it("le layout (pastilles) et la vue d'ensemble lisent getAdminTodo, sans requête propre sur ces tables", () => {
    const web = join(import.meta.dirname, "..", "..");
    const layout = readFileSync(join(web, "app", "admin", "layout.tsx"), "utf8");
    const page = readFileSync(join(web, "app", "admin", "page.tsx"), "utf8");
    for (const src of [layout, page]) {
      expect(src).toContain("getAdminTodo(session.supabase)");
      expect(src).not.toMatch(/fraud_reports|platform_payments|platform_fee_entries|admin_account_deletions|contact_requests|network_memberships/);
    }
    expect(layout).toContain("adminNavCounts(");
    expect(page).toContain("adminTodoItems(");
    // Une seule série de lectures par rendu : la fonction est sous cache() de React
    expect(readFileSync(join(import.meta.dirname, "platform-data.ts"), "utf8")).toMatch(/export const getAdminTodo = cache\(/);
  });
});

// ------------------------------------------------------------------------------------------- 3. Liste des clients

type Client = import("./platform-data").ClientListRow;
const client = (patch: Partial<Client>): Client => ({
  id: patch.id ?? patch.name ?? "x",
  name: "Client",
  slug: "client",
  status: "active",
  city: null,
  email: null,
  created_at: "2026-10-01T10:00:00Z",
  dispatch_model: "fleet",
  private_fleet: false,
  plan: null,
  ...patch,
});
const CLIENTS: Client[] = [
  client({ name: "Élite Chauffeurs Paris", slug: "elite-paris", city: "Paris", email: "direction@elite-paris.fr" }),
  client({ name: "Riviera Prestige VTC", slug: "riviera-prestige", city: "Nice", email: "contact@riviera-prestige.fr", status: "suspended" }),
  client({ name: "Centrale Express Paris", slug: "centrale-express", city: "Paris", email: "contact@centrale-express.fr", dispatch_model: "centrale" }),
  client({ name: "Ancienne Centrale", slug: "ancienne", city: "Lyon", dispatch_model: "centrale", status: "archived" }),
  // Flotte Privée : une flotte (modèle fleet) d'un seul chauffeur, comptée à part
  client({ name: "Lambert VTC", slug: "lambert-vtc", city: "Saint-Étienne", email: "claire@lambert.fr", private_fleet: true }),
];

describe("liste des clients : filtres par type et recherche (TypeScript, sans ilike)", () => {
  it("type : Flotte Privée avant le modèle ; centrale ; flotte par défaut", () => {
    expect(data.clientKind({ dispatch_model: "fleet", private_fleet: true })).toBe("private");
    expect(data.clientKind({ dispatch_model: "centrale", private_fleet: false })).toBe("centrale");
    expect(data.clientKind({ dispatch_model: null, private_fleet: null })).toBe("fleet");
    expect(Object.values(data.CLIENT_KIND_META).map((m) => m.label)).toEqual(["Flotte", "Centrale à commission", "Flotte Privée"]);
  });

  it("filtres et clés d'URL : Tous, Flottes, Centrales, Flotte Privée (clé existante), Suspendus et archivés", () => {
    expect(data.CLIENT_FILTERS.map((f) => [f.key, f.label])).toEqual([
      ["tous", "Tous"],
      ["flottes", "Flottes"],
      ["centrales", "Centrales"],
      ["flotte-privee", "Flotte Privée"],
      ["inactifs", "Suspendus et archivés"],
    ]);
    expect(data.clientFilterOf("flotte-privee")).toBe("flotte-privee");
    expect(data.clientFilterOf(["centrales", "flottes"])).toBe("centrales");
    expect(data.clientFilterOf(undefined)).toBe("tous");
    expect(data.clientFilterOf("n-importe-quoi")).toBe("tous");
  });

  it("compteurs justes : la somme des trois types égale « Tous » ; suspendus et archivés à part", () => {
    const counts = data.clientFilterCounts(CLIENTS);
    expect(counts).toEqual({ tous: 5, flottes: 2, centrales: 2, "flotte-privee": 1, inactifs: 2 });
    expect(counts.flottes + counts.centrales + counts["flotte-privee"]).toBe(counts.tous);
    const names = (key: Parameters<typeof data.matchesClientFilter>[1]) => CLIENTS.filter((c) => data.matchesClientFilter(c, key)).map((c) => c.name);
    expect(names("flotte-privee")).toEqual(["Lambert VTC"]);
    expect(names("flottes")).toEqual(["Élite Chauffeurs Paris", "Riviera Prestige VTC"]);
    expect(names("inactifs")).toEqual(["Riviera Prestige VTC", "Ancienne Centrale"]);
  });

  it("recherche par nom, ville, e-mail et identifiant ; casse et accents ignorés ; tous les mots", () => {
    const search = (q: string) => CLIENTS.filter((c) => data.matchesClientSearch(c, q)).map((c) => c.name);
    expect(search("ELITE")).toEqual(["Élite Chauffeurs Paris"]);
    expect(search("saint etienne")).toEqual(["Lambert VTC"]);
    expect(search("riviera-prestige.fr")).toEqual(["Riviera Prestige VTC"]);
    expect(search("centrale-express")).toEqual(["Centrale Express Paris"]);
    expect(search("paris centrale")).toEqual(["Centrale Express Paris"]);
    expect(search("nice")).toEqual(["Riviera Prestige VTC"]);
    expect(search("   ")).toHaveLength(CLIENTS.length);
    expect(search("introuvable")).toEqual([]);
  });

  it("compteurs calculés sur les clients trouvés : la somme des types reste égale à « Tous »", () => {
    const found = CLIENTS.filter((c) => data.matchesClientSearch(c, "paris"));
    const counts = data.clientFilterCounts(found);
    expect(counts).toEqual({ tous: 2, flottes: 1, centrales: 1, "flotte-privee": 0, inactifs: 0 });
  });

  it("une seule lecture des organisations, sans ilike (le filtre et la recherche sont faits ici)", () => {
    const page = readFileSync(join(import.meta.dirname, "..", "..", "app", "admin", "organizations", "page.tsx"), "utf8");
    const src = readFileSync(join(import.meta.dirname, "platform-data.ts"), "utf8");
    expect(page).not.toMatch(/\.from\("organizations"\)|\.ilike\(/);
    expect(page).toContain("getClientList(db)");
    expect(src).not.toMatch(/\.ilike\(/);
  });
});

// ---------------------------------------------------------------------------------- 4. Tableau « Clients » (accueil)

type OverviewOrg = import("./platform-data").OverviewOrg;
type OrgHeadcount = import("./platform-data").OrgHeadcount;
const activity = (patch: Partial<OverviewOrg>): OverviewOrg => ({
  id: "a",
  name: "A",
  slug: "a",
  status: "active",
  city: "Paris",
  plan: null,
  drivers: 0,
  drivers_online: 0,
  rides_today: 0,
  rides_30d: 0,
  no_driver_7d: 0,
  last_ride_at: null,
  ...patch,
});
const people = (patch: Partial<OrgHeadcount>): OrgHeadcount => ({
  id: "a",
  name: "A",
  slug: "a",
  city: "Paris",
  status: "active",
  dispatch_model: "fleet",
  private_fleet: false,
  color: "",
  code: "A",
  members: 1,
  drivers_active: 0,
  drivers_online: 0,
  drivers_busy: 0,
  applications: 0,
  banned: 0,
  ...patch,
});

describe("tableau « Clients » de la vue d'ensemble", () => {
  it("fusion activité + effectifs ; tri : courses du jour, chauffeurs en ligne, 30 jours, nom", () => {
    const rows = data.clientActivityRows(
      [
        activity({ id: "e", name: "Élite", rides_today: 17, rides_30d: 665, no_driver_7d: 8, last_ride_at: "2026-10-10T08:00:00Z" }),
        activity({ id: "c", name: "Centrale", rides_today: 3, rides_30d: 72 }),
        activity({ id: "l", name: "Lambert", rides_today: 3, rides_30d: 3 }),
      ],
      [
        people({ id: "e", name: "Élite", drivers_active: 14, drivers_online: 10 }),
        people({ id: "c", name: "Centrale", dispatch_model: "centrale", drivers_active: 7, drivers_online: 6, applications: 2 }),
        people({ id: "l", name: "Lambert", private_fleet: true, drivers_active: 1, drivers_online: 0 }),
      ],
    );
    expect(rows.map((r) => [r.name, r.kind, r.driversActive, r.driversOnline, r.applications, r.ridesToday, r.rides30d, r.noDriver7d])).toEqual([
      ["Élite", "fleet", 14, 10, 0, 17, 665, 8],
      ["Centrale", "centrale", 7, 6, 2, 3, 72, 0],
      ["Lambert", "private", 1, 0, 0, 3, 3, 0],
    ]);
  });

  it("effectifs illisibles : type et candidatures inconnus, chauffeurs repris de l'activité ; activité illisible : courses inconnues", () => {
    const noPeople = data.clientActivityRows([activity({ id: "e", name: "Élite", drivers: 14, drivers_online: 10, rides_today: 2 })], null);
    expect(noPeople[0]).toMatchObject({ kind: null, applications: null, driversActive: 14, driversOnline: 10, ridesToday: 2 });
    const noActivity = data.clientActivityRows(null, [people({ id: "e", name: "Élite", drivers_active: 3 })]);
    expect(noActivity[0]).toMatchObject({ kind: "fleet", driversActive: 3, ridesToday: null, rides30d: null, noDriver7d: null, lastRideAt: null });
    expect(data.clientActivityRows(null, null)).toEqual([]);
  });
});
