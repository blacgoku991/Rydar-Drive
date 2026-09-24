import { DashboardShell } from "@/components/shell/dashboard-shell";
import { requireOrg } from "@/lib/auth";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireOrg();
  const { count } = await ctx.supabase
    .from("rides")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", ctx.org.id)
    .eq("status", "NO_DRIVER_FOUND")
    .gte("pickup_at", new Date(Date.now() - 6 * 3600_000).toISOString());
  return (
    <DashboardShell
      org={{ id: ctx.org.id, name: ctx.org.name, role: ctx.role }}
      orgs={ctx.memberships.map((m) => ({ id: m.org.id, name: m.org.name, role: m.role }))}
      user={{ name: ctx.profile.full_name ?? ctx.profile.email, email: ctx.profile.email }}
      alerts={count ?? 0}
    >
      {children}
    </DashboardShell>
  );
}
