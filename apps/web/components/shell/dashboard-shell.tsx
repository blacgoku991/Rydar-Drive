"use client";
import type { DriverDocumentEvent } from "@rydar/shared";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { AlertsBell, AlertsProvider } from "@/components/alerts/dispatch-alerts";
import { ChatUnreadProvider, useChatUnread } from "@/components/chat/unread-provider";
import { RealtimeProvider, useRealtimeEvent } from "@/components/realtime/realtime-provider";
import { CentraleProvider, type CentraleInfo } from "@/components/settlements/centrale-context";
import { EMPTY_CENTRALE_COUNTS, fetchCentraleCounts, type CentraleCounts } from "@/components/settlements/counts";
import { Sidebar, type NavSection } from "@/components/shell/sidebar";
import { signOut } from "@/app/login/actions";
import { switchOrganization } from "@/app/dashboard/actions";
import { getBrowserClient } from "@/lib/supabase/client";

type ShellProps = {
  children: React.ReactNode;
  org: { id: string; name: string; role: string };
  orgs: { id: string; name: string; role: string }[];
  user: { id: string; name: string; email: string };
  alerts?: number;
  /** Messages non lus (chat_overview.unread_total) au chargement */
  unreadMessages?: number;
  /** Documents chauffeur déposés, en attente de validation */
  pendingDocuments?: number;
  /** Modèle d'exploitation + réglages d'encaissement (mode centrale) */
  centrale: CentraleInfo;
  /** Mode centrale : règlements à confirmer / en retard, candidatures en attente (null en mode flotte) */
  centraleCounts?: CentraleCounts | null;
};

export function DashboardShell(props: ShellProps) {
  const { org, user } = props;
  return (
    <RealtimeProvider topic={`org:${org.id}`}>
      <CentraleProvider value={props.centrale}>
        <ChatUnreadProvider key={org.id} initial={props.unreadMessages ?? 0} userId={user.id}>
          <ShellBody {...props} />
        </ChatUnreadProvider>
      </CentraleProvider>
    </RealtimeProvider>
  );
}

/** Compteurs « Encaissements » / « Réseau » : valeur serveur, relue après chaque événement du mode centrale. */
function useCentraleCounts(orgId: string, enabled: boolean, initial: CentraleCounts | null | undefined) {
  const [counts, setCounts] = useState<CentraleCounts>(initial ?? EMPTY_CENTRALE_COUNTS);
  useEffect(() => setCounts(initial ?? EMPTY_CENTRALE_COUNTS), [initial]);
  const timer = useRef<number | null>(null);
  const reload = () => {
    if (!enabled) return;
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      fetchCentraleCounts(getBrowserClient(), orgId)
        .then(setCounts)
        .catch(() => undefined);
    }, 600);
  };
  useRealtimeEvent("settlement.updated", reload);
  useRealtimeEvent("driver.application", reload);
  // Une commission devient « en retard » à son échéance, sans événement : relecture régulière
  useEffect(() => {
    if (!enabled) return;
    const id = window.setInterval(reload, 120_000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, orgId]);
  return counts;
}

const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;

function ShellBody({ children, org, orgs, user, alerts, pendingDocuments: pendingInitial, centrale, centraleCounts }: ShellProps) {
  const router = useRouter();
  const [, start] = useTransition();
  const { unread } = useChatUnread();
  const isCentrale = centrale.model === "centrale";
  const counts = useCentraleCounts(org.id, isCentrale, centraleCounts);
  // Documents à valider : valeur serveur, ajustée en temps réel (dépôt / validation / refus)
  const [pendingDocuments, setPendingDocuments] = useState(pendingInitial ?? 0);
  useEffect(() => setPendingDocuments(pendingInitial ?? 0), [pendingInitial]);
  useRealtimeEvent("driver.document", (e: DriverDocumentEvent) => {
    if (e?.action === "submitted") setPendingDocuments((n) => Math.max(0, n + 1 - (e.replaced_ids?.length ?? 0)));
    else if (e?.action === "validated" || e?.action === "rejected") setPendingDocuments((n) => Math.max(0, n - 1));
  });
  const toSettle = counts.declared + counts.overdue;
  const settlementsLabel = [
    counts.declared ? plural(counts.declared, "paiement à confirmer", "paiements à confirmer") : null,
    counts.overdue ? plural(counts.overdue, "commission en retard", "commissions en retard") : null,
  ].filter(Boolean).join(" · ");
  const sections: NavSection[] = [
    {
      title: "Opérations",
      items: [
        { href: "/dashboard", label: "En direct", icon: "radar", exact: true },
        {
          href: "/dashboard/messages",
          label: "Messages",
          icon: "message",
          badge: unread,
          badgeTone: "brand",
          badgeLabel: `${unread} message${unread > 1 ? "s" : ""} non lu${unread > 1 ? "s" : ""}`,
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
        {
          href: "/dashboard/drivers",
          label: "Chauffeurs",
          icon: "users",
          badge: pendingDocuments,
          badgeTone: "amber",
          badgeLabel: `${pendingDocuments} document${pendingDocuments > 1 ? "s" : ""} à valider`,
        },
        ...(isCentrale
          ? [
              {
                href: "/dashboard/network",
                label: "Réseau",
                icon: "network" as const,
                badge: counts.applications,
                badgeTone: "brand" as const,
                badgeLabel: plural(counts.applications, "candidature en attente", "candidatures en attente"),
              },
            ]
          : []),
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
  ];
  return (
    <AlertsProvider key={org.id} scope={`${org.id}:${user.email}`}>
      <Sidebar
        headerAction={<AlertsBell />}
        sections={sections}
        subtitle="Dispatch"
        user={user}
        orgs={orgs}
        currentOrgId={org.id}
        onSwitchOrg={(id) =>
          start(async () => {
            await switchOrganization(id);
            router.refresh();
          })
        }
        signOut={() => start(() => signOut())}
      />
      <div className="lg:pl-[232px]">{children}</div>
    </AlertsProvider>
  );
}
