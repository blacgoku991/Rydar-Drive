import { DISPATCH_MODEL_META, type OrgPlatformAccount, type OrgSettlementFilter, type OrgSettlementOverview, type OrgSettlements } from "@rydar/shared";
import { HandCoins, Landmark, Settings2 } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { PageBody, PageHeader } from "@/components/layout/page-header";
import { OrgPlatformCard } from "@/components/platform-fees/org-platform-card";
import { platformFeesPaths } from "@/components/platform-fees/org-platform-paths";
import { SETTLEMENT_MAX, SETTLEMENT_PAGE, compactOpen, sortOpen } from "@/components/settlements/settlement-list";
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
              action={
                // Frais dus à Rydar par une flotte : page « Frais Rydar » (owner / admin)
                isAdminRole(ctx.role) ? (
                  <Button asChild variant="outline" size="sm">
                    <Link href={platformFeesPaths("fleet").page} prefetch={false}>
                      <Landmark /> Frais Rydar
                    </Link>
                  </Button>
                ) : undefined
              }
            />
          </Card>
        </PageBody>
      </>
    );
  }

  const filter: OrgSettlementFilter = FILTERS.includes(sp.filter as OrgSettlementFilter) ? (sp.filter as OrgSettlementFilter) : "open";
  const driver = sp.driver && UUID.test(sp.driver) ? sp.driver : null;
  const limit = Math.min(SETTLEMENT_MAX, Math.max(SETTLEMENT_PAGE, Math.round(Number(sp.n) || SETTLEMENT_PAGE)));
  const orgId = ctx.org.id;
  const canManage = isAdminRole(ctx.role);

  // « À traiter » (tous chauffeurs) sert aussi aux compteurs et messages WhatsApp : lu une fois (500 au plus), envoyé au
  // navigateur en version compacte ; seules les lignes affichées (100 par défaut, « Afficher plus ») sont complètes.
  // Frais plateforme dus à Rydar : owner / admin seulement (un dispatcher ne voit pas la carte).
  const [overview, open, filtered, platform] = await Promise.all([
    ctx.supabase.rpc("org_settlement_overview", { p_org: orgId }),
    ctx.supabase.rpc("org_settlements", { p_org: orgId, p_filter: "open", p_driver: null, p_limit: 500, p_before: null }),
    filter === "open" && !driver
      ? Promise.resolve(null)
      : ctx.supabase.rpc("org_settlements", { p_org: orgId, p_filter: filter, p_driver: driver, p_limit: limit, p_before: null }),
    canManage ? ctx.supabase.rpc("org_platform_account", { p_org: orgId }) : Promise.resolve(null),
  ]);
  const platformData = (platform?.data ?? null) as OrgPlatformAccount | null;
  const serverNow = Date.now();
  const openItems = ((open.data as OrgSettlements | null)?.items ?? []);
  // « À traiter » : les plus urgents d'abord (déclarés, contestés, en retard…), puis la page demandée
  const items = filtered ? ((filtered.data as OrgSettlements | null)?.items ?? []) : sortOpen(openItems, serverNow).slice(0, limit);
  const hasMore = filtered ? items.length >= limit && limit < SETTLEMENT_MAX : openItems.length > limit;
  const failed = overview.error || open.error || filtered?.error;

  return (
    <>
      <PageHeader
        eyebrow="Centrale"
        title="Encaissements"
        description={
          canManage
            ? "Frais plateforme à régler à Rydar, commissions à encaisser auprès des chauffeurs, parts à leur verser : confirmez, relancez, réclamez en un clic."
            : "Commissions à encaisser auprès des chauffeurs, parts à leur verser : confirmez les paiements, relancez les retardataires, réclamez en un clic."
        }
        actions={
          canManage ? (
            <Button asChild variant="outline">
              <Link href="/dashboard/settings?tab=centrale" prefetch={false}>
                <Settings2 /> Commission & encaissement
              </Link>
            </Button>
          ) : undefined
        }
      />
      <PageBody className="space-y-8">
        {platform?.error ? (
          <Card id="frais-plateforme">
            <EmptyState icon={<Landmark />} title="Frais plateforme indisponibles" description="La lecture de votre compte auprès de Rydar a échoué. Réessayez dans un instant." className="py-8" />
          </Card>
        ) : platformData?.enabled ? (
          <OrgPlatformCard data={platformData} serverNow={serverNow} />
        ) : null}
        {failed ? (
          <Card>
            <EmptyState icon={<HandCoins />} title="Encaissements indisponibles" description="La lecture des règlements a échoué. Réessayez dans un instant." />
          </Card>
        ) : (
          <SettlementsView
            key={`${filter}:${driver ?? ""}`}
            overview={overview.data as OrgSettlementOverview}
            openIndex={openItems.map(compactOpen)}
            items={items}
            filter={filter}
            driverId={driver}
            limit={limit}
            hasMore={hasMore}
            orgName={ctx.org.name}
            timeZone={ctx.org.timezone || "Europe/Paris"}
            canManage={canManage}
            serverNow={serverNow}
            platformMonthCents={platformData?.enabled ? platformData.account.month.fees_cents : null}
          />
        )}
      </PageBody>
    </>
  );
}
