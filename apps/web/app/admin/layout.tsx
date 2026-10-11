import { tourSavedFrom } from "@rydar/shared";
import { adminNavCounts } from "@/components/admin/admin-todo";
import { getAdminTodo } from "@/components/admin/platform-data";
import { AdminShell } from "@/components/shell/admin-shell";
import { requireSuperAdmin } from "@/lib/auth";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSuperAdmin();
  // Pastilles du menu (libellés : adminNav de components/shell/admin-shell.tsx) : mêmes compteurs que « À traiter » de
  // la vue d'ensemble, une seule lecture par rendu (getAdminTodo, sous cache() de React). Lecture impossible : pas de
  // pastille (la vue d'ensemble affiche « Lecture impossible »).
  // Visite guidée (docs/TUTORIEL.md § 4.2) : progression du parcours « super_admin », en parallèle (RLS : ses seules lignes)
  const [todo, tourRow] = await Promise.all([
    getAdminTodo(session.supabase),
    session.supabase.from("user_tours").select("status, step, shown_at").eq("user_id", session.user.id).eq("tour", "super_admin").maybeSingle(),
  ]);
  const counts = adminNavCounts(todo);
  return (
    <AdminShell
      user={{ name: session.profile.full_name ?? "Super admin", email: session.profile.email }}
      {...counts}
      centraleName={session.memberships.length === 1 ? session.memberships[0]!.org.name : session.memberships.length > 1 ? "Mes centrales" : null}
      // Pas d'ouverture d'office tant qu'un signalement de fraude ou une suppression de compte attend (pastilles rouges)
      tour={{
        key: "super_admin",
        saved: tourSavedFrom(tourRow.data, tourRow.error),
        blocked: false,
        urgent: counts.openReports > 0 || counts.deletionsToReview > 0,
        scope: { userId: session.user.id, orgId: null, driverId: null },
      }}
    >
      {children}
    </AdminShell>
  );
}
