"use client";
import type { PlatformEvent } from "@rydar/shared";
import { useRouter } from "next/navigation";
import { AlertDialog as A } from "radix-ui";
import { useEffect, useRef, useState, useTransition } from "react";
import { AlertsBell, AlertsProvider } from "@/components/alerts/dispatch-alerts";
import { ChatUnreadProvider, useChatUnread } from "@/components/chat/unread-provider";
import { CookieNotice } from "@/components/legal/cookie-notice";
import { joinNavLabel } from "@/components/network/join-copy";
import { networkNavItem, type NetworkNavState } from "@/components/network-share/nav";
import { OrgPlatformBanner } from "@/components/platform-fees/org-platform-banner";
import { platformFeesPaths } from "@/components/platform-fees/org-platform-paths";
import { RealtimeProvider, useRealtimeEvent } from "@/components/realtime/realtime-provider";
import { CentraleProvider, type CentraleInfo } from "@/components/settlements/centrale-context";
import { EMPTY_CENTRALE_COUNTS, fetchCentraleCounts, fetchNetworkNav, type CentraleCounts } from "@/components/settlements/counts";
import { Sidebar, type NavSection } from "@/components/shell/sidebar";
import { SkipToContent } from "@/components/shell/skip-to-content";
import { Button } from "@/components/ui/button";
import { signOut } from "@/app/login/actions";
import { switchOrganization } from "@/app/dashboard/actions";
import { announceOrgSwitch, onOrgSwitch } from "@/lib/org-switch";
import { countPendingDocuments } from "@/lib/queries/pending-documents";
import { runAction } from "@/lib/run-action";
import { getBrowserClient } from "@/lib/supabase/client";

type ShellProps = {
  children: React.ReactNode;
  org: { id: string; name: string; role: string };
  orgs: { id: string; name: string; role: string }[];
  user: { id: string; name: string; email: string };
  alerts?: number;
  /** Messages non lus (chat_overview.unread_total) au chargement */
  unreadMessages?: number;
  /** Messages du fil « Chauffeurs » signalés, en attente de décision (chat_overview.open_reports) au chargement */
  openReports?: number;
  /** Documents chauffeur déposés, en attente de validation */
  pendingDocuments?: number;
  /** Modèle d'exploitation + réglages d'encaissement (mode centrale) */
  centrale: CentraleInfo;
  /** Candidatures en attente (les deux modèles) ; mode centrale : règlements à confirmer / en retard */
  centraleCounts?: CentraleCounts | null;
  /** Bandeau au-dessus du contenu (conditions à accepter) */
  topBanner?: React.ReactNode;
  /** Compte super admin aussi membre de la centrale : lien vers l'espace plateforme (/admin, droits revérifiés là-bas) */
  superAdmin?: boolean;
  /** Mini-sites servis par la plateforme (interrupteur du super admin) : sinon, entrée « Mini-site » masquée */
  bookingSites?: boolean;
  /** Flotte avec des frais Rydar (owner / admin, org_platform_fees_enabled) : entrée « Frais Rydar » + bandeau d'échéance */
  rydarFees?: boolean;
  /**
   * Réseau partagé ouvert par la plateforme (shared_network_enabled()) : entrée « Réseau partagé » + pastille (à confirmer
   * + en retard + à vérifier). null / absent : réseau fermé, AUCUNE entrée (rien ne change pour personne).
   */
  sharedNetwork?: NetworkNavState | null;
};

export function DashboardShell(props: ShellProps) {
  const { org, user } = props;
  return (
    <RealtimeProvider topic={`org:${org.id}`}>
      <CentraleProvider value={props.centrale}>
        <ChatUnreadProvider key={org.id} initial={props.unreadMessages ?? 0} initialOpenReports={props.openReports} userId={user.id}>
          <ShellBody {...props} />
        </ChatUnreadProvider>
      </CentraleProvider>
    </RealtimeProvider>
  );
}

/**
 * Compteurs « Encaissements » (centrale) et « Réseau » / « Inscriptions » (candidatures, les deux modèles) : valeur
 * serveur, relue après chaque événement.
 */
