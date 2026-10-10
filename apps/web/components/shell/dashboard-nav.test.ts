import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { networkNavItem } from "../network-share/nav";
import { NETWORK_SHARE_PATH } from "../network-share/paths";
import { dashboardNav, sidebarOrgCaption } from "./dashboard-nav";

// Rendu de la barre latérale (bloc d'organisation, zone défilante, liens légaux) : modules « @/ » résolus à la main
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  usePathname: () => "/admin/notifications",
}));
vi.mock("@/lib/utils", async () => await import("../../lib/utils"));
vi.mock("@/components/brand/logo", async () => await import("../brand/logo"));
vi.mock("@/components/ui/misc", async () => await import("../ui/misc"));
vi.mock("@/components/legal/legal-links", async () => await import("../legal/legal-links"));

// Menu du tableau de bord. Organisation standard (docs/REFONTE-PANELS.md, R1) : « Au quotidien » et « Gestion »
// (+ « Plateforme »), mêmes libellés, adresses, pastilles et conditions que le menu historique ; « API & site web » et
// « Mini-site » réservés au propriétaire et aux administrateurs. Flotte Privée (docs/FLOTTE-PRIVEE.md § 7.2) → « Mon
// activité » et « Mon entreprise » exactement, « Frais Rydar » seulement avec des frais (owner / admin).

const COURSES_LABEL = (n: number) => `${n} ${n > 1 ? "courses" : "course"} sans chauffeur (6 dernières heures et à venir)`;

