// Menu du tableau de bord (barre latérale) : fonction pure, testée (dashboard-nav.test.ts). Organisation standard :
// menu historique, à l'identique (flotte ou centrale, rôle, compteurs, réseau partagé, mini-sites, frais Rydar).
// Flotte Privée (docs/FLOTTE-PRIVEE.md § 7.2) : « Mon activité » et « Mon entreprise », rien d'autre (les pages
// absentes sont aussi refusées, lib/private-fleet.ts). Module pur : ni « use client » ni « server-only ».
import type { DispatchModel } from "@rydar/shared";
import { joinNavLabel } from "../network/join-copy";
import type { NetworkNavItem } from "../network-share/nav";
import { platformFeesPaths } from "../platform-fees/org-platform-paths";
import type { NavSection } from "./sidebar";

/** Compteurs des pastilles (absents : 0). */
export type DashboardNavCounts = {
  /** Courses sans chauffeur des 6 dernières heures (alerte rouge de « Courses » / « Réservations ») */
  alerts?: number;
  /** Messages non lus et messages signalés à traiter (standard) */
  unread?: number;
  openReports?: number;
  /** Documents déposés à valider (standard, « Chauffeurs ») */
  pendingDocuments?: number;
  /** Candidatures en attente (standard, « Réseau » / « Inscriptions ») */
  applications?: number;
  /** Centrale : paiements à confirmer et commissions en retard (« Encaissements ») */
  declared?: number;
  overdue?: number;
  /** Flotte Privée : réservations à traiter (à confirmer, à vérifier, non confirmées) */
  toTreat?: number;
  /** Flotte Privée : documents expirés ou qui expirent sous 30 jours (« Mon profil chauffeur ») */
  expiringDocuments?: number;
};

export type DashboardNavFlags = {
  /** Mini-sites ouverts par la plateforme (entrée « Mini-site ») */
  bookingSites?: boolean;
  /** Flotte avec des frais Rydar (org_platform_fees_enabled) : entrée « Frais Rydar » (owner / admin) */
  rydarFees?: boolean;
  /** Compte super admin aussi membre : entrée « Espace super admin » (standard) */
  superAdmin?: boolean;
  /** Réseau partagé ouvert : entrée « Réseau partagé » (standard) ; null : réseau fermé */
  networkNav?: NetworkNavItem | null;
};

export type DashboardNavInput = {
  privateFleet: boolean;
  model: DispatchModel;
  role: string;
  counts?: DashboardNavCounts;
  flags?: DashboardNavFlags;
};

const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;

export function dashboardNav(input: DashboardNavInput): NavSection[] {
  return input.privateFleet ? privateFleetNav(input) : standardNav(input);
}