function useCentraleCounts(orgId: string, centrale: boolean, initial: CentraleCounts | null | undefined) {
  const [counts, setCounts] = useState<CentraleCounts>(initial ?? EMPTY_CENTRALE_COUNTS);
  useEffect(() => setCounts(initial ?? EMPTY_CENTRALE_COUNTS), [initial]);
  const timer = useRef<number | null>(null);
  const reload = () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      fetchCentraleCounts(getBrowserClient(), orgId, { settlements: centrale })
        .then(setCounts)
        .catch(() => undefined);
    }, 600);
  };
  useRealtimeEvent("settlement.updated", () => centrale && reload());
  useRealtimeEvent("driver.application", reload);
  // Une commission devient « en retard » à son échéance, sans événement : relecture régulière (onglet visible ;
  // au retour sur l'onglet si un tour a été sauté)
  useEffect(() => {
    if (!centrale) return;
    let missed = false;
    const id = window.setInterval(() => {
      if (document.visibilityState === "hidden") missed = true;
      else reload();
    }, 120_000);
    const onVisibility = () => {
      if (document.visibilityState !== "visible" || !missed) return;
      missed = false;
      reload();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [centrale, orgId]);
  return counts;
}

/**
 * Pastille « Réseau partagé » : valeur serveur, relue (org_network_summary) après un événement du réseau ou d'un
 * règlement, et régulièrement (un règlement passe « en retard » sans événement). Inactif quand le réseau est fermé.
 */
function useNetworkNav(orgId: string, initial: NetworkNavState | null | undefined) {
  const [state, setState] = useState<NetworkNavState | null>(initial ?? null);
  useEffect(() => setState(initial ?? null), [initial]);
  const enabled = !!initial;
  const timer = useRef<number | null>(null);
  const reload = () => {
    if (!enabled) return;
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      fetchNetworkNav(getBrowserClient(), orgId)
        .then((next) => next && setState(next))
        .catch(() => undefined);
    }, 600);
  };
  useRealtimeEvent("network.updated", reload);
  useRealtimeEvent("settlement.updated", reload);
  useEffect(() => {
    if (!enabled) return;
    let missed = false;
    const id = window.setInterval(() => {
      if (document.visibilityState === "hidden") missed = true;
      else reload();
    }, 120_000);
    const onVisibility = () => {
      if (document.visibilityState !== "visible" || !missed) return;
      missed = false;
      reload();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled, orgId]);
  return enabled ? state : null;
}

const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;

