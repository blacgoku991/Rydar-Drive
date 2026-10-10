"use client";
import type { PlatformEvent } from "@rydar/shared";
import { useRouter } from "next/navigation";
import { AlertDialog as A } from "radix-ui";
import { useEffect, useLayoutEffect, useRef, useState, useTransition } from "react";
import { AlertsBell, AlertsProvider } from "@/components/alerts/dispatch-alerts";
import { ChatUnreadProvider, useChatUnread } from "@/components/chat/unread-provider";
import { CookieNotice } from "@/components/legal/cookie-notice";
import { networkNavItem, type NetworkNavState } from "@/components/network-share/nav";
import { OrgPlatformBanner } from "@/components/platform-fees/org-platform-banner";
import { platformFeesPaths } from "@/components/platform-fees/org-platform-paths";
import { RealtimeProvider, useRealtimeEvent } from "@/components/realtime/realtime-provider";
import { useLiveSync } from "@/components/realtime/use-live-sync";
import { CentraleProvider, type CentraleInfo } from "@/components/settlements/centrale-context";
import { EMPTY_CENTRALE_COUNTS, fetchCentraleCounts, fetchNetworkNav, type CentraleCounts } from "@/components/settlements/counts";
import { countExpiringDocuments, countQueue } from "@/components/private-fleet/queue";
import { dashboardNav, sidebarOrgCaption } from "@/components/shell/dashboard-nav";
import { Sidebar } from "@/components/shell/sidebar";
import { SkipToContent } from "@/components/shell/skip-to-content";
import { Button } from "@/components/ui/button";
import { signOut } from "@/app/login/actions";
import { switchOrganization } from "@/app/dashboard/actions";
import { announceOrgSwitch, onOrgSwitch } from "@/lib/org-switch";
import { rememberViewedOrg } from "@/lib/org-view";
import { countPendingDocuments } from "@/lib/queries/pending-documents";
import { runAction } from "@/lib/run-action";
import { getBrowserClient } from "@/lib/supabase/client";

type ShellProps = {
  children: React.ReactNode;
  org: { id: string; name: string; role: string };
  orgs: { id: string; name: string; role: string }[];
  user: { id: string; name: string; email: string };
  /** Organisation standard : courses sans chauffeur des 6 dernières heures (Flotte Privée : `privateFleet.notConfirmed`) */
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
  /**
   * Flotte Privée (docs/FLOTTE-PRIVEE.md § 7.2 et 7.5) : menu épuré, sous-titre « Flotte Privée », pastilles « à
   * traiter », « non confirmées » et « documents à renouveler » ; ni messagerie, ni candidatures, ni documents à valider,
   * ni réseau. null / absent : organisation standard.
   */
  privateFleet?: PrivateFleetShell | null;
};

export type PrivateFleetShell = {
  /** Fiche chauffeur du propriétaire (null : fiche supprimée) */
  driverId: string | null;
  /** Réservations à traiter (à confirmer, à vérifier, non confirmées) */
  toTreat: number;
  /** Réservations non confirmées (sans chauffeur à l'échéance, hors ses propres refus) : alerte de « Réservations » */
  notConfirmed: number;
  /** Documents expirés ou qui expirent sous 30 jours */
  expiringDocuments: number;
};

export function DashboardShell(props: ShellProps) {
  const { org, user } = props;
  // Flotte Privée : aucune messagerie (§ 7.4) — ni compteur, ni relecture des non-lus
  const body = props.privateFleet ? (
    <ShellBody {...props} />
  ) : (
    <ChatUnreadProvider key={org.id} initial={props.unreadMessages ?? 0} initialOpenReports={props.openReports} userId={user.id}>
      <ShellBody {...props} />
    </ChatUnreadProvider>
  );
  return (
    <RealtimeProvider topic={`org:${org.id}`}>
      <CentraleProvider value={props.centrale}>{body}</CentraleProvider>
    </RealtimeProvider>
  );
}

