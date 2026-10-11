"use client";
import { useTransition } from "react";
import { SUPERVISION_MATCH } from "@/components/admin/supervision-tabs";
import { CookieNotice } from "@/components/legal/cookie-notice";
import { Sidebar, type NavSection } from "@/components/shell/sidebar";
import { SkipToContent } from "@/components/shell/skip-to-content";
import type { TourBoot } from "@/components/tour/tour-model";
import { TourProvider, useTourMenu } from "@/components/tour/tour-provider";
import { Badge } from "@/components/ui/badge";
import { signOut } from "@/app/login/actions";
import { runAction } from "@/lib/run-action";
import { plural } from "@/lib/wording";

/** Compteurs des pastilles du menu (lus par app/admin/layout.tsx ; absents : 0, pas de pastille). */
export type AdminNavCounts = {
  /** Signalements de fraude à examiner (pastille « Signalements de fraude ») */
  openReports?: number;
  /** Paiements de frais Rydar à confirmer + baisses de frais à valider (pastille « Frais Rydar ») */
  platformToReview?: number;
  /**
   * Suppressions de compte en échec (10 essais) ou en retard (le worker ne reprend pas la file) : pastille
   * « Suppressions de comptes » (admin_account_deletions : failed + stalled)
   */
  deletionsToReview?: number;
  /** Nouvelles demandes du formulaire de contact, pas encore ouvertes (pastille « Demandes de contact ») */
  contactsToReview?: number;
  /** Réseau partagé : organisations à valider (demandes, validations perdues) — pastille « Réseau partagé » */
  networkToReview?: number;
};

/**
 * Menu du super admin (docs/REFONTE-PANELS.md, R2) : quatre groupes métier, dans cet ordre exact — Pilotage, Clients,
 * Argent, Plateforme — puis « Mon espace » (compte aussi membre d'une centrale). Le libellé de chaque entrée est le
 * titre (h1) de sa page ; « Supervision » réunit les journaux techniques (Dispatch & erreurs, Notifications, E-mails,
 * Sécurité & audit : onglets de leur en-tête). Chaque pastille dit en toutes lettres ce qu'elle compte (aria-label).
 * Fonction pure (testée : components/admin/admin-pages.test.ts).
 */
export function adminNav(counts: AdminNavCounts = {}, centraleName: string | null = null): NavSection[] {
  const contacts = counts.contactsToReview ?? 0;
  const reports = counts.openReports ?? 0;
  const network = counts.networkToReview ?? 0;
  const fees = counts.platformToReview ?? 0;
  const deletions = counts.deletionsToReview ?? 0;
  return [
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
        {
          href: "/admin/contacts",
          label: "Demandes de contact",
          icon: "mail",
          badge: contacts,
          badgeTone: "brand",
          badgeLabel: plural(contacts, "nouvelle demande de contact", "nouvelles demandes de contact"),
        },
        {
          href: "/admin/signalements",
          label: "Signalements de fraude",
          icon: "shield",
          badge: reports,
          badgeTone: "red",
          badgeLabel: plural(reports, "signalement de fraude à examiner", "signalements de fraude à examiner"),
        },
        {
          href: "/admin/reseau",
          label: "Réseau partagé",
          icon: "share",
          badge: network,
          badgeTone: "amber",
          badgeLabel: plural(network, "organisation à valider pour le réseau partagé", "organisations à valider pour le réseau partagé"),
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
          badge: fees,
          badgeTone: "amber",
          badgeLabel: `${plural(fees, "élément à confirmer", "éléments à confirmer")} (paiements, baisses de frais)`,
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
          badge: deletions,
          badgeTone: "red",
          badgeLabel: plural(deletions, "suppression de compte en échec ou en retard", "suppressions de compte en échec ou en retard"),
        },
        // Journaux techniques : une entrée, active sur ses quatre pages (onglets de leur en-tête)
        { href: "/admin/dispatch", label: "Supervision", icon: "radar", match: [...SUPERVISION_MATCH] },
      ],
    },
    // Même compte, espace centrale (les droits de /dashboard sont ceux de l'adhésion à la centrale)
    ...(centraleName ? [{ title: "Mon espace", items: [{ href: "/dashboard", label: centraleName, icon: "building" as const }] }] : []),
  ];
}

type AdminShellProps = AdminNavCounts & {
  children: React.ReactNode;
  user: { name: string; email: string };
  /** Super admin aussi membre d'une ou plusieurs centrales : lien vers son espace centrale (/dashboard) */
  centraleName?: string | null;
  /** Visite guidée du super admin (docs/TUTORIEL.md § 6.11). Absente : aucune visite, rendu inchangé. */
  tour?: TourBoot | null;
};

export function AdminShell({ tour, ...props }: AdminShellProps) {
  return (
    <TourProvider boot={tour}>
      <AdminShellBody {...props} />
    </TourProvider>
  );
}

function AdminShellBody({
  children,
  user,
  openReports = 0,
  platformToReview = 0,
  deletionsToReview = 0,
  contactsToReview = 0,
  networkToReview = 0,
  centraleName = null,
}: Omit<AdminShellProps, "tour">) {
  const [, start] = useTransition();
  const sections = adminNav({ openReports, platformToReview, deletionsToReview, contactsToReview, networkToReview }, centraleName);
  // Visite guidée : « Reprendre la visite » / « Revoir la visite » dans le menu du compte
  const accountItems = useTourMenu();
  return (
    <>
      {/* Premier élément au clavier : saute la barre latérale */}
      <SkipToContent />
      <Sidebar
        sections={sections}
        subtitle="Super admin"
        user={user}
        signOut={() => start(() => runAction(() => signOut()))}
        notice={<CookieNotice href="/cookies" placement="sidebar" />}
        // Espace de la plateforme : un badge à côté du logo (barre et barre du haut sur téléphone), plus d'encadré
        // technique dans le menu
        headerAction={
          <Badge tone="brand" dot={false}>
            Super admin
          </Badge>
        }
        accountItems={accountItems}
      />
      <div className="lg:pl-[232px]">
        {/* Réserve de défilement sous la fenêtre de la visite en repli (--tour-reserve, posée par tour-card.tsx) */}
        <main id="contenu" tabIndex={-1} className="pb-[var(--tour-reserve,0px)] outline-none">
          {children}
        </main>
      </div>
    </>
  );
}
