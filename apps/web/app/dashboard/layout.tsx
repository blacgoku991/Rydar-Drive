import { DashboardShell } from "@/components/shell/dashboard-shell";
import { requireOrg } from "@/lib/auth";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireOrg();
  const [{ count }, { data: chat }, { count: pendingDocs }] = await Promise.all([
    ctx.supabase
      .from("rides")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", ctx.org.id)
      .eq("status", "NO_DRIVER_FOUND")
      .gte("pickup_at", new Date(Date.now() - 6 * 3600_000).toISOString()),
    // Compteur « Messages » : non-lus de l'utilisateur connecté, tous fils confondus
    ctx.supabase.rpc("chat_overview", { p_org: ctx.org.id }),
    // Compteur « Chauffeurs » : documents déposés à valider
    ctx.supabase
      .from("driver_documents")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", ctx.org.id)
      .eq("status", "pending"),
  ]);
  return (
    <DashboardShell
      org={{ id: ctx.org.id, name: ctx.org.name, role: ctx.role }}
      orgs={ctx.memberships.map((m) => ({ id: m.org.id, name: m.org.name, role: m.role }))}
      user={{ id: ctx.user.id, name: ctx.profile.full_name ?? ctx.profile.email, email: ctx.profile.email }}
      alerts={count ?? 0}
      unreadMessages={Number((chat as { unread_total?: number } | null)?.unread_total ?? 0)}
      pendingDocuments={pendingDocs ?? 0}
    >
      {children}
    </DashboardShell>
  );
}
