import type { OrgPlatformAccount } from "@rydar/shared";
import { ArrowLeftRight, ChevronRight, PauseCircle } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { StatusScreen } from "@/components/auth/status-screen";
import { NETWORK_SUSPENDED_PATH } from "@/components/network-share/paths";
import { hasOpenNetworkSettlements, openNetworkSummaryText } from "@/components/network-share/suspended";
import { getPayerContext } from "@/components/platform-fees/org-payer-context";
import { OrgSuspendedDues } from "@/components/platform-fees/org-suspended-dues";
import { Button } from "@/components/ui/button";
import { networkSummary } from "@/lib/shared-network";
import { signOut } from "@/app/login/actions";
import { SwitchOrganization } from "./switch-organization";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Compte suspendu" };

export default async function SuspendedPage() {
  // Centrale suspendue qui doit des frais plateforme : montant et « J'ai payé » (owner / admin seulement)
  const ctx = await getPayerContext();
  let platform: Extract<OrgPlatformAccount, { enabled: true }> | null = null;
  // Réseau partagé (C12) : courses confiées à des chauffeurs partenaires dont les règlements restent dus / attendus
  let network: { text: string } | null = null;
  if (ctx && ctx.org.status === "suspended" && ctx.canPay) {
    const [{ data }, summary] = await Promise.all([
      ctx.supabase.rpc("org_platform_account", { p_org: ctx.org.id }),
      // Réseau ouvert, ou fermé par Rydar avec des sommes en cours (NETWORK_CLOSED_RPCS) : la carte n'apparaît que
      // s'il reste quelque chose à régler ; organisation jamais membre ou lecture refusée : rien
      networkSummary(ctx.supabase, ctx.org.id),
    ]);
    const acc = (data ?? null) as OrgPlatformAccount | null;
    if (acc?.enabled && (acc.account.balance_cents > 0 || acc.account.declared_count > 0)) platform = acc;
    if (summary && hasOpenNetworkSettlements(summary.given)) network = { text: openNetworkSummaryText(summary.given, summary.currency || "EUR") };
  }
  // Membre de plusieurs centrales : les autres, actives, restent accessibles
  const others = (ctx?.memberships ?? []).filter((m) => m.org.status === "active" && m.org.id !== ctx?.org.id).map((m) => ({ id: m.org.id, name: m.org.name }));
  return (
    <StatusScreen icon={<PauseCircle />} title="Compte suspendu" actions={<form action={signOut}><Button variant="secondary" type="submit">Se déconnecter</Button></form>}>
      L&apos;accès de votre centrale à Rydar Drive est temporairement suspendu. Contactez l&apos;équipe Rydar pour le réactiver.
      {platform && <OrgSuspendedDues data={platform} serverNow={Date.now()} />}
      {network && (
        <Link
          href={NETWORK_SUSPENDED_PATH}
          prefetch={false}
          className="surface mt-4 flex items-center gap-3 rounded-2xl px-5 py-4 text-left transition-colors hover:border-line-strong"
        >
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-violet/[0.1] text-violet">
            <ArrowLeftRight className="size-[18px]" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[14px] font-medium text-fg">Réseau partagé : règlements en cours</span>
            <span className="block text-[12.5px] text-fg-muted">{network.text}</span>
          </span>
          <ChevronRight className="size-4 shrink-0 text-fg-subtle" />
        </Link>
      )}
      {others.length > 0 && <SwitchOrganization orgs={others} />}
    </StatusScreen>
  );
}