/** Menu des flottes et des centrales (inchangé). */
function standardNav({ model, role, counts = {}, flags = {} }: DashboardNavInput): NavSection[] {
  const isCentrale = model === "centrale";
  const isAdmin = role === "owner" || role === "admin";
  const unread = counts.unread ?? 0;
  const openReports = counts.openReports ?? 0;
  const pendingDocuments = counts.pendingDocuments ?? 0;
  const applications = counts.applications ?? 0;
  const declared = counts.declared ?? 0;
  const overdue = counts.overdue ?? 0;
  const networkNav = flags.networkNav ?? null;
  const fleetFees = !isCentrale && isAdmin && !!flags.rydarFees;
  const toSettle = declared + overdue;
  const settlementsLabel = [
    declared ? plural(declared, "paiement à confirmer", "paiements à confirmer") : null,
    overdue ? plural(overdue, "commission en retard", "commissions en retard") : null,
  ].filter(Boolean).join(" · ");
  // « Messages » : messages signalés à traiter (ambre) en priorité, sinon non-lus
  const unreadLabel = plural(unread, "message non lu", "messages non lus");
  const messagesLabel = openReports
    ? [plural(openReports, "message signalé à traiter", "messages signalés à traiter"), unread ? unreadLabel : null].filter(Boolean).join(" · ")
    : unreadLabel;
  return [
    {
      title: "Opérations",
      items: [
        { href: "/dashboard", label: "En direct", icon: "radar", exact: true },
        {
          href: "/dashboard/messages",
          label: "Messages",
          icon: "message",
          badge: openReports || unread,
          badgeTone: openReports ? "amber" : "brand",
          badgeLabel: messagesLabel,
        },
        { href: "/dashboard/rides", label: "Courses", icon: "route", badge: counts.alerts },
        ...(isCentrale
          ? [
              {
                href: "/dashboard/settlements",
                label: "Encaissements",
                icon: "wallet" as const,
                badge: toSettle,
                badgeTone: overdue ? ("red" as const) : ("amber" as const),
                badgeLabel: settlementsLabel,
              },
            ]
          : []),
        // Réseau partagé (flottes et centrales) : seulement quand la plateforme l'a ouvert
        ...(networkNav ? [networkNav] : []),
        {
          href: "/dashboard/drivers",
          label: "Chauffeurs",
          icon: "users",
          badge: pendingDocuments,
          badgeTone: "amber",
          badgeLabel: `${pendingDocuments} document${pendingDocuments > 1 ? "s" : ""} à valider`,
        },
        // Lien d'inscription + candidatures : « Réseau » en centrale, « Inscriptions » en flotte (même page), juste
        // sous « Chauffeurs », avec le nombre de candidatures à traiter ; « Inscriptions » pour les deux quand le réseau
        // partagé est ouvert (pas de confusion avec « Réseau partagé »)
        {
          href: "/dashboard/network",
          label: joinNavLabel(model, !!networkNav),
          icon: isCentrale && !networkNav ? "network" : "userPlus",
          badge: applications,
          badgeTone: "brand",
          badgeLabel: plural(applications, "candidature en attente", "candidatures en attente"),
        },
        { href: "/dashboard/dispatch", label: "Journal du dispatch", icon: "scroll" },
      ],
    },
    { title: "Pilotage", items: [{ href: "/dashboard/stats", label: "Statistiques", icon: "chart" }] },
    {
      title: "Canaux",
      items: [
        { href: "/dashboard/integrations", label: "API & site web", icon: "key" },
        ...(flags.bookingSites ? [{ href: "/dashboard/booking-site", label: "Mini-site", icon: "globe" as const }] : []),
      ],
    },
    {
      title: "Organisation",
      items: [
        ...(fleetFees ? [{ href: platformFeesPaths(model).page, label: "Frais Rydar", icon: "landmark" as const }] : []),
        { href: "/dashboard/settings", label: "Réglages", icon: "settings" },
      ],
    },
    ...(flags.superAdmin ? [{ title: "Plateforme", items: [{ href: "/admin", label: "Espace super admin", icon: "shield" as const }] }] : []),
  ];
}

/** Menu de la Flotte Privée (§ 7.2) : « Frais Rydar » seulement si des frais sont réglés (owner / admin). */
function privateFleetNav({ role, counts = {}, flags = {} }: DashboardNavInput): NavSection[] {
  const isAdmin = role === "owner" || role === "admin";
  const toTreat = counts.toTreat ?? 0;
  const alerts = counts.alerts ?? 0;
  const documents = counts.expiringDocuments ?? 0;
  return [
    {
      title: "Mon activité",
      items: [
        {
          href: "/dashboard",
          label: "Accueil",
          icon: "home",
          exact: true,
          badge: toTreat,
          badgeTone: "amber",
          badgeLabel: plural(toTreat, "réservation à traiter", "réservations à traiter"),
        },
        { href: "/dashboard/agenda", label: "Agenda", icon: "calendar" },
        {
          href: "/dashboard/rides",
          label: "Réservations",
          icon: "route",
          badge: alerts,
          badgeTone: "red",
          badgeLabel: plural(alerts, "réservation sans chauffeur", "réservations sans chauffeur"),
        },
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
          badge: documents,
          badgeTone: "amber",
          badgeLabel: plural(documents, "document à renouveler", "documents à renouveler"),
        },
        { href: "/dashboard/stats", label: "Activité", icon: "chart" },
        ...(isAdmin && flags.rydarFees ? [{ href: platformFeesPaths("fleet").page, label: "Frais Rydar", icon: "landmark" as const }] : []),
        { href: "/dashboard/settings", label: "Réglages", icon: "settings" },
      ],
    },
  ];
}
