import { AdminShell } from "@/components/shell/admin-shell";
import { requireSuperAdmin } from "@/lib/auth";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSuperAdmin();
  // Pastilles (lecture super admin via RLS) : signalements de fraude à examiner ; frais plateforme à confirmer ;
  // suppressions de compte en échec ou en retard (compteurs de admin_account_deletions, une seule ligne lue)
  const [reports, payments, reductions, deletions] = await Promise.all([
    session.supabase.from("fraud_reports").select("id", { count: "exact", head: true }).eq("status", "open"),
    session.supabase.from("platform_payments").select("id", { count: "exact", head: true }).eq("status", "declared"),
    session.supabase.from("platform_fee_entries").select("id", { count: "exact", head: true }).eq("status", "pending"),
    session.supabase.rpc("admin_account_deletions", { p_limit: 1 }),
  ]);
  const d = (deletions.error ? null : deletions.data) as { failed?: number; stalled?: number } | null;
  return (
    <AdminShell
      user={{ name: session.profile.full_name ?? "Super admin", email: session.profile.email }}
      openReports={reports.count ?? 0}
      platformToReview={(payments.count ?? 0) + (reductions.count ?? 0)}
      deletionsToReview={Number(d?.failed ?? 0) + Number(d?.stalled ?? 0)}
    >
      {children}
    </AdminShell>
  );
}
