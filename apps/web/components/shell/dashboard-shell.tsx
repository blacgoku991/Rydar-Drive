"use client";
import type { DriverDocumentEvent } from "@rydar/shared";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { AlertsBell, AlertsProvider } from "@/components/alerts/dispatch-alerts";
import { ChatUnreadProvider, useChatUnread } from "@/components/chat/unread-provider";
import { RealtimeProvider, useRealtimeEvent } from "@/components/realtime/realtime-provider";
import { Sidebar, type NavSection } from "@/components/shell/sidebar";
import { signOut } from "@/app/login/actions";
import { switchOrganization } from "@/app/dashboard/actions";

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
};

export function DashboardShell(props: ShellProps) {
  const { org, user } = props;
  return (
    <RealtimeProvider topic={`org:${org.id}`}>
      <ChatUnreadProvider key={org.id} initial={props.unreadMessages ?? 0} userId={user.id}>
        <ShellBody {...props} />
      </ChatUnreadProvider>
    </RealtimeProvider>
  );
}

function ShellBody({ children, org, orgs, user, alerts, pendingDocuments: pendingInitial }: ShellProps) {
  const router = useRouter();
  const [, start] = useTransition();
  const { unread } = useChatUnread();
  // Documents à valider : valeur serveur, ajustée en temps réel (dépôt / validation / refus)
  const [pendingDocuments, setPendingDocuments] = useState(pendingInitial ?? 0);
  useEffect(() => setPendingDocuments(pendingInitial ?? 0), [pendingInitial]);
  useRealtimeEvent("driver.document", (e: DriverDocumentEvent) => {
    if (e?.action === "submitted") setPendingDocuments((n) => Math.max(0, n + 1 - (e.replaced_ids?.length ?? 0)));
    else if (e?.action === "validated" || e?.action === "rejected") setPendingDocuments((n) => Math.max(0, n - 1));
  });
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
        {
          href: "/dashboard/drivers",
          label: "Chauffeurs",
          icon: "users",
          badge: pendingDocuments,
          badgeTone: "amber",
          badgeLabel: `${pendingDocuments} document${pendingDocuments > 1 ? "s" : ""} à valider`,
        },
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
