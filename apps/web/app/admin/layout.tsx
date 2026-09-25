import { AdminShell } from "@/components/shell/admin-shell";
import { requireSuperAdmin } from "@/lib/auth";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSuperAdmin();
  // Pastille « Centrales » : signalements de fraude à examiner (lecture super admin via RLS)
  const { count } = await session.supabase.from("fraud_reports").select("id", { count: "exact", head: true }).eq("status", "open");
  return (
    <AdminShell user={{ name: session.profile.full_name ?? "Super admin", email: session.profile.email }} openReports={count ?? 0}>
      {children}
    </AdminShell>
  );
}
