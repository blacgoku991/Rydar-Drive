import { AdminShell } from "@/components/shell/admin-shell";
import { requireSuperAdmin } from "@/lib/auth";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSuperAdmin();
  // Pastilles (lecture super admin via RLS) : signalements de fraude à examiner ; frais plateforme à confirmer
  const [reports, payments, reductions] = await Promise.all([
    session.supabase.from("fraud_reports").select("id", { count: "exact", head: true }).eq("status", "open"),
    session.supabase.from("platform_payments").select("id", { count: "exact", head: true }).eq("status", "declared"),
    session.supabase.from("platform_fee_entries").select("id", { count: "exact", head: true }).eq("status", "pending"),
  ]);
  return (
    <AdminShell
      user={{ name: session.profile.full_name ?? "Super admin", email: session.profile.email }}
      openReports={reports.count ?? 0}
      platformToReview={(payments.count ?? 0) + (reductions.count ?? 0)}
    >
      {children}
    </AdminShell>
  );
}
