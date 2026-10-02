import type { SettlementMethod } from "@rydar/shared";
import { DashboardShell } from "@/components/shell/dashboard-shell";
import { fetchCentraleCounts } from "@/components/settlements/counts";
import { TermsBanner, UserTermsBanner } from "@/components/legal/terms-banner";
import { isAdminRole, requireOrg } from "@/lib/auth";
import { bookingSitesEnabled } from "@/lib/booking-sites";
import { LEGAL_VERSION } from "@/lib/legal";
import { countPendingDocuments } from "@/lib/queries/pending-documents";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireOrg();
  const centrale = ctx.org.dispatch_model === "centrale";
  const admin = isAdminRole(ctx.role);
  const [{ count }, { data: chat }, pendingDocs, centraleCounts, centraleSettings, terms, userTerms, bookingSites, fleetFees] = await Promise.all([
    ctx.supabase
      .from("rides")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", ctx.org.id)
      .eq("status", "NO_DRIVER_FOUND")
      .gte("pickup_at", new Date(Date.now() - 6 * 3600_000).toISOString()),
    // Compteur « Messages » : non-lus de l'utilisateur connecté, tous fils confondus, et messages signalés à traiter
    ctx.supabase.rpc("chat_overview", { p_org: ctx.org.id }),
    // Compteur « Chauffeurs » : documents déposés à valider (candidats exclus, comme la page Chauffeurs)
    countPendingDocuments(ctx.supabase, ctx.org.id),
    // « Réseau » (centrale) / « Inscriptions » (flotte) : candidatures en attente ; mode centrale : « Encaissements »
    // (à confirmer + en retard)
    fetchCentraleCounts(ctx.supabase, ctx.org.id, { settlements: centrale }),
    // Mode centrale : lien de paiement et instructions (réclamations WhatsApp depuis les alertes et les fiches)
    centrale
      ? ctx.supabase
          .from("organization_settings")
          .select("settlement_link, settlement_instructions, settlement_methods, settlement_payee_name, settlement_iban, settlement_bic, block_unpaid")
          .eq("organization_id", ctx.org.id)
          .maybeSingle()
      : Promise.resolve(null),
    // CGV + accord de traitement acceptés pour la version en vigueur ? (owner / admin)
    admin
      ? ctx.supabase
          .from("legal_acceptances")
          .select("id", { count: "exact", head: true })
          .eq("organization_id", ctx.org.id)
          .eq("document", "dpa")
          .eq("version", LEGAL_VERSION)
      : Promise.resolve(null),
    // CGU + politique de confidentialité acceptées à titre personnel (tout membre, dispatcher compris) : ses propres
    // lignes (RLS), quelle que soit la centrale au nom de laquelle il les a acceptées
    ctx.supabase
      .from("legal_acceptances")
      .select("document")
      .eq("user_id", ctx.user.id)
      .eq("version", LEGAL_VERSION)
      .in("document", ["cgu", "privacy"]),
    // Menu « Mini-site » : masqué tant que les mini-sites sont coupés par la plateforme (super admin)
    bookingSitesEnabled(),
    // Flotte : frais Rydar par course réglés par le super admin (ou historique) → entrée « Frais Rydar » (owner / admin).
    // Le seul booléen (org_platform_fees_enabled) : le compte complet n'est calculé que par le bandeau et la page
    !centrale && admin ? ctx.supabase.rpc("org_platform_fees_enabled", { p_org: ctx.org.id }) : Promise.resolve(null),
  ]);
  // Un seul bandeau à la fois : celui de la centrale (owner / admin, CGU et politique comprises) d'abord
  const orgTermsDue = admin && !!terms && !terms.error && (terms.count ?? 0) === 0;
  const accepted = new Set(((userTerms.data ?? []) as { document: string }[]).map((a) => a.document));
  const userTermsDue = !userTerms.error && !(accepted.has("cgu") && accepted.has("privacy"));
  const cs = (centraleSettings?.data ?? null) as {
    settlement_link: string | null;
    settlement_instructions: string | null;
    settlement_methods: SettlementMethod[] | null;
    settlement_payee_name: string | null;
    settlement_iban: string | null;
    settlement_bic: string | null;
    block_unpaid: boolean | null;
  } | null;
  return (
    <DashboardShell
      org={{ id: ctx.org.id, name: ctx.org.name, role: ctx.role }}
      orgs={ctx.memberships.map((m) => ({ id: m.org.id, name: m.org.name, role: m.role }))}
      user={{ id: ctx.user.id, name: ctx.profile.full_name ?? ctx.profile.email, email: ctx.profile.email }}
      alerts={count ?? 0}
      unreadMessages={Number((chat as { unread_total?: number } | null)?.unread_total ?? 0)}
      openReports={Number((chat as { open_reports?: number } | null)?.open_reports ?? 0)}
      pendingDocuments={pendingDocs ?? 0}
      centrale={{
        model: ctx.org.dispatch_model ?? "fleet",
        orgId: ctx.org.id,
        orgName: ctx.org.name,
        timeZone: ctx.org.timezone || "Europe/Paris",
        role: ctx.role,
        link: cs?.settlement_link ?? null,
        instructions: cs?.settlement_instructions ?? null,
        methods: cs?.settlement_methods ?? [],
        bank: cs?.settlement_iban ? { payeeName: cs.settlement_payee_name || ctx.org.name, iban: cs.settlement_iban, bic: cs.settlement_bic } : null,
        blockUnpaid: cs?.block_unpaid ?? true,
      }}
      centraleCounts={centraleCounts}
      topBanner={orgTermsDue ? <TermsBanner orgName={ctx.org.name} /> : userTermsDue ? <UserTermsBanner /> : null}
      superAdmin={ctx.profile.is_super_admin === true}
      bookingSites={bookingSites}
      rydarFees={fleetFees?.data === true}
    >
      {children}
    </DashboardShell>
  );
}
