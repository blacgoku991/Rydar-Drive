import type { OrgPlatformAccount } from "@rydar/shared";
import { PauseCircle } from "lucide-react";
import { StatusScreen } from "@/components/auth/status-screen";
import { getPayerContext } from "@/components/platform-fees/org-payer-context";
import { OrgSuspendedDues } from "@/components/platform-fees/org-suspended-dues";
import { Button } from "@/components/ui/button";
import { signOut } from "@/app/login/actions";
import { SwitchOrganization } from "./switch-organization";

export const dynamic = "force-dynamic";

export default async function SuspendedPage() {
  // Centrale suspendue qui doit des frais plateforme : montant et « J'ai payé » (owner / admin seulement)
  const ctx = await getPayerContext();
  let platform: Extract<OrgPlatformAccount, { enabled: true }> | null = null;
  if (ctx && ctx.org.status === "suspended" && ctx.canPay) {
    const { data } = await ctx.supabase.rpc("org_platform_account", { p_org: ctx.org.id });
    const acc = (data ?? null) as OrgPlatformAccount | null;
    if (acc?.enabled && (acc.account.balance_cents > 0 || acc.account.declared_count > 0)) platform = acc;
  }
  // Membre de plusieurs centrales : les autres, actives, restent accessibles
  const others = (ctx?.memberships ?? []).filter((m) => m.org.status === "active" && m.org.id !== ctx?.org.id).map((m) => ({ id: m.org.id, name: m.org.name }));
  return (
    <StatusScreen icon={<PauseCircle />} title="Compte suspendu" actions={<form action={signOut}><Button variant="secondary" type="submit">Se déconnecter</Button></form>}>
      L&apos;accès de votre centrale à Rydar Drive est temporairement suspendu. Contactez l&apos;équipe Rydar pour le réactiver.
      {platform && <OrgSuspendedDues data={platform} serverNow={Date.now()} />}
      {others.length > 0 && <SwitchOrganization orgs={others} />}
    </StatusScreen>
  );
}
