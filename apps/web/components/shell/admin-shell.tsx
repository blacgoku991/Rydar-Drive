"use client";
import { useTransition } from "react";
import { CookieNotice } from "@/components/legal/cookie-notice";
import { Sidebar, type NavSection } from "@/components/shell/sidebar";
import { SkipToContent } from "@/components/shell/skip-to-content";
import { signOut } from "@/app/login/actions";
import { runAction } from "@/lib/run-action";

export function AdminShell({
  children,
  user,
  openReports = 0,
  platformToReview = 0,
  deletionsToReview = 0,
  contactsToReview = 0,
}: {
  children: React.ReactNode;
  user: { name: string; email: string };
  /** Signalements de fraude à examiner (pastille « Centrales ») */
  openReports?: number;
  /** Paiements de frais plateforme à confirmer + baisses de frais à valider (pastille « Frais plateforme ») */
  platformToReview?: number;
  /**
   * Suppressions de compte en échec (10 essais) ou en retard (le worker ne reprend pas la file) : pastille
   * « Suppressions de comptes » (admin_account_deletions : failed + stalled)
   */
  deletionsToReview?: number;
  /** Nouvelles demandes du formulaire de contact, pas encore ouvertes (pastille « Demandes de contact ») */
  contactsToReview?: number;
}) {
  const [, start] = useTransition();
  const sections: NavSection[] = [
    {
      title: "Plateforme",
      items: [
        { href: "/admin", label: "Vue d'ensemble", icon: "dashboard", exact: true },
        {
          href: "/admin/contacts",
          label: "Demandes de contact",
          icon: "mail",
          badge: contactsToReview,
          badgeTone: "brand",
          badgeLabel: `${contactsToReview} nouvelle${contactsToReview > 1 ? "s" : ""} demande${contactsToReview > 1 ? "s" : ""} de contact`,
        },
        { href: "/admin/carte", label: "Carte en direct", icon: "globe" },
        { href: "/admin/organizations", label: "Rattacheurs", icon: "building" },
        {
          href: "/admin/centrales",
          label: "Centrales",
          icon: "users",
          badge: openReports,
          badgeTone: "red",
          badgeLabel: `${openReports} signalement${openReports > 1 ? "s" : ""} de fraude à examiner`,
        },
        {
          href: "/admin/frais",
          label: "Frais plateforme",
          icon: "wallet",
          badge: platformToReview,
          badgeTone: "amber",
          badgeLabel: `${platformToReview} élément${platformToReview > 1 ? "s" : ""} à confirmer (paiements, baisses de frais)`,
        },
        { href: "/admin/plans", label: "Offres & limites", icon: "card" },
        { href: "/admin/legal", label: "Informations légales", icon: "scroll" },
      ],
    },
    {
      title: "Supervision",
      items: [
        { href: "/admin/dispatch", label: "Dispatch & erreurs", icon: "radar" },
        { href: "/admin/notifications", label: "Notifications", icon: "sparkles" },
        {
          href: "/admin/suppressions",
          label: "Suppressions de comptes",
          icon: "userX",
          badge: deletionsToReview,
          badgeTone: "red",
          badgeLabel: `${deletionsToReview} suppression${deletionsToReview > 1 ? "s" : ""} de compte en échec ou en retard`,
        },
        { href: "/admin/audit", label: "Sécurité & audit", icon: "shield" },
      ],
    },
  ];
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
        footer={
          <div className="rounded-xl border border-brand/20 bg-brand/[0.05] px-3 py-2.5 text-[12px] text-fg-muted">
            <span className="font-semibold text-brand">Mode plateforme</span> — accès en lecture à tous les tenants, écritures journalisées.
          </div>
        }
      />
      <div className="lg:pl-[232px]">
        <main id="contenu" tabIndex={-1} className="outline-none">
          {children}
        </main>
      </div>
    </>
  );
}
