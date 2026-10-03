import type { NetworkPartnerNames, OrgNetworkGiven } from "@rydar/shared";
import { ArrowLeft, ArrowLeftRight, CircleAlert } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Logo } from "@/components/brand/logo";
import { GivenView } from "@/components/network-share/given-view";
import { NETWORK_LIST_MAX, parseNetworkShareParams, recentMonths, type NetworkShareSearchParams } from "@/components/network-share/paths";
import { getPayerContext } from "@/components/platform-fees/org-payer-context";
import { networkSummary, sharedNetworkEnabled } from "@/lib/shared-network";

export const metadata: Metadata = { title: "Réseau partagé — règlements en cours" };
export const dynamic = "force-dynamic";

/**
 * Organisation SUSPENDUE qui a confié des courses à des chauffeurs partenaires (spec C12, §10.5) : ses règlements
 * réseau restent dus et attendus. Owner / admin seulement : Reçu, Pas reçu, Versé (RIB), Valider, Contester, Rouvrir
 * (assert_network_creditor accepte une organisation suspendue). Ni relance, ni exclusion, ni export ; tableau de bord
 * fermé. Organisation active → onglet habituel ; réseau fermé par la plateforme → 404.
 */
export default async function SuspendedNetworkPage({ searchParams }: { searchParams: Promise<NetworkShareSearchParams> }) {
  const ctx = await getPayerContext();
  if (!ctx) redirect("/login");
  if (ctx.org.status !== "suspended") redirect("/dashboard/reseau-partage");
  if (!ctx.canPay) redirect("/suspended");
  if (!(await sharedNetworkEnabled())) notFound();

  const params = parseNetworkShareParams(await searchParams);
  const orgId = ctx.org.id;
  const tz = ctx.org.timezone || "Europe/Paris";
  const serverNow = Date.now();
  const [summary, given, partnersRes] = await Promise.all([
    networkSummary(ctx.supabase, orgId),
    ctx.supabase.rpc("org_network_given", {
      p_org: orgId, p_filter: params.given, p_partner: params.partner, p_month: params.month, p_limit: params.limit, p_before: null,
    }),
    ctx.supabase.rpc("network_partner_names", { p_org: orgId }),
  ]);
  const data = (given.error ? null : given.data) as OrgNetworkGiven | null;
  const items = data?.items ?? [];
  const partners = Object.entries((partnersRes.error ? {} : (partnersRes.data ?? {})) as NetworkPartnerNames)
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name, "fr"));

  return (
    <main className="min-h-dvh px-5 py-8 sm:px-8">
      <div className="mx-auto w-full max-w-[1200px]">
        <div className="mb-8 flex flex-wrap items-center justify-between gap-4">
          <Logo size={24} />
          <Link href="/suspended" prefetch={false} className="inline-flex items-center gap-1.5 text-[12.5px] text-fg-subtle hover:text-fg">
            <ArrowLeft className="size-3.5" /> Compte suspendu
          </Link>
        </div>
        <header className="mb-6">
          <p className="mb-1 flex items-center gap-1.5 text-[12.5px] text-violet">
            <ArrowLeftRight className="size-3.5" /> Réseau partagé
          </p>
          <h1 className="text-[24px] font-semibold tracking-tight">Règlements en cours avec les chauffeurs partenaires</h1>
          <p className="mt-1.5 max-w-2xl text-[14px] text-fg-muted">
            {ctx.org.name} est suspendue : plus aucune course n&apos;est proposée au réseau, mais les courses déjà acceptées vont à leur
            terme. Les sommes que les chauffeurs partenaires vous doivent restent dues, et celles que vous leur devez restent à verser.
          </p>
        </header>
        {!summary && (
          <p role="status" className="mb-4 flex items-center gap-2 rounded-lg border border-line bg-white/[0.02] px-4 py-2.5 text-[12.5px] text-fg-muted">
            <CircleAlert className="size-4 shrink-0 text-amber" /> Indicateurs momentanément indisponibles&nbsp;: réessayez dans un instant.
          </p>
        )}
        <GivenView
          summary={summary?.given ?? null}
          currency={summary?.currency || "EUR"}
          items={items}
          filter={params.given}
          partner={params.partner}
          month={params.month}
          limit={params.limit}
          hasMore={items.length >= params.limit && params.limit < NETWORK_LIST_MAX && data?.next_before !== null}
          partners={partners}
          excludedPartners={[]}
          months={recentMonths(new Date(serverNow), tz, 12)}
          canManage
          orgName={ctx.org.name}
          timeZone={tz}
          serverNow={serverNow}
          failed={!!given.error}
          suspended
        />
      </div>
    </main>
  );
}
