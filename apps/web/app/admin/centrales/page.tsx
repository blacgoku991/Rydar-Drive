import { formatCompactPrice, formatNumber, formatPrice, zonedTimeToUtc, type AdminCentraleOverview } from "@rydar/shared";
import { AlertTriangle, Banknote, CircleDollarSign, Flag, Network, Route, ShieldBan } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { formatPlatformFee } from "@/components/admin/fees";
import { FraudReportsList, type AdminFraudReport } from "@/components/admin/fraud-reports";
import { PageBody, PageHeader, StatCard } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/misc";
import { Table, TD, TH, THead, TR } from "@/components/ui/table";
import { requireSuperAdmin } from "@/lib/auth";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Centrales" };
export const dynamic = "force-dynamic";

const TZ = "Europe/Paris";
const monthKey = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit" }).format(d).slice(0, 7);
const monthLabel = (key: string) =>
  new Intl.DateTimeFormat("fr-FR", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${key}-15T12:00:00Z`));
const capitalize = (v: string) => v.charAt(0).toUpperCase() + v.slice(1);
/** « 2026-09 » → mois précédents (le mois courant en premier). */
function lastMonths(current: string, n: number) {
  const [y, m] = current.split("-").map(Number);
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(y!, m! - 1 - i, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  });
}

const REPORT_COLUMNS =
  "id, organization_id, driver_id, driver_label, category, reason, identities, status, reported_by, reviewed_by, reviewed_at, review_note, created_at, updated_at, " +
  "organization:organizations(id, name), reporter:users!fraud_reports_reported_by_fkey(full_name, email), reviewer:users!fraud_reports_reviewed_by_fkey(full_name, email), " +
  "touched:drivers!drivers_ban_report_fk(id, number, first_name, last_name, organization:organizations(name))";

const one = <T,>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));

export default async function CentralesPage({ searchParams }: { searchParams: Promise<{ mois?: string }> }) {
  const session = await requireSuperAdmin();
  const current = monthKey(new Date());
  const months = lastMonths(current, 6);
  const { mois } = await searchParams;
  const month = mois && months.includes(mois) ? mois : current;
  const from = zonedTimeToUtc(`${month}-01`, "00:00", TZ).toISOString();

  const [{ data: overviewData, error }, { data: reportRows }] = await Promise.all([
    session.supabase.rpc("admin_centrale_overview", { p_from: from }),
    session.supabase.from("fraud_reports").select(REPORT_COLUMNS).order("created_at", { ascending: false }).limit(200),
  ]);
  const overview = (overviewData ?? null) as AdminCentraleOverview | null;
  const rows = overview?.organizations ?? [];
  const totals = overview?.totals ?? { centrales: 0, rides: 0, volume_cents: 0, platform_fee_cents: 0, platform_due_cents: 0, platform_balance_cents: 0 };
  const commissionTotal = rows.reduce((s, r) => s + Number(r.commission_cents ?? 0), 0);
  const outstandingTotal = rows.reduce((s, r) => s + Number(r.outstanding_cents ?? 0), 0);
  const overdueTotal = rows.reduce((s, r) => s + Number(r.overdue_cents ?? 0), 0);
  const pendingTotal = rows.reduce((s, r) => s + Number(r.applications_pending ?? 0), 0);
  const platformDeclaredTotal = rows.reduce((s, r) => s + Number(r.platform_declared_cents ?? 0), 0);
  const platformLateCount = rows.filter((r) => r.platform_overdue_since && Number(r.platform_due_cents ?? 0) > 0).length;
  const reports = ((reportRows ?? []) as unknown as Record<string, unknown>[]).map(
    (r) =>
      ({
        ...r,
        organization: one(r.organization as AdminFraudReport["organization"]),
        reporter: one(r.reporter as AdminFraudReport["reporter"]),
        reviewer: one(r.reviewer as AdminFraudReport["reviewer"]),
        touched: ((r.touched ?? []) as Record<string, unknown>[]).map((d) => ({ ...d, organization: one(d.organization as { name: string } | null) })),
      }) as AdminFraudReport,
  );
  const isCurrent = month === current;

  return (
    <>
      <PageHeader
        eyebrow="Plateforme"
        title="Centrales à commission"
        description="Comptes en option 2 : réseau de chauffeurs indépendants, commissions, frais plateforme et signalements de fraude."
        actions={
          <nav aria-label="Mois" className="flex gap-1 rounded-xl border border-line bg-ink-850 p-1">
            {months.slice(0, 4).map((k, i) => (
              <Link
                key={k}
                href={k === current ? "/admin/centrales" : `/admin/centrales?mois=${k}`}
                className={cn(
                  "shrink-0 whitespace-nowrap rounded-lg px-3 py-1.5 text-[12.5px] font-medium",
                  k === month ? "bg-ink-600 text-fg" : "text-fg-muted hover:text-fg",
                  i === 3 && k !== month && "max-sm:hidden",
                )}
              >
                {k === current ? "Ce mois" : capitalize(monthLabel(k))}
              </Link>
            ))}
          </nav>
        }
      />
      <PageBody className="space-y-6">
        {error && (
          <p className="rounded-xl border border-red/25 bg-red/[0.07] px-4 py-3 text-[13px] text-red">Vue d&apos;ensemble indisponible : {error.message}</p>
        )}
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
          <StatCard label="Centrales" value={formatNumber(totals.centrales)} sub={`${pendingTotal} candidature${pendingTotal > 1 ? "s" : ""} en attente`} icon={<Network />} />
          <StatCard label={isCurrent ? "Courses du mois" : "Courses"} value={formatNumber(totals.rides)} sub={monthLabel(month)} icon={<Route />} />
          <StatCard label="Volume" value={formatCompactPrice(totals.volume_cents)} sub={`${formatCompactPrice(commissionTotal)} de commissions`} icon={<Banknote />} />
          <StatCard label="Frais plateforme" value={formatPrice(totals.platform_fee_cents)} sub={`total ${monthLabel(month)}`} tone="brand" />
          <StatCard label="Dû par les chauffeurs" value={formatCompactPrice(outstandingTotal)} sub={overdueTotal ? `${formatCompactPrice(overdueTotal)} en retard` : "aucun retard"} tone={overdueTotal ? "amber" : undefined} icon={<AlertTriangle />} />
          <Link href="/admin/frais" className="block h-full rounded-xl transition-opacity hover:opacity-90 [&>div]:h-full" aria-label="Dû à Rydar : ouvrir les frais plateforme">
            <StatCard
              label="Dû à Rydar"
              value={formatPrice(totals.platform_due_cents)}
              sub={
                // Le solde reste visible même quand rien n'est échu (« 0 € » seul laisserait croire que rien n'est dû)
                [
                  platformLateCount ? `${platformLateCount} en retard` : "échu",
                  `solde ${formatPrice(totals.platform_balance_cents)}`,
                  platformDeclaredTotal ? `${formatPrice(platformDeclaredTotal)} à confirmer` : null,
                ]
                  .filter(Boolean)
                  .join(" · ")
              }
              tone={platformLateCount ? "red" : totals.platform_due_cents ? "amber" : undefined}
              icon={<CircleDollarSign />}
            />
          </Link>
          <StatCard
            label="Signalements"
            value={formatNumber(overview?.reports_open ?? 0)}
            sub={`${overview?.platform_bans ?? 0} identité${(overview?.platform_bans ?? 0) > 1 ? "s" : ""} bannie${(overview?.platform_bans ?? 0) > 1 ? "s" : ""} partout`}
            tone={overview?.reports_open ? "red" : undefined}
            icon={<Flag />}
          />
        </div>

        <Card className="overflow-hidden">
          <CardHeader
            title="Centrales"
            icon={<Network />}
            description={`Activité ${isCurrent ? "du mois en cours" : `de ${monthLabel(month)}`} (courses terminées) ; montants dus à date.`}
          />
          {!rows.length ? (
            <EmptyState
              icon={<Network />}
              title="Aucune centrale"
              description="Passez un rattacheur en « Option 2 — Centrale » depuis sa fiche pour l'ajouter ici."
              action={<Link href="/admin/organizations" className="text-[13px] font-medium text-brand hover:underline">Voir les rattacheurs</Link>}
            />
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH>Centrale</TH>
                  <TH>Frais plateforme</TH>
                  <TH className="text-right">Chauffeurs</TH>
                  <TH className="text-right">Courses</TH>
                  <TH className="text-right">Volume</TH>
                  <TH className="text-right">Commissions</TH>
                  <TH className="text-right">Frais du mois</TH>
                  <TH className="text-right">Dû par les chauffeurs</TH>
                  <TH className="text-right">Dû à Rydar</TH>
                </tr>
              </THead>
              <tbody>
                {rows.map((o) => (
                  <TR key={o.id} className="relative">
                    <TD>
                      <Link href={`/admin/organizations/${o.id}`} className="absolute inset-0" aria-label={o.name} />
                      <p className="whitespace-nowrap text-[13.5px] font-medium">{o.name}</p>
                      <p className="mt-0.5 flex items-center gap-1.5 whitespace-nowrap text-[11.5px] text-fg-subtle">
                        <span className={cn("size-1.5 rounded-full", o.join_enabled ? "bg-green" : "bg-fg-subtle")} />
                        {o.join_enabled ? `Lien actif${o.join_auto_approve ? " · validation auto" : ""}` : "Lien d'inscription coupé"}
                        {o.status !== "active" && <Badge tone="amber" dot={false} className="ml-1 h-[18px]">{o.status === "suspended" ? "Suspendu" : o.status}</Badge>}
                      </p>
                    </TD>
                    <TD className="num whitespace-nowrap text-[12.5px] text-fg-muted">{formatPlatformFee(o.platform_fee_percent, o.platform_fee_fixed_cents)}</TD>
                    <TD className="whitespace-nowrap text-right">
                      <span className="num block">{formatNumber(o.drivers_active)}</span>
                      {(o.applications_pending > 0 || o.drivers_banned > 0) && (
                        <span className="block text-[11.5px]">
                          {o.applications_pending > 0 && (
                            <span className="font-medium text-amber">
                              {o.applications_pending} candidature{o.applications_pending > 1 ? "s" : ""}
                            </span>
                          )}
                          {o.applications_pending > 0 && o.drivers_banned > 0 && <span className="text-fg-subtle"> · </span>}
                          {o.drivers_banned > 0 && (
                            <span className="text-red">
                              {o.drivers_banned} banni{o.drivers_banned > 1 ? "s" : ""}
                            </span>
                          )}
                        </span>
                      )}
                    </TD>
                    <TD className="num text-right">{formatNumber(o.rides)}</TD>
                    <TD className="num whitespace-nowrap text-right">{formatPrice(o.volume_cents)}</TD>
                    <TD className="num whitespace-nowrap text-right text-fg-muted">{formatPrice(o.commission_cents)}</TD>
                    <TD className="num whitespace-nowrap text-right font-semibold text-brand">{formatPrice(o.platform_fee_cents)}</TD>
                    <TD className="whitespace-nowrap text-right">
                      <span className="num block">{formatPrice(o.outstanding_cents)}</span>
                      <span className={cn("num block text-[11.5px]", o.overdue_cents ? "font-medium text-red" : "text-fg-subtle")}>
                        {o.overdue_cents ? `${formatPrice(o.overdue_cents)} en retard` : "aucun retard"}
                      </span>
                    </TD>
                    <TD className="whitespace-nowrap text-right">
                      <Link
                        href={`/admin/frais/${o.id}`}
                        className="relative z-10 -mx-1.5 inline-block rounded-md px-1.5 py-0.5 text-right hover:bg-white/[0.05]"
                        title="Frais plateforme de cette centrale"
                      >
                        <span
                          className={cn(
                            "num block",
                            Number(o.platform_due_cents ?? 0) > 0 ? (o.platform_overdue_since ? "font-semibold text-red" : "font-semibold text-amber") : "text-fg-subtle",
                          )}
                        >
                          {formatPrice(Number(o.platform_due_cents ?? 0))}
                        </span>
                        <span className="num block text-[11.5px] text-fg-subtle">solde {formatPrice(Number(o.platform_balance_cents ?? 0))}</span>
                        {Number(o.platform_declared_cents ?? 0) > 0 && (
                          <span className="num block text-[11.5px] text-blue">{formatPrice(Number(o.platform_declared_cents))} à confirmer</span>
                        )}
                      </Link>
                    </TD>
                  </TR>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-line-strong bg-white/[0.02]">
                  <TD className="text-[12.5px] font-semibold text-fg-muted">Total</TD>
                  <TD />
                  <TD className="num text-right text-fg-muted">{formatNumber(rows.reduce((s, r) => s + Number(r.drivers_active ?? 0), 0))}</TD>
                  <TD className="num text-right font-semibold">{formatNumber(totals.rides)}</TD>
                  <TD className="num whitespace-nowrap text-right font-semibold">{formatPrice(totals.volume_cents)}</TD>
                  <TD className="num whitespace-nowrap text-right text-fg-muted">{formatPrice(commissionTotal)}</TD>
                  <TD className="num whitespace-nowrap text-right font-semibold text-brand">{formatPrice(totals.platform_fee_cents)}</TD>
                  <TD className="whitespace-nowrap text-right">
                    <span className="num block">{formatPrice(outstandingTotal)}</span>
                    <span className={cn("num block text-[11.5px]", overdueTotal ? "font-medium text-red" : "text-fg-subtle")}>
                      {overdueTotal ? `${formatPrice(overdueTotal)} en retard` : "aucun retard"}
                    </span>
                  </TD>
                  <TD className="whitespace-nowrap text-right">
                    <span className={cn("num block", totals.platform_due_cents ? (platformLateCount ? "font-semibold text-red" : "font-semibold text-amber") : "text-fg-subtle")}>{formatPrice(totals.platform_due_cents)}</span>
                    <span className="num block text-[11.5px] text-fg-subtle">solde {formatPrice(totals.platform_balance_cents)}</span>
                  </TD>
                </tr>
              </tfoot>
            </Table>
          )}
        </Card>

        <Card className="overflow-hidden">
          <CardHeader
            title="Signalements de fraude"
            icon={<ShieldBan />}
            description="Chauffeurs bannis par une centrale et signalés à Rydar. Identités hachées : seuls des indices masqués sont affichés."
            action={
              overview?.reports_open ? (
                <Badge tone="amber" pulse>
                  {overview.reports_open} à examiner
                </Badge>
              ) : undefined
            }
          />
          <FraudReportsList reports={reports} />
        </Card>
      </PageBody>
    </>
  );
}
