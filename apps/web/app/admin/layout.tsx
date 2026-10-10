import { adminNavCounts } from "@/components/admin/admin-todo";
import { getAdminTodo } from "@/components/admin/platform-data";
import { AdminShell } from "@/components/shell/admin-shell";
import { requireSuperAdmin } from "@/lib/auth";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSuperAdmin();
  // Pastilles du menu (libellés : adminNav de components/shell/admin-shell.tsx) : mêmes compteurs que « À traiter » de
  // la vue d'ensemble, une seule lecture par rendu (getAdminTodo, sous cache() de React). Lecture impossible : pas de
  // pastille (la vue d'ensemble affiche « Lecture impossible »).
  const counts = adminNavCounts(await getAdminTodo(session.supabase));
  return (
    <AdminShell
      user={{ name: session.profile.full_name ?? "Super admin", email: session.profile.email }}
      {...counts}
      centraleName={session.memberships.length === 1 ? session.memberships[0]!.org.name : session.memberships.length > 1 ? "Mes centrales" : null}
    >
      {children}
    </AdminShell>
  );
}
