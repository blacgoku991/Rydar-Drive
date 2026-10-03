import { AdminShell } from "@/components/shell/admin-shell";
import { requireSuperAdmin } from "@/lib/auth";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSuperAdmin();
  // Pastilles (lecture super admin via RLS) : signalements de fraude à examiner ; frais plateforme à confirmer ;
  // suppressions de compte en échec ou en retard (compteurs de admin_account_deletions, une seule ligne lue) ;
  // nouvelles demandes du formulaire de contact ; réseau partagé : organisations à valider (demande ou validation
  // perdue, un sens toujours demandé)
  const [reports, payments, reductions, deletions, contacts, network] = await Promise.all([
    session.supabase.from("fraud_reports").select("id", { count: "exact", head: true }).eq("status", "open"),
    session.supabase.from("platform_payments").select("id", { count: "exact", head: true }).eq("status", "declared"),
    session.supabase.from("platform_fee_entries").select("id", { count: "exact", head: true }).eq("status", "pending"),
    session.supabase.rpc("admin_account_deletions", { p_limit: 1 }),
    session.supabase.from("contact_requests").select("id", { count: "exact", head: true }).eq("status", "new"),
    session.supabase
      .from("network_memberships")
      .select("organization_id", { count: "exact", head: true })
      .not("requested_at", "is", null)
      .is("approved_at", null)
      .is("refused_reason", null)
      .or("share_out.eq.true,share_in.eq.true"),
  ]);
  const d = (deletions.error ? null : deletions.data) as { failed?: number; stalled?: number } | null;
  return (
    <AdminShell
      user={{ name: session.profile.full_name ?? "Super admin", email: session.profile.email }}
      openReports={reports.count ?? 0}
      platformToReview={(payments.count ?? 0) + (reductions.count ?? 0)}
      deletionsToReview={Number(d?.failed ?? 0) + Number(d?.stalled ?? 0)}
      contactsToReview={contacts.count ?? 0}
      networkToReview={network.error ? 0 : (network.count ?? 0)}
      centraleName={session.memberships.length === 1 ? session.memberships[0]!.org.name : session.memberships.length > 1 ? "Mes centrales" : null}
    >
      {children}
    </AdminShell>
  );
}
