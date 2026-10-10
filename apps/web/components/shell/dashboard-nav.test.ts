import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { networkNavItem } from "../network-share/nav";
import { NETWORK_SHARE_PATH } from "../network-share/paths";
import { dashboardNav, sidebarOrgCaption } from "./dashboard-nav";

// Menu du tableau de bord (docs/FLOTTE-PRIVEE.md § 7.2) : organisation standard → menu historique À L'IDENTIQUE
// (instantané écrit d'après le tableau de dashboard-shell.tsx avant son extraction) ; Flotte Privée → « Mon activité »
// et « Mon entreprise » exactement, « Frais Rydar » seulement avec des frais (owner / admin).

describe("menu standard : identique au menu historique", () => {
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
        title: "Opérations",
        items: [
          { href: "/dashboard", label: "En direct", icon: "radar", exact: true },
          { href: "/dashboard/messages", label: "Messages", icon: "message", badge: 3, badgeTone: "brand", badgeLabel: "3 messages non lus" },
          { href: "/dashboard/rides", label: "Courses", icon: "route", badge: 2 },
          { href: "/dashboard/drivers", label: "Chauffeurs", icon: "users", badge: 1, badgeTone: "amber", badgeLabel: "1 document à valider" },
          { href: "/dashboard/network", label: "Inscriptions", icon: "userPlus", badge: 0, badgeTone: "brand", badgeLabel: "0 candidature en attente" },
          { href: "/dashboard/dispatch", label: "Journal du dispatch", icon: "scroll" },
        ],
      },
      { title: "Pilotage", items: [{ href: "/dashboard/stats", label: "Statistiques", icon: "chart" }] },
      { title: "Canaux", items: [{ href: "/dashboard/integrations", label: "API & site web", icon: "key" }] },
      { title: "Organisation", items: [{ href: "/dashboard/settings", label: "Réglages", icon: "settings" }] },
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
        title: "Opérations",
        items: [
          { href: "/dashboard", label: "En direct", icon: "radar", exact: true },
          {
            href: "/dashboard/messages",
            label: "Messages",
            icon: "message",
            badge: 1,
            badgeTone: "amber",
            badgeLabel: "1 message signalé à traiter · 2 messages non lus",
          },
          { href: "/dashboard/rides", label: "Courses", icon: "route", badge: 0 },
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
          { href: "/dashboard/dispatch", label: "Journal du dispatch", icon: "scroll" },
        ],
      },
      { title: "Pilotage", items: [{ href: "/dashboard/stats", label: "Statistiques", icon: "chart" }] },
      {
        title: "Canaux",
        items: [
          { href: "/dashboard/integrations", label: "API & site web", icon: "key" },
          { href: "/dashboard/booking-site", label: "Mini-site", icon: "globe" },
        ],
      },
      { title: "Organisation", items: [{ href: "/dashboard/settings", label: "Réglages", icon: "settings" }] },
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

  it("flotte avec des frais Rydar : entrée « Frais Rydar » pour owner / admin seulement", () => {
    const fees = (role: string) =>
      dashboardNav({ privateFleet: false, model: "fleet", role, flags: { rydarFees: true } }).find((s) => s.title === "Organisation")!.items;
    expect(fees("owner")).toEqual([
      { href: "/dashboard/rydar", label: "Frais Rydar", icon: "landmark" },
      { href: "/dashboard/settings", label: "Réglages", icon: "settings" },
    ]);
    expect(fees("admin").map((i) => i.label)).toEqual(["Frais Rydar", "Réglages"]);
    expect(fees("dispatcher").map((i) => i.label)).toEqual(["Réglages"]);
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