/**
 * Compteurs « Encaissements » (centrale) et « Réseau » / « Inscriptions » (candidatures, les deux modèles) : valeur
 * serveur, relue après chaque événement. `enabled` faux (Flotte Privée : ni candidatures ni encaissements) : aucune relecture.
 */
function useCentraleCounts(orgId: string, centrale: boolean, initial: CentraleCounts | null | undefined, enabled = true) {
  const [counts, setCounts] = useState<CentraleCounts>(initial ?? EMPTY_CENTRALE_COUNTS);
  useEffect(() => setCounts(initial ?? EMPTY_CENTRALE_COUNTS), [initial]);
  const timer = useRef<number | null>(null);
  const reload = () => {
    if (!enabled) return;
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

/** Compteurs des pastilles de la Flotte Privée (valeur serveur ; absente : 0). */
const privateFleetCounts = (p: PrivateFleetShell | null | undefined) => ({
  toTreat: p?.toTreat ?? 0,
  notConfirmed: p?.notConfirmed ?? 0,
  expiringDocuments: p?.expiringDocuments ?? 0,
});

/**
 * Flotte Privée : pastilles « à traiter » et « non confirmées » (réservations, une seule lecture) et « documents à
 * renouveler » — valeur serveur (layout), relue après chaque changement de course ou d'offre (rafales regroupées) et de
 * document. Inactif hors Flotte Privée.
 */
function usePrivateFleetCounts(orgId: string, initial: PrivateFleetShell | null | undefined) {
  const [counts, setCounts] = useState(() => privateFleetCounts(initial));
  useEffect(() => setCounts(privateFleetCounts(initial)), [initial]);
  const enabled = !!initial;
  const driverId = initial?.driverId ?? null;
  const rides = useRef<number | null>(null);
  const docs = useRef<number | null>(null);
  const reloadRides = () => {
    if (!enabled) return;
    if (rides.current) window.clearTimeout(rides.current);
    rides.current = window.setTimeout(() => {
      countQueue(getBrowserClient(), orgId, driverId)
        .then((q) => q !== null && setCounts((c) => ({ ...c, ...q })))
        .catch(() => undefined);
    }, 800);
  };
  const reloadDocuments = () => {
    if (!enabled) return;
    if (docs.current) window.clearTimeout(docs.current);
    docs.current = window.setTimeout(() => {
      countExpiringDocuments(getBrowserClient(), orgId)
        .then((n) => n !== null && setCounts((c) => ({ ...c, expiringDocuments: n })))
        .catch(() => undefined);
    }, 600);
  };
  useRealtimeEvent("ride.updated", reloadRides);
  useRealtimeEvent("offer.updated", reloadRides);
  useRealtimeEvent("driver.document", reloadDocuments);
  return counts;
}

/** Événements « platform.updated » qui changent le layout (entrée « Frais Rydar », bandeau, menus du modèle). */
const LAYOUT_PLATFORM_ACTIONS = new Set<string>(["rates", "model", "rates_scheduled", "rates_cancelled"]);

function ShellBody({
  children, org, orgs, user, alerts, pendingDocuments: pendingInitial, centrale, centraleCounts, topBanner, superAdmin, bookingSites, rydarFees,
  sharedNetwork, privateFleet,
}: ShellProps) {
  const router = useRouter();
  const [, start] = useTransition();
  const { unread, openReports } = useChatUnread();
  const isCentrale = centrale.model === "centrale";
  const counts = useCentraleCounts(org.id, isCentrale, centraleCounts, !privateFleet);
  const privateCounts = usePrivateFleetCounts(org.id, privateFleet);
  const networkNav = networkNavItem(useNetworkNav(org.id, sharedNetwork));
  const isAdmin = org.role === "owner" || org.role === "admin";
  // Frais dus à Rydar : centrale → carte d'« Encaissements » ; flotte avec des frais → entrée « Frais Rydar »
  const feePaths = platformFeesPaths(centrale.model);
  const fleetFees = !isCentrale && isAdmin && !!rydarFees;
  // Frais par course changés (« rates »), hausse annoncée ou annulée (« rates_scheduled » / « rates_cancelled » : une
  // flotte à 0 € voit ou perd l'entrée « Frais Rydar »), modèle changé (« model ») : le layout relit l'entrée « Frais
  // Rydar », le bandeau et les menus du modèle, sans rechargement complet (événement rare, identifiants seulement),
  // différé tant que l'onglet est caché. Relu seulement après un tel événement (ni sondage ni reconnexion : les pages
  // ont leur propre relecture).
  const layoutPending = useRef(false);
  const { schedule: scheduleLayout } = useLiveSync(
    () => {
      if (!layoutPending.current) return;
      layoutPending.current = false;
      router.refresh();
    },
    { pollMs: 600_000, maxPollMs: 600_000, debounceMs: 800 },
  );
  useRealtimeEvent("platform.updated", (e: PlatformEvent) => {
    if (!e?.action || !LAYOUT_PLATFORM_ACTIONS.has(e.action) || (e.organization_id && e.organization_id !== org.id)) return;
    // Frais Rydar (entrée de menu, bandeau) : owner / admin seulement ; le modèle change aussi les menus d'un dispatcher
    if (!isAdmin && e.action !== "model") return;
    layoutPending.current = true;
    scheduleLayout();
  });
  // Documents à valider : valeur serveur, relue après chaque dépôt / validation / refus (un incrément local compterait
  // aussi les pièces des candidats, que la page Chauffeurs n'affiche pas) et quand une candidature est traitée
  const [pendingDocuments, setPendingDocuments] = useState(pendingInitial ?? 0);
  useEffect(() => setPendingDocuments(pendingInitial ?? 0), [pendingInitial]);
  const docsTimer = useRef<number | null>(null);
  const reloadPendingDocuments = () => {
    // Flotte Privée : pastille « documents à renouveler » (usePrivateFleetCounts) à la place
    if (privateFleet) return;
    if (docsTimer.current) window.clearTimeout(docsTimer.current);
    docsTimer.current = window.setTimeout(() => {
      countPendingDocuments(getBrowserClient(), org.id)
        .then((n) => n !== null && setPendingDocuments(n))
        .catch(() => undefined);
    }, 600);
  };
  useRealtimeEvent("driver.document", reloadPendingDocuments);
  useRealtimeEvent("driver.application", reloadPendingDocuments);
  // Centrale affichée → cookie rd_view : le serveur refuse toute action résolue vers une autre centrale (accès retiré
  // ou centrale archivée pendant la saisie). Avant les effets des écrans enfants (leurs requêtes partent avec la bonne valeur).
  useLayoutEffect(() => rememberViewedOrg(org.id), [org.id]);
  // Centrale changée dans un autre onglet (cookie commun) : les actions de cet onglet partiraient vers elle
  const [switchedTo, setSwitchedTo] = useState<string | null>(null);
  useEffect(() => {
    setSwitchedTo(null);
    return onOrgSwitch((id) => setSwitchedTo(id === org.id ? null : id));
  }, [org.id]);
  const sections = dashboardNav({
    privateFleet: !!privateFleet,
    model: centrale.model,
    role: org.role,
    counts: {
      alerts,
      unread,
      openReports,
      pendingDocuments,
      applications: counts.applications,
      declared: counts.declared,
      overdue: counts.overdue,
      toTreat: privateCounts.toTreat,
      notConfirmed: privateCounts.notConfirmed,
      expiringDocuments: privateCounts.expiringDocuments,
    },
    flags: { bookingSites, rydarFees, superAdmin, networkNav },
  });
  return (
    <AlertsProvider key={org.id} scope={`${org.id}:${user.email}`} privateFleet={!!privateFleet}>
      {/* Premier élément au clavier : saute la barre latérale */}
      <SkipToContent />
      <Sidebar
        headerAction={<AlertsBell />}
        sections={sections}
        subtitle={privateFleet ? "Flotte Privée" : "Dispatch"}
        orgCaption={sidebarOrgCaption(!!privateFleet)}
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
          <OrgPlatformBanner orgId={org.id} timeZone={centrale.timeZone} enabled={isAdmin && (isCentrale || fleetFees)} paths={feePaths} floating={!topBanner} />
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
