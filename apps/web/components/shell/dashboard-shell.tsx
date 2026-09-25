"use client";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { AlertsBell, AlertsProvider } from "@/components/alerts/dispatch-alerts";
import { RealtimeProvider } from "@/components/realtime/realtime-provider";
import { Sidebar, type NavSection } from "@/components/shell/sidebar";
import { signOut } from "@/app/login/actions";
import { switchOrganization } from "@/app/dashboard/actions";

export function DashboardShell({
  children,
  org,
  orgs,
  user,
  alerts,
}: {
  children: React.ReactNode;
  org: { id: string; name: string; role: string };
  orgs: { id: string; name: string; role: string }[];
  user: { name: string; email: string };
  alerts?: number;
}) {
  const router = useRouter();
  const [, start] = useTransition();
  const sections: NavSection[] = [
    {
      title: "Opérations",
      items: [
        { href: "/dashboard", label: "En direct", icon: "radar", exact: true },
        { href: "/dashboard/rides", label: "Courses", icon: "route", badge: alerts },
        { href: "/dashboard/drivers", label: "Chauffeurs", icon: "users" },
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
    <RealtimeProvider topic={`org:${org.id}`}>
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
    </RealtimeProvider>
  );
}
