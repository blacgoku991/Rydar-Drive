import { ORG_STATUS_META, formatCompactPrice, formatNumber, formatRelative, type OrgStatus } from "@rydar/shared";
import { AlertTriangle, Building2, Car, CreditCard, Radar, Route, ShieldAlert, Users } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { PlatformDailyChart } from "@/components/admin/admin-widgets";
import { PageBody, PageHeader, StatCard } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Table, TD, TH, THead, TR } from "@/components/ui/table";
import { requireSuperAdmin } from "@/lib/auth";

export const metadata: Metadata = { title: "Super admin" };
export const dynamic = "force-dynamic";

export default async function AdminOverview() {
  const session = await requireSuperAdmin();
  const { data } = await session.supabase.rpc("platform_overview");
  const o = (data ?? {}) as any;
  const t = o.totals ?? {};
  return (
    <>
      <PageHeader eyebrow="Rydar Drive" title="Vue d'ensemble de la plateforme" description="Tous les rattacheurs, leur flotte, leur activité et la santé du dispatch." />
      <PageBody className="space-y-6">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
          <StatCard label="Rattacheurs" value={formatNumber(t.organizations_active)} sub={`${t.organizations_suspended ?? 0} suspendus`} icon={<Building2 />} />
          <StatCard label="Chauffeurs" value={formatNumber(t.drivers)} sub={`${t.drivers_online ?? 0} en ligne`} icon={<Users />} tone="brand" />
          <StatCard label="Courses auj." value={formatNumber(t.rides_today)} sub={`${formatNumber(t.rides_month)} ce mois`} icon={<Route />} />
          <StatCard label="En cours" value={formatNumber(t.active_rides)} icon={<Car />} tone="cyan" />
          <StatCard label="Volume mois" value={formatCompactPrice(t.gmv_month_cents)} sub="courses terminées" icon={<Radar />} />
          <StatCard label="MRR" value={formatCompactPrice(t.mrr_cents)} sub="abonnements actifs" icon={<CreditCard />} tone="brand" />
          <StatCard label="Sans chauffeur" value={formatNumber(t.no_driver_24h)} sub={`24 h · ${t.dispatch_errors_24h ?? 0} erreurs`} icon={<AlertTriangle />} tone={t.no_driver_24h ? "red" : undefined} />
          <StatCard label="Sécurité 7 j" value={formatNumber(t.security_events_7d)} sub={`${t.notifications_failed_24h ?? 0} push en échec 24 h`} icon={<ShieldAlert />} tone={t.security_events_7d ? "amber" : undefined} />
        </div>

        <div className="grid gap-6 xl:grid-cols-[1.4fr_1fr]">
          <Card>
            <CardHeader title="Courses sur la plateforme" description="30 derniers jours, tous rattacheurs." />
            <CardBody><PlatformDailyChart data={o.daily ?? []} /></CardBody>
          </Card>
          <Card>
            <CardHeader title="Alertes récentes" description="Avertissements et erreurs de dispatch (7 jours)." />
            <div className="max-h-[330px] divide-y divide-line overflow-y-auto">
              {(o.recent_errors ?? []).length === 0 && <p className="px-5 py-6 text-[13px] text-fg-subtle">Aucune alerte.</p>}
              {(o.recent_errors ?? []).map((e: any) => (
                <div key={e.id} className="px-5 py-2.5">
                  <p className={`text-[12.5px] ${e.level === "error" ? "text-red" : "text-amber"}`}>{e.message}</p>
                  <p className="text-[11.5px] text-fg-subtle">{e.organization} · {formatRelative(e.created_at)}</p>
                </div>
              ))}
            </div>
          </Card>
        </div>

        <Card className="overflow-hidden">
          <CardHeader title="Rattacheurs" description="Activité par tenant." action={<Link href="/admin/organizations" className="text-[12.5px] text-brand hover:underline">Tout gérer</Link>} />
          <Table>
            <THead>
              <tr>
                <TH>Rattacheur</TH><TH>Offre</TH><TH className="text-right">Chauffeurs</TH><TH className="text-right">En ligne</TH>
                <TH className="text-right">Courses auj.</TH><TH className="text-right">30 jours</TH><TH className="text-right">Sans chauffeur 7 j</TH><TH>Dernière course</TH><TH>Statut</TH>
              </tr>
            </THead>
            <tbody>
              {(o.organizations ?? []).map((org: any) => (
                <TR key={org.id} className="relative">
                  <TD>
                    <Link href={`/admin/organizations/${org.id}`} className="absolute inset-0" aria-label={org.name} />
                    <p className="text-[13.5px] font-medium">{org.name}</p>
                    <p className="text-[12px] text-fg-subtle">{org.city ?? org.slug}</p>
                  </TD>
                  <TD><Badge tone="neutral" dot={false}>{org.plan ?? "—"}</Badge></TD>
                  <TD className="num text-right">{org.drivers}</TD>
                  <TD className="num text-right text-brand">{org.drivers_online}</TD>
                  <TD className="num text-right">{org.rides_today}</TD>
                  <TD className="num text-right">{org.rides_30d}</TD>
                  <TD className={`num text-right ${org.no_driver_7d ? "text-red" : "text-fg-subtle"}`}>{org.no_driver_7d}</TD>
                  <TD className="text-[12.5px] text-fg-muted">{org.last_ride_at ? formatRelative(org.last_ride_at) : "—"}</TD>
                  <TD><Badge tone={ORG_STATUS_META[org.status as OrgStatus].tone}>{ORG_STATUS_META[org.status as OrgStatus].label}</Badge></TD>
                </TR>
              ))}
            </tbody>
          </Table>
        </Card>
      </PageBody>
    </>
  );
}