describe("menu standard : « Au quotidien » et « Gestion »", () => {
  it("flotte, propriétaire, sans réseau ni mini-site ni frais", () => {
    const nav = dashboardNav({
      privateFleet: false,
      model: "fleet",
      role: "owner",
      counts: { alerts: 2, unread: 3, openReports: 0, pendingDocuments: 1, applications: 0, declared: 0, overdue: 0 },
      flags: { bookingSites: false, rydarFees: false, superAdmin: false, networkNav: null },
    });
    expect(nav).toEqual([
      {
        title: "Au quotidien",
        items: [
          { href: "/dashboard", label: "En direct", icon: "radar", exact: true },
          { href: "/dashboard/messages", label: "Messages", icon: "message", badge: 3, badgeTone: "brand", badgeLabel: "3 messages non lus" },
          { href: "/dashboard/rides", label: "Courses", icon: "route", badge: 2, badgeTone: "red", badgeLabel: COURSES_LABEL(2) },
          { href: "/dashboard/drivers", label: "Chauffeurs", icon: "users", badge: 1, badgeTone: "amber", badgeLabel: "1 document à valider" },
          { href: "/dashboard/network", label: "Inscriptions", icon: "userPlus", badge: 0, badgeTone: "brand", badgeLabel: "0 candidature en attente" },
        ],
      },
      {
        title: "Gestion",
        items: [
          { href: "/dashboard/stats", label: "Statistiques", icon: "chart" },
          { href: "/dashboard/dispatch", label: "Journal du dispatch", icon: "scroll" },
          { href: "/dashboard/integrations", label: "API & site web", icon: "key" },
          { href: "/dashboard/settings", label: "Réglages", icon: "settings" },
        ],
      },
    ]);
  });

  it("centrale, administrateur, réseau partagé ouvert, mini-sites, super admin", () => {
    const networkNav = networkNavItem({ badge: 5, toConfirm: 2, overdue: 1, toCheck: 2 });
    const nav = dashboardNav({
      privateFleet: false,
      model: "centrale",
      role: "admin",
      counts: { alerts: 0, unread: 2, openReports: 1, pendingDocuments: 0, applications: 4, declared: 2, overdue: 1 },
      // Frais Rydar : centrale → carte d'« Encaissements », jamais l'entrée de menu
      flags: { bookingSites: true, rydarFees: true, superAdmin: true, networkNav },
    });
    expect(nav).toEqual([
      {
        title: "Au quotidien",
        items: [
          { href: "/dashboard", label: "En direct", icon: "radar", exact: true },
          {
            href: "/dashboard/messages",
            label: "Messages",
            icon: "message",
            badge: 1,
            badgeTone: "amber",
            badgeLabel: "1 message à modérer · 2 messages non lus",
          },
          { href: "/dashboard/rides", label: "Courses", icon: "route", badge: 0, badgeTone: "red", badgeLabel: COURSES_LABEL(0) },
          {
            href: "/dashboard/settlements",
            label: "Encaissements",
            icon: "wallet",
            badge: 3,
            badgeTone: "red",
            badgeLabel: "2 paiements à confirmer · 1 commission en retard",
          },
          {
            href: NETWORK_SHARE_PATH,
            label: "Réseau partagé",
            icon: "share",
            badge: 5,
            badgeTone: "red",
            badgeLabel: "2 paiements à confirmer · 1 règlement en retard · 2 courses à vérifier",
          },
          { href: "/dashboard/drivers", label: "Chauffeurs", icon: "users", badge: 0, badgeTone: "amber", badgeLabel: "0 document à valider" },
          { href: "/dashboard/network", label: "Inscriptions", icon: "userPlus", badge: 4, badgeTone: "brand", badgeLabel: "4 candidatures en attente" },
        ],
      },
      {
        title: "Gestion",
        items: [
          { href: "/dashboard/stats", label: "Statistiques", icon: "chart" },
          { href: "/dashboard/dispatch", label: "Journal du dispatch", icon: "scroll" },
          { href: "/dashboard/integrations", label: "API & site web", icon: "key" },
          { href: "/dashboard/booking-site", label: "Mini-site", icon: "globe" },
          { href: "/dashboard/settings", label: "Réglages", icon: "settings" },
        ],
      },
      { title: "Plateforme", items: [{ href: "/admin", label: "Espace super admin", icon: "shield" }] },
    ]);
  });

  it("centrale sans réseau partagé : « Réseau » (icône réseau) ; encaissements sans retard en ambre", () => {
    const nav = dashboardNav({ privateFleet: false, model: "centrale", role: "dispatcher", counts: { declared: 1, applications: 2 } });
    const items = nav[0]!.items;
    expect(items.find((i) => i.href === "/dashboard/network")).toEqual({
      href: "/dashboard/network",
      label: "Réseau",
      icon: "network",
      badge: 2,
      badgeTone: "brand",
      badgeLabel: "2 candidatures en attente",
    });
    expect(items.find((i) => i.href === "/dashboard/settlements")).toMatchObject({ badge: 1, badgeTone: "amber", badgeLabel: "1 paiement à confirmer" });
    // Aucun compteur fourni : pastilles à 0 (rien d'affiché), libellés au singulier
    expect(items.find((i) => i.href === "/dashboard/messages")).toMatchObject({ badge: 0, badgeLabel: "0 message non lu" });
  });

  it("dispatcher : ni « API & site web » ni « Mini-site » (même mini-sites ouverts), le reste comme le propriétaire", () => {
    const flags = { bookingSites: true, rydarFees: true, superAdmin: false, networkNav: null };
    const labels = (model: "fleet" | "centrale", role: string) =>
      dashboardNav({ privateFleet: false, model, role, flags }).map((s) => `${s.title} : ${s.items.map((i) => i.label).join(", ")}`);
    expect(labels("fleet", "dispatcher")).toEqual([
      "Au quotidien : En direct, Messages, Courses, Chauffeurs, Inscriptions",
      "Gestion : Statistiques, Journal du dispatch, Réglages",
    ]);
    expect(labels("centrale", "dispatcher")).toEqual([
      "Au quotidien : En direct, Messages, Courses, Encaissements, Chauffeurs, Réseau",
      "Gestion : Statistiques, Journal du dispatch, Réglages",
    ]);
    // Propriétaire et administrateur : les deux entrées, à leur place
    for (const role of ["owner", "admin"]) {
      expect(labels("centrale", role)[1]).toBe("Gestion : Statistiques, Journal du dispatch, API & site web, Mini-site, Réglages");
    }
    expect(labels("fleet", "owner")[1]).toBe("Gestion : Statistiques, Journal du dispatch, API & site web, Mini-site, Frais Rydar, Réglages");
    // Mini-sites coupés par la plateforme : jamais l'entrée, quel que soit le rôle
    expect(
      dashboardNav({ privateFleet: false, model: "fleet", role: "owner", flags: { ...flags, bookingSites: false } })
        .flatMap((s) => s.items)
        .map((i) => i.href),
    ).not.toContain("/dashboard/booking-site");
  });

  it("pastille de « Courses » : ce qu'elle compte, en toutes lettres (singulier, pluriel, absente)", () => {
    const rides = (alerts?: number) =>
      dashboardNav({ privateFleet: false, model: "fleet", role: "owner", counts: alerts === undefined ? {} : { alerts } })[0]!.items.find(
        (i) => i.href === "/dashboard/rides",
      );
    expect(rides(1)).toMatchObject({ badge: 1, badgeTone: "red", badgeLabel: "1 course sans chauffeur (6 dernières heures et à venir)" });
    expect(rides(7)).toMatchObject({ badge: 7, badgeTone: "red", badgeLabel: "7 courses sans chauffeur (6 dernières heures et à venir)" });
    expect(rides()).toMatchObject({ badge: 0, badgeLabel: "0 course sans chauffeur (6 dernières heures et à venir)" });
  });

  it("flotte avec des frais Rydar : entrée « Frais Rydar » pour owner / admin seulement", () => {
    const fees = (role: string) =>
      dashboardNav({ privateFleet: false, model: "fleet", role, flags: { rydarFees: true } }).find((s) => s.title === "Gestion")!.items;
    expect(fees("owner")).toEqual([
      { href: "/dashboard/stats", label: "Statistiques", icon: "chart" },
      { href: "/dashboard/dispatch", label: "Journal du dispatch", icon: "scroll" },
      { href: "/dashboard/integrations", label: "API & site web", icon: "key" },
      { href: "/dashboard/rydar", label: "Frais Rydar", icon: "landmark" },
      { href: "/dashboard/settings", label: "Réglages", icon: "settings" },
    ]);
    expect(fees("admin").map((i) => i.label)).toEqual(["Statistiques", "Journal du dispatch", "API & site web", "Frais Rydar", "Réglages"]);
    expect(fees("dispatcher").map((i) => i.label)).toEqual(["Statistiques", "Journal du dispatch", "Réglages"]);
  });

  it("au plus quatre sections métier, chaque adresse une seule fois, mêmes adresses qu'avant", () => {
    const nav = dashboardNav({
      privateFleet: false,
      model: "centrale",
      role: "owner",
      flags: { bookingSites: true, rydarFees: true, superAdmin: true, networkNav: networkNavItem({ badge: 0, toConfirm: 0, overdue: 0, toCheck: 0 }) },
    });
    expect(nav.map((s) => s.title)).toEqual(["Au quotidien", "Gestion", "Plateforme"]);
    const hrefs = nav.flatMap((s) => s.items).map((i) => i.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    expect([...hrefs].sort()).toEqual(
      [
        "/dashboard", "/dashboard/messages", "/dashboard/rides", "/dashboard/settlements", NETWORK_SHARE_PATH, "/dashboard/drivers",
        "/dashboard/network", "/dashboard/stats", "/dashboard/dispatch", "/dashboard/integrations", "/dashboard/booking-site",
        "/dashboard/settings", "/admin",
      ].sort(),
    );
  });
});

describe("menu Flotte Privée (§ 7.2)", () => {
  // `alerts` (compte brut des courses sans chauffeur, standard) jamais affiché : la pastille rouge = `notConfirmed`
  const counts = { toTreat: 3, notConfirmed: 1, alerts: 7, expiringDocuments: 2, unread: 9, pendingDocuments: 4, applications: 5, declared: 1, overdue: 1 };

  it("exactement : Mon activité (Accueil, Agenda, Réservations, Mon site), Mon entreprise (profil, Activité, Réglages)", () => {
    const nav = dashboardNav({
      privateFleet: true,
      model: "fleet",
      role: "owner",
      counts,
      // Rien de l'espace standard, même si la plateforme ouvre le réseau ou les mini-sites
      flags: { bookingSites: true, rydarFees: false, superAdmin: true, networkNav: networkNavItem({ badge: 1, toConfirm: 1, overdue: 0, toCheck: 0 }) },
    });
    expect(nav).toEqual([
      {
        title: "Mon activité",
        items: [
          { href: "/dashboard", label: "Accueil", icon: "home", exact: true, badge: 3, badgeTone: "amber", badgeLabel: "3 réservations à traiter" },
          { href: "/dashboard/agenda", label: "Agenda", icon: "calendar" },
          { href: "/dashboard/rides", label: "Réservations", icon: "route", badge: 1, badgeTone: "red", badgeLabel: "1 réservation non confirmée" },
          { href: "/dashboard/site", label: "Mon site", icon: "globe" },
        ],
      },
      {
        title: "Mon entreprise",
        items: [
          {
            href: "/dashboard/profil",
            label: "Mon profil chauffeur",
            icon: "car",
            badge: 2,
            badgeTone: "amber",
            badgeLabel: "2 documents à renouveler",
          },
          { href: "/dashboard/stats", label: "Activité", icon: "chart" },
          { href: "/dashboard/settings", label: "Réglages", icon: "settings" },
        ],
      },
    ]);
  });

  it("« Frais Rydar » seulement quand des frais sont réglés (org_platform_fees_enabled), à sa place", () => {
    const entreprise = (rydarFees: boolean) =>
      dashboardNav({ privateFleet: true, model: "fleet", role: "owner", counts, flags: { rydarFees } })[1]!.items.map((i) => `${i.label} ${i.href}`);
    expect(entreprise(true)).toEqual([
      "Mon profil chauffeur /dashboard/profil",
      "Activité /dashboard/stats",
      "Frais Rydar /dashboard/rydar",
      "Réglages /dashboard/settings",
    ]);
    expect(entreprise(false)).toEqual(["Mon profil chauffeur /dashboard/profil", "Activité /dashboard/stats", "Réglages /dashboard/settings"]);
  });

  it("aucune page masquée et refusée n'apparaît, quel que soit l'état", () => {
    const hrefs = dashboardNav({ privateFleet: true, model: "fleet", role: "owner", counts, flags: { rydarFees: true, bookingSites: true, superAdmin: true } })
      .flatMap((s) => s.items)
      .map((i) => i.href);
    for (const hidden of [
      "/dashboard/drivers", "/dashboard/network", "/dashboard/reseau-partage", "/dashboard/settlements", "/dashboard/messages",
      "/dashboard/dispatch", "/dashboard/integrations", "/dashboard/booking-site", "/admin",
    ]) {
      expect(hrefs).not.toContain(hidden);
    }
    // Pastilles absentes : 0 (rien d'affiché), libellés corrects
    const empty = dashboardNav({ privateFleet: true, model: "fleet", role: "owner" });
    expect(empty[0]!.items[0]).toMatchObject({ badge: 0, badgeLabel: "0 réservation à traiter" });
  });

  it("alerte rouge de « Réservations » : non confirmées seulement, jamais le compte brut des courses sans chauffeur", () => {
    const rides = (c: Record<string, number>) =>
      dashboardNav({ privateFleet: true, model: "fleet", role: "owner", counts: c })[0]!.items.find((i) => i.href === "/dashboard/rides");
    // Réservation refusée par le chauffeur lui-même : dans le compte brut (NO_DRIVER_FOUND), jamais dans la pastille
    expect(rides({ alerts: 1, notConfirmed: 0 })).toMatchObject({ badge: 0, badgeLabel: "0 réservation non confirmée" });
    expect(rides({ alerts: 5, notConfirmed: 2 })).toMatchObject({ badge: 2, badgeTone: "red", badgeLabel: "2 réservations non confirmées" });
  });
});

describe("sous-titre de la barre latérale (§ 7.2)", () => {
  it("Flotte Privée : « Flotte Privée » sous le nom de l'organisation ; standard : rien (le rôle reste affiché)", () => {
    expect(sidebarOrgCaption(true)).toBe("Flotte Privée");
    expect(sidebarOrgCaption(false)).toBeNull();
  });

  it("le sous-titre est visible : le tableau de bord le passe à la barre latérale, qui l'affiche à la place du rôle", () => {
    // Recette L7 : « Flotte Privée » n'était qu'un attribut title du logo (invisible), le rôle « Propriétaire » restait affiché
    const read = (f: string) => readFileSync(join(import.meta.dirname, f), "utf8");
    expect(read("dashboard-shell.tsx")).toMatch(/orgCaption=\{sidebarOrgCaption\(!!privateFleet\)\}/);
    expect(read("sidebar.tsx")).toMatch(/\{orgCaption \?\? ORG_ROLE_LABELS\[current\.role as OrgRole\] \?\? current\.role\}/);
  });
});

// Import au chargement du fichier (jamais dans un test : le chargement de Radix et des icônes compterait dans son délai)
const sidebarModule = await import("./sidebar");

describe("barre latérale (R1)", () => {
  const sidebar = async () => sidebarModule;
  const base = {
    sections: [
      { title: "Au quotidien", items: [{ href: "/dashboard", label: "En direct", icon: "radar" as const, exact: true }] },
      { title: "Gestion", items: [{ href: "/dashboard/settings", label: "Réglages", icon: "settings" as const }] },
    ],
    subtitle: "Dispatch",
    user: { name: "Nadia Benhamou", email: "direction@elite-paris.fr" },
    signOut: () => undefined,
  };
  const render = async (props: Record<string, unknown>) => {
    const { Sidebar } = await sidebar();
    return renderToStaticMarkup(createElement(Sidebar, { ...base, ...props } as never));
  };

  it("une seule organisation : bloc statique (nom, rôle), ni chevron ni menu « Organisations »", async () => {
    const html = await render({ orgs: [{ id: "o1", name: "Élite Chauffeurs Paris", role: "owner" }], currentOrgId: "o1" });
    expect(html).toContain("Élite Chauffeurs Paris");
    expect(html).toContain("Propriétaire");
    // Seul le menu du compte ouvre un menu
    expect(html.match(/aria-haspopup="menu"/g)).toHaveLength(1);
    expect(html).not.toContain("Organisations");
    expect(html).not.toContain("lucide-chevrons-up-down");
  });

  it("plusieurs organisations : sélecteur inchangé (bouton à chevron qui ouvre « Organisations »)", async () => {
    const html = await render({
      orgs: [
        { id: "o1", name: "Élite Chauffeurs Paris", role: "owner" },
        { id: "o2", name: "Centrale Express Paris", role: "dispatcher" },
      ],
      currentOrgId: "o2",
      orgCaption: null,
    });
    expect(html.match(/aria-haspopup="menu"/g)).toHaveLength(2);
    expect(html).toContain("lucide-chevrons-up-down");
    expect(html).toContain("Centrale Express Paris");
    expect(html).toContain("Dispatcher");
  });

  it("Flotte Privée : sous-titre à la place du rôle", async () => {
    const html = await render({ orgs: [{ id: "o1", name: "Lambert VTC", role: "owner" }], currentOrgId: "o1", orgCaption: "Flotte Privée" });
    expect(html).toContain("Flotte Privée");
    expect(html).not.toContain("Propriétaire");
  });

  it("une seule zone défilante : menu, information cookies puis les 8 liens légaux compacts, avant le compte", async () => {
    const html = await render({ notice: createElement("div", { "data-testid": "notice" }, "Cookies nécessaires uniquement") });
    const zone = html.indexOf("data-sidebar-scroll");
    const nav = html.indexOf('aria-label="Menu principal"');
    const notice = html.indexOf("Cookies nécessaires uniquement");
    const legal = html.indexOf('aria-label="Informations légales"');
    const account = html.indexOf("direction@elite-paris.fr");
    expect(zone).toBeGreaterThan(0);
    expect(zone).toBeLessThan(nav);
    expect(nav).toBeLessThan(notice);
    expect(notice).toBeLessThan(legal);
    expect(legal).toBeLessThan(account);
    expect(html.match(/overflow-y-auto/g)).toHaveLength(1);
    const legalNav = html.slice(legal, html.indexOf("</nav>", legal));
    expect(legalNav.match(/<a /g)).toHaveLength(8);
    expect(legalNav).toContain("text-[12px]");
    expect(legalNav).toContain("·");
  });

  it("entrée active : adresse, sous-page ou préfixe de `match` (pages regroupées)", async () => {
    const { navItemActive } = await sidebar();
    const supervision = { href: "/admin/dispatch", match: ["/admin/notifications", "/admin/emails", "/admin/audit"] };
    expect(navItemActive(supervision, "/admin/dispatch")).toBe(true);
    expect(navItemActive(supervision, "/admin/notifications")).toBe(true);
    expect(navItemActive(supervision, "/admin/audit/123")).toBe(true);
    expect(navItemActive(supervision, "/admin/auditeurs")).toBe(false);
    expect(navItemActive({ href: "/dashboard", exact: true }, "/dashboard/rides")).toBe(false);
    expect(navItemActive({ href: "/dashboard/rides" }, "/dashboard/rides/42")).toBe(true);
    const html = await render({
      sections: [{ title: "Plateforme", items: [{ href: "/admin/dispatch", label: "Supervision", icon: "radar", match: supervision.match }] }],
    });
    expect(html).toMatch(/<a [^>]*href="\/admin\/dispatch"[^>]*aria-current="page"|<a [^>]*aria-current="page"[^>]*href="\/admin\/dispatch"/);
  });

  it("pastille : nombre visible et ce qu'il compte en toutes lettres (aria-label)", async () => {
    const html = await render({
      sections: [{ title: "Au quotidien", items: [{ href: "/dashboard/rides", label: "Courses", icon: "route", badge: 2, badgeTone: "red", badgeLabel: "2 courses sans chauffeur (6 dernières heures et à venir)" }] }],
    });
    expect(html).toContain('aria-label="2 courses sans chauffeur (6 dernières heures et à venir)"');
    expect(html).toMatch(/text-\[12px\][^"]*"[^>]*>2<\/span>/);
  });
});
