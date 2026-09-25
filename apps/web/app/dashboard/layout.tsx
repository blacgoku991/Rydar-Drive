import type { SettlementMethod } from "@rydar/shared";
import { DashboardShell } from "@/components/shell/dashboard-shell";
import { fetchCentraleCounts } from "@/components/settlements/counts";
import { requireOrg } from "@/lib/auth";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireOrg();
  const centrale = ctx.org.dispatch_model === "centrale";
  const [{ count }, { data: chat }, { count: pendingDocs }, centraleCounts, centraleSettings] = await Promise.all([
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
    // Mode centrale : « Encaissements » (à confirmer + en retard) et « Réseau » (candidatures en attente)
    centrale ? fetchCentraleCounts(ctx.supabase, ctx.org.id) : Promise.resolve(null),
    // Mode centrale : lien de paiement et instructions (réclamations WhatsApp depuis les alertes et les fiches)
    centrale
      ? ctx.supabase
          .from("organization_settings")
          .select("settlement_link, settlement_instructions, settlement_methods, block_unpaid")
          .eq("organization_id", ctx.org.id)
          .maybeSingle()
      : Promise.resolve(null),
  ]);
  const cs = (centraleSettings?.data ?? null) as {
    settlement_link: string | null;
    settlement_instructions: string | null;
    settlement_methods: SettlementMethod[] | null;
    block_unpaid: boolean | null;
  } | null;
  return (
    <DashboardShell
      org={{ id: ctx.org.id, name: ctx.org.name, role: ctx.role }}
      orgs={ctx.memberships.map((m) => ({ id: m.org.id, name: m.org.name, role: m.role }))}
      user={{ id: ctx.user.id, name: ctx.profile.full_name ?? ctx.profile.email, email: ctx.profile.email }}
      alerts={count ?? 0}
      unreadMessages={Number((chat as { unread_total?: number } | null)?.unread_total ?? 0)}
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
        blockUnpaid: cs?.block_unpaid ?? true,
      }}
      centraleCounts={centraleCounts}
    >
      {children}
    </DashboardShell>
  );
}
