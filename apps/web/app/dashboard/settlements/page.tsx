import { DISPATCH_MODEL_META, type OrgSettlementFilter, type OrgSettlementOverview, type OrgSettlements } from "@rydar/shared";
import { HandCoins, Settings2 } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { PageBody, PageHeader } from "@/components/layout/page-header";
import { SettlementsView } from "@/components/settlements/settlements-view";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/misc";
import { isAdminRole, requireOrg } from "@/lib/auth";

export const metadata: Metadata = { title: "Encaissements" };
export const dynamic = "force-dynamic";

const FILTERS: OrgSettlementFilter[] = ["open", "declared", "overdue", "disputed", "to_pay", "paid", "waived", "all"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Encaissements (mode centrale) — contrat d'URL :
 *   ?filter=open|declared|overdue|disputed|to_pay|paid|waived|all  (défaut : open, « À traiter »)
 *   &driver=<driver_id>  (règlements d'un chauffeur)   &n=<100..500>  (taille de la liste)
 */
export default async function SettlementsPage({ searchParams }: { searchParams: Promise<{ filter?: string; driver?: string; n?: string }> }) {
  const ctx = await requireOrg();
  const sp = await searchParams;

  if (ctx.org.dispatch_model !== "centrale") {
    return (
      <>
        <PageHeader eyebrow="Opérations" title="Encaissements" />
        <PageBody>
          <Card>
            <EmptyState
              icon={<HandCoins />}
              title="Réservé au mode centrale"
              description={`Votre compte fonctionne en ${DISPATCH_MODEL_META.fleet.short.toLowerCase()} : vos chauffeurs font partie de votre société, il n'y a pas de commission à encaisser. Le mode « ${DISPATCH_MODEL_META.centrale.label} » est activé par l'équipe Rydar.`}
            />
          </Card>
        </PageBody>
      </>
    );
  }

  const filter: OrgSettlementFilter = FILTERS.includes(sp.filter as OrgSettlementFilter) ? (sp.filter as OrgSettlementFilter) : "open";
  const driver = sp.driver && UUID.test(sp.driver) ? sp.driver : null;
  const limit = Math.min(500, Math.max(100, Math.round(Number(sp.n) || 100)));
  const orgId = ctx.org.id;

  // « À traiter » (tous chauffeurs) sert aussi aux soldes, compteurs et messages WhatsApp : lu une fois
  const [overview, open, filtered] = await Promise.all([
    ctx.supabase.rpc("org_settlement_overview", { p_org: orgId }),
    ctx.supabase.rpc("org_settlements", { p_org: orgId, p_filter: "open", p_driver: null, p_limit: 500, p_before: null }),
    filter === "open" && !driver
      ? Promise.resolve(null)
      : ctx.supabase.rpc("org_settlements", { p_org: orgId, p_filter: filter, p_driver: driver, p_limit: limit, p_before: null }),
  ]);
  const openItems = ((open.data as OrgSettlements | null)?.items ?? []);
  const items = filtered ? ((filtered.data as OrgSettlements | null)?.items ?? []) : openItems;
  const failed = overview.error || open.error || filtered?.error;

  return (
    <>
      <PageHeader
        eyebrow="Centrale"
        title="Encaissements"
        description="Commissions à encaisser auprès des chauffeurs, parts à leur verser : confirmez les paiements, relancez les retardataires, réclamez en un clic."
        actions={
          isAdminRole(ctx.role) ? (
            <Button asChild variant="outline">
              <Link href="/dashboard/settings?tab=centrale">
                <Settings2 /> Commission & encaissement
              </Link>
            </Button>
          ) : undefined
        }
      />
      <PageBody>
        {failed ? (
          <Card>
            <EmptyState icon={<HandCoins />} title="Encaissements indisponibles" description="La lecture des règlements a échoué. Réessayez dans un instant." />
          </Card>
        ) : (
          <SettlementsView
            key={`${filter}:${driver ?? ""}`}
            overview={overview.data as OrgSettlementOverview}
            openItems={openItems}
            items={items}
            filter={filter}
            driverId={driver}
            limit={filter === "open" && !driver ? 500 : limit}
            orgName={ctx.org.name}
            timeZone={ctx.org.timezone || "Europe/Paris"}
            canManage={isAdminRole(ctx.role)}
            serverNow={Date.now()}
          />
        )}
      </PageBody>
    </>
  );
}