function ShellBody({
  children, org, orgs, user, alerts, pendingDocuments: pendingInitial, centrale, centraleCounts, topBanner, superAdmin, bookingSites, rydarFees,
  sharedNetwork,
}: ShellProps) {
  const router = useRouter();
  const [, start] = useTransition();
  const { unread, openReports } = useChatUnread();
  const isCentrale = centrale.model === "centrale";
  const counts = useCentraleCounts(org.id, isCentrale, centraleCounts);
  const networkNav = networkNavItem(useNetworkNav(org.id, sharedNetwork));
  const isAdmin = org.role === "owner" || org.role === "admin";
  // Frais dus à Rydar : centrale → carte d'« Encaissements » ; flotte avec des frais → entrée « Frais Rydar »
  const feePaths = platformFeesPaths(centrale.model);
  const fleetFees = !isCentrale && isAdmin && !!rydarFees;
  // Frais par course (« rates ») ou modèle (« model ») changés par le super admin : le layout relit l'entrée « Frais
  // Rydar », le bandeau et les menus du modèle, sans rechargement complet (événement rare, identifiants seulement)
  const ratesTimer = useRef<number | null>(null);
  useRealtimeEvent("platform.updated", (e: PlatformEvent) => {
    if ((e?.action !== "rates" && e?.action !== "model") || (e.organization_id && e.organization_id !== org.id)) return;
    if (ratesTimer.current) window.clearTimeout(ratesTimer.current);
    ratesTimer.current = window.setTimeout(() => router.refresh(), 800);
  });
  // Documents à valider : valeur serveur, relue après chaque dépôt / validation / refus (un incrément local compterait
  // aussi les pièces des candidats, que la page Chauffeurs n'affiche pas) et quand une candidature est traitée
  const [pendingDocuments, setPendingDocuments] = useState(pendingInitial ?? 0);
  useEffect(() => setPendingDocuments(pendingInitial ?? 0), [pendingInitial]);
  const docsTimer = useRef<number | null>(null);
  const reloadPendingDocuments = () => {
    if (docsTimer.current) window.clearTimeout(docsTimer.current);
    docsTimer.current = window.setTimeout(() => {
      countPendingDocuments(getBrowserClient(), org.id)
        .then((n) => n !== null && setPendingDocuments(n))
        .catch(() => undefined);
    }, 600);
  };
  useRealtimeEvent("driver.document", reloadPendingDocuments);
  useRealtimeEvent("driver.application", reloadPendingDocuments);
  // Centrale changée dans un autre onglet (cookie commun) : les actions de cet onglet partiraient vers elle
  const [switchedTo, setSwitchedTo] = useState<string | null>(null);
  useEffect(() => {
    setSwitchedTo(null);
    return onOrgSwitch((id) => setSwitchedTo(id === org.id ? null : id));
  }, [org.id]);
  const toSettle = counts.declared + counts.overdue;
  const settlementsLabel = [
    counts.declared ? plural(counts.declared, "paiement à confirmer", "paiements à confirmer") : null,
    counts.overdue ? plural(counts.overdue, "commission en retard", "commissions en retard") : null,
  ].filter(Boolean).join(" · ");
  // « Messages » : messages signalés à traiter (ambre) en priorité, sinon non-lus
  const unreadLabel = plural(unread, "message non lu", "messages non lus");
  const messagesLabel = openReports
    ? [plural(openReports, "message signalé à traiter", "messages signalés à traiter"), unread ? unreadLabel : null].filter(Boolean).join(" · ")
    : unreadLabel;
  const sections: NavSection[] = [
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
        { href: "/dashboard/rides", label: "Courses", icon: "route", badge: alerts },
        ...(isCentrale
          ? [
              {
                href: "/dashboard/settlements",
                label: "Encaissements",
                icon: "wallet" as const,
                badge: toSettle,
                badgeTone: counts.overdue ? ("red" as const) : ("amber" as const),
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
          label: joinNavLabel(centrale.model, !!networkNav),
          icon: isCentrale && !networkNav ? "network" : "userPlus",
          badge: counts.applications,
          badgeTone: "brand",
          badgeLabel: plural(counts.applications, "candidature en attente", "candidatures en attente"),
        },
        { href: "/dashboard/dispatch", label: "Journal du dispatch", icon: "scroll" },
      ],
    },
    { title: "Pilotage", items: [{ href: "/dashboard/stats", label: "Statistiques", icon: "chart" }] },
    {
      title: "Canaux",
      items: [
        { href: "/dashboard/integrations", label: "API & site web", icon: "key" },
        ...(bookingSites ? [{ href: "/dashboard/booking-site", label: "Mini-site", icon: "globe" as const }] : []),
      ],
    },
    {
      title: "Organisation",
      items: [
        ...(fleetFees ? [{ href: feePaths.page, label: "Frais Rydar", icon: "landmark" as const }] : []),
        { href: "/dashboard/settings", label: "Réglages", icon: "settings" },
      ],
    },
    ...(superAdmin ? [{ title: "Plateforme", items: [{ href: "/admin", label: "Espace super admin", icon: "shield" as const }] }] : []),
  ];
  return (
    <AlertsProvider key={org.id} scope={`${org.id}:${user.email}`}>
      {/* Premier élément au clavier : saute la barre latérale */}
      <SkipToContent />
      <Sidebar
        headerAction={<AlertsBell />}
        sections={sections}
        subtitle="Dispatch"
        user={user}
        orgs={orgs}
        currentOrgId={org.id}
        onSwitchOrg={(id) =>
          start(() => runAction(async () => {
            await switchOrganization(id);
            announceOrgSwitch(id);
            router.refresh();
          }))
        }
        signOut={() => start(() => runAction(() => signOut()))}
        notice={<CookieNotice href="/cookies" placement="sidebar" />}
      />
      <div className="lg:pl-[232px]">
        <main id="contenu" tabIndex={-1} className="outline-none">
          {/* Frais plateforme dus à Rydar (owner / admin : centrale, ou flotte avec des frais Rydar) */}
          <OrgPlatformBanner orgId={org.id} timeZone={centrale.timeZone} enabled={isAdmin && (isCentrale || fleetFees)} paths={feePaths} />
          {topBanner}
          {children}
        </main>
      </div>
      {switchedTo && (
        <OrgSwitchedDialog
          current={org}
          otherName={orgs.find((o) => o.id === switchedTo)?.name ?? null}
          onStay={() => setSwitchedTo(null)}
        />
      )}
    </AlertsProvider>
  );
}

/**
 * Bloque l'onglet dont la centrale a été changée ailleurs, sans le recharger (une saisie en cours reste visible) :
 * « Continuer » recharge sur la nouvelle centrale, « Revenir » re-sélectionne celle de l'onglet (les autres sont prévenus).
 */
function OrgSwitchedDialog({ current, otherName, onStay }: { current: { id: string; name: string }; otherName: string | null; onStay: () => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const stay = () =>
    start(() => runAction(async () => {
      await switchOrganization(current.id);
      announceOrgSwitch(current.id);
      onStay();
      router.refresh();
    }));
  return (
    <A.Root open>
      <A.Portal>
        <A.Overlay className="fixed inset-0 z-[60] bg-black/60 backdrop-blur-sm" />
        <A.Content className="glass fixed left-1/2 top-1/2 z-[60] max-h-[90vh] w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl p-6">
          <A.Title className="text-lg font-semibold tracking-tight">Centrale changée dans un autre onglet</A.Title>
          <A.Description className="mt-2 text-sm text-fg-muted">
            Cet onglet affiche encore {current.name}, mais vos actions s&apos;appliqueraient maintenant à {otherName ?? "une autre centrale"}.
            Rechargez-le avant de continuer.
          </A.Description>
          <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="secondary" loading={pending} onClick={stay}>
              Revenir à {current.name}
            </Button>
            <Button variant="primary" disabled={pending} onClick={() => window.location.reload()}>
              {otherName ? `Continuer sur ${otherName}` : "Recharger la page"}
            </Button>
          </div>
        </A.Content>
      </A.Portal>
    </A.Root>
  );
}
