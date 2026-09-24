"use client";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { RealtimeProvider, useRealtimeStatus } from "@/components/realtime/realtime-provider";
import { Sidebar, type NavSection } from "@/components/shell/sidebar";
import { signOut } from "@/app/login/actions";
import { switchOrganization } from "@/app/dashboard/actions";

function LiveIndicator() {
  const status = useRealtimeStatus();
  const live = status === "live";
  return (
    <div className="flex items-center gap-2.5 rounded-xl border border-line bg-white/[0.02] px-3 py-2.5">
      <span className="relative grid size-2.5 place-items-center">
        <span className={live ? "absolute size-2.5 animate-ping rounded-full bg-brand/60" : "hidden"} />
        <span className={`size-2 rounded-full ${live ? "bg-brand" : status === "connecting" ? "bg-amber" : "bg-amber"}`} />
      </span>
      <span className="text-[12px] text-fg-muted">
        {live ? "Dispatch temps réel actif" : status === "connecting" ? "Connexion au temps réel…" : "Synchronisation périodique"}
      </span>
    </div>
  );
}

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
        { href: "/dashboard", label: "Command center", icon: "radar", exact: true },
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
      <Sidebar
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
        footer={<LiveIndicator />}
      />
      <div className="lg:pl-[248px]">{children}</div>
    </RealtimeProvider>
  );
}
