"use client";
import { useTransition } from "react";
import { Sidebar, type NavSection } from "@/components/shell/sidebar";
import { signOut } from "@/app/login/actions";

export function AdminShell({ children, user }: { children: React.ReactNode; user: { name: string; email: string } }) {
  const [, start] = useTransition();
  const sections: NavSection[] = [
    {
      title: "Plateforme",
      items: [
        { href: "/admin", label: "Vue d'ensemble", icon: "dashboard", exact: true },
        { href: "/admin/organizations", label: "Rattacheurs", icon: "building" },
        { href: "/admin/plans", label: "Offres & limites", icon: "card" },
      ],
    },
    {
      title: "Supervision",
      items: [
        { href: "/admin/dispatch", label: "Dispatch & erreurs", icon: "radar" },
        { href: "/admin/notifications", label: "Notifications", icon: "sparkles" },
        { href: "/admin/audit", label: "Sécurité & audit", icon: "shield" },
      ],
    },
  ];
  return (
    <>
      <Sidebar
        sections={sections}
        subtitle="Super admin"
        user={user}
        signOut={() => start(() => signOut())}
        footer={
          <div className="rounded-xl border border-brand/20 bg-brand/[0.05] px-3 py-2.5 text-[12px] text-fg-muted">
            <span className="font-semibold text-brand">Mode plateforme</span> — accès en lecture à tous les tenants, écritures journalisées.
          </div>
        }
      />
      <div className="lg:pl-[248px]">{children}</div>
    </>
  );
}
