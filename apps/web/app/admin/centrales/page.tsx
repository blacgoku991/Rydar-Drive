import { ORG_STATUS_META, formatCompactPrice, formatNumber, formatPrice, zonedTimeToUtc, type AdminCentraleOverview, type AdminCentraleRow } from "@rydar/shared";
import { Banknote, ChevronRight, HandCoins, Network, Route } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { PageBody, PageHeader, StatCard } from "@/components/layout/page-header";
import { aheadDeclaredNote, capitalize, declaredSplit, lastMonths, lateDeclaredNote, monthKey, monthLabel } from "@/components/platform-fees/admin-platform-format";
import { Badge } from "@/components/ui/badge";
import { Callout } from "@/components/ui/callout";
import { Card, CardHeader } from "@/components/ui/card";
import { FilterTabs } from "@/components/ui/filter-tabs";
import { EmptyState } from "@/components/ui/misc";
import { DesktopTable, MobileList, Table, TD, TH, THead, TR } from "@/components/ui/table";
import { requireSuperAdmin } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { plural } from "@/lib/wording";

export const metadata: Metadata = { title: "Commissions des centrales" };
export const dynamic = "force-dynamic";

const TZ = "Europe/Paris";
const PATH = "/admin/centrales";

/**
 * Commissions des centrales (docs/REFONTE-PANELS.md, R5) : activité des centrales à commission, mois par mois (6 derniers
 * mois, ?mois=). Quatre chiffres ; ce qui est dû à Rydar n'est qu'une carte-lien vers Frais Rydar (aucun chiffre des frais
 * en double) ; signalements de fraude en lien vers leur page ; cartes sous 768 px, tableau au-delà. Même lecture.
 */
export default async function CentralesPage({ searchParams }: { searchParams: Promise<{ mois?: string }> }) {
  const session = await requireSuperAdmin();
  const current = monthKey(new Date(), TZ);
  const months = lastMonths(current, 6);
  const { mois } = await searchParams;
  const month = mois && months.includes(mois) ? mois : current;
  const from = zonedTimeToUtc(`${month}-01`, "00:00", TZ).toISOString();

  // Signalements de fraude : page « Signalements de fraude » (/admin/signalements), lue là-bas
  const { data: overviewData, error } = await session.supabase.rpc("admin_centrale_overview", { p_from: from });
  if (error) console.error("[admin] commissions des centrales", error.message);
  const overview = (overviewData ?? null) as AdminCentraleOverview | null;
  const rows = overview?.organizations ?? [];
  const totals = overview?.totals ?? { centrales: 0, rides: 0, volume_cents: 0, platform_fee_cents: 0, platform_due_cents: 0, platform_balance_cents: 0 };
  const commissionTotal = rows.reduce((s, r) => s + Number(r.commission_cents ?? 0), 0);
  const outstandingTotal = rows.reduce((s, r) => s + Number(r.outstanding_cents ?? 0), 0);
  const overdueTotal = rows.reduce((s, r) => s + Number(r.overdue_cents ?? 0), 0);
  const pendingTotal = rows.reduce((s, r) => s + Number(r.applications_pending ?? 0), 0);
  // Paiements déclarés à Rydar, pas encore confirmés : part qui couvre le retard, part déclarée d'avance (par centrale)
  const declaredTotals = rows.reduce(
    (t, r) => {
      const d = declaredSplit(rydarAccount(r));
      return { onLate: t.onLate + d.onLate, ahead: t.ahead + d.ahead };
    },
    { onLate: 0, ahead: 0 },
  );
  const platformLateCount = rows.filter((r) => r.platform_overdue_since && Number(r.platform_due_cents ?? 0) > 0).length;
  const isCurrent = month === current;
  const label = monthLabel(month);
  const reports = overview?.reports_open ?? 0;
  const bans = overview?.platform_bans ?? 0;

  return (
    <>
      <PageHeader
        title="Commissions des centrales"
        description={"Activité des centrales à commission : courses, commissions et sommes dues par les chauffeurs."}
      />
      <PageBody className="space-y-6">
        <FilterTabs
          label="Mois affiché"
          items={months.map((k) => ({
            href: k === current ? PATH : `${PATH}?mois=${k}`,
            label: k === current ? "Ce mois" : capitalize(monthLabel(k)),
            active: k === month,
          }))}
        />

        {!overview ? (
          <Callout tone="danger" title="Lecture impossible, réessayez dans un instant." />
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <StatCard
                label="Centrales"
                value={formatNumber(totals.centrales)}
                sub={pendingTotal ? `${plural(pendingTotal, "candidature")} en attente` : "aucune candidature en attente"}
                icon={<Network />}
              />
              <StatCard label={isCurrent ? "Courses du mois" : "Courses"} value={formatNumber(totals.rides)} sub={`terminées en ${label}`} icon={<Route />} />
              <StatCard label="Volume" value={formatCompactPrice(totals.volume_cents)} sub={`${formatCompactPrice(commissionTotal)} de commissions`} icon={<Banknote />} />
              {/* Le total n'est pas en retard : seule la part en retard est en rouge */}
              <StatCard
                label="Dû par les chauffeurs"
                value={formatCompactPrice(outstandingTotal)}
                sub={overdueTotal ? <span className="text-red">{formatCompactPrice(overdueTotal)} en retard</span> : "aucun retard"}
                icon={<HandCoins />}
              />
            </div>

            {/* Frais Rydar et fraude : traités sur leurs pages ; ici, un lien et ce qu'il y a à y voir */}
            <div className="grid gap-3 md:grid-cols-2">
              {/* Mêmes mots que Frais Rydar et la fiche du client : « En retard » (dont la part déclarée, à confirmer) */}
              <LinkCard
                href="/admin/frais"
                title="Frais Rydar"
                alert={platformLateCount > 0}
                text={[
                  lateText(totals.platform_due_cents, lateDeclaredNote({ due_cents: totals.platform_due_cents, declared_cents: declaredTotals.onLate })),
                  `solde ${formatPrice(totals.platform_balance_cents)}`,
                  aheadDeclaredNote({ due_cents: 0, declared_cents: declaredTotals.ahead }),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              />
              <LinkCard
                href="/admin/signalements"
                title="Signalements de fraude"
                alert={reports > 0}
                text={`${reports ? `${formatNumber(reports)} à examiner` : "aucun à examiner"} · ${bans ? plural(bans, "identité bannie", "identités bannies") : "aucune identité bannie"} de la plateforme`}
              />
            </div>

            <Card className="overflow-hidden">
              <CardHeader
                title="Centrales"
                icon={<Network />}
                description={`Activité ${isCurrent ? "du mois en cours" : `de ${label}`} (courses terminées) ; sommes dues à ce jour.`}
              />
              {!rows.length ? (
                <EmptyState
                  size="compact"
                  icon={<Network />}
                  title="Aucune centrale à commission."
                  description={"Passez un client en centrale à commission depuis sa fiche (« Modèle et frais Rydar »)."}
                  action={
                    <Link href="/admin/organizations" prefetch={false} className="inline-flex min-h-11 items-center text-[13px] font-medium text-brand hover:underline sm:min-h-0">
                      Voir les clients
                    </Link>
                  }
                />
              ) : (
                <>
                  <MobileList>
                    {rows.map((o) => (
                      <CentraleCard key={o.id} o={o} />
                    ))}
                  </MobileList>
                  <DesktopTable>
                    <Table>
                      <THead>
                        <tr>
                          <TH>Centrale</TH>
                          <TH className="text-right">Chauffeurs</TH>
                          <TH className="text-right">Courses</TH>
                          <TH className="text-right">Volume</TH>
                          <TH className="text-right">Commissions</TH>
                          <TH className="text-right">Dû par les chauffeurs</TH>
                          <TH className="text-right">Frais Rydar</TH>
                        </tr>
                      </THead>
                      <tbody>
                        {rows.map((o) => (
                          <TR key={o.id} className="relative">
                            <TD>
                              <Link href={`/admin/organizations/${o.id}`} prefetch={false} className="absolute inset-0" aria-label={o.name} />
                              <p className="whitespace-nowrap text-[13.5px] font-medium">{o.name}</p>
                              <p className="mt-0.5 flex items-center gap-1.5 whitespace-nowrap text-[12px] text-fg-muted">
                                <span aria-hidden className={cn("size-1.5 rounded-full", o.join_enabled ? "bg-green" : "bg-fg-subtle")} />
                                {joinText(o)}
                                {o.status !== "active" && (
                                  <Badge tone={ORG_STATUS_META[o.status].tone} dot={false} className="ml-1">
                                    {ORG_STATUS_META[o.status].label}
                                  </Badge>
                                )}
                              </p>
                            </TD>
                            <TD className="whitespace-nowrap text-right">
                              <span className="num block">{formatNumber(o.drivers_active)}</span>
                              <DriversNote o={o} />
                            </TD>
                            <TD className="num text-right">{formatNumber(o.rides)}</TD>
                            <TD className="num whitespace-nowrap text-right">{formatPrice(o.volume_cents)}</TD>
                            <TD className="num whitespace-nowrap text-right text-fg-muted">{formatPrice(o.commission_cents)}</TD>
                            <TD className="whitespace-nowrap text-right">
                              <span className="num block">{formatPrice(o.outstanding_cents)}</span>
                              <span className={cn("num block text-[12px]", o.overdue_cents ? "font-medium text-red" : "text-fg-muted")}>
                                {o.overdue_cents ? `${formatPrice(o.overdue_cents)} en retard` : "aucun retard"}
                              </span>
                            </TD>
                            <TD className="whitespace-nowrap text-right">
                              <Link
                                href={`/admin/frais/${o.id}`}
                                prefetch={false}
                                className="relative z-10 -mx-1.5 inline-block rounded-md px-1.5 py-0.5 text-right hover:bg-white/[0.05]"
                                aria-label={`Frais Rydar de ${o.name}`}
                              >
                                <RydarDue o={o} />
                              </Link>
                            </TD>
                          </TR>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr className="border-t border-line-strong bg-white/[0.02]">
                          <TD className="text-[13px] font-semibold text-fg-muted">Total</TD>
                          <TD className="num text-right text-fg-muted">{formatNumber(rows.reduce((s, r) => s + Number(r.drivers_active ?? 0), 0))}</TD>
                          <TD className="num text-right font-semibold">{formatNumber(totals.rides)}</TD>
                          <TD className="num whitespace-nowrap text-right font-semibold">{formatPrice(totals.volume_cents)}</TD>
                          <TD className="num whitespace-nowrap text-right text-fg-muted">{formatPrice(commissionTotal)}</TD>
                          <TD className="whitespace-nowrap text-right">
                            <span className="num block">{formatPrice(outstandingTotal)}</span>
                            <span className={cn("num block text-[12px]", overdueTotal ? "font-medium text-red" : "text-fg-muted")}>
                              {overdueTotal ? `${formatPrice(overdueTotal)} en retard` : "aucun retard"}
                            </span>
                          </TD>
                          <TD className="whitespace-nowrap text-right">
                            <RydarDueLines
                              due={totals.platform_due_cents}
                              balance={totals.platform_balance_cents}
                              onLate={declaredTotals.onLate}
                              ahead={declaredTotals.ahead}
                              strong
                            />
                          </TD>
                        </tr>
                      </tfoot>
                    </Table>
                  </DesktopTable>
                </>
              )}
            </Card>
          </>
        )}
      </PageBody>
    </>
  );
}

/** Lien d'inscription des chauffeurs de la centrale. */
const joinText = (o: AdminCentraleRow) => (o.join_enabled ? `Lien actif${o.join_auto_approve ? " · validation auto" : ""}` : "Lien d'inscription coupé");

/** Candidatures en attente et chauffeurs bannis, sous le nombre de chauffeurs actifs. */
function DriversNote({ o }: { o: AdminCentraleRow }) {
  if (!(o.applications_pending > 0 || o.drivers_banned > 0)) return null;
  return (
    <span className="block text-[12px]">
      {o.applications_pending > 0 && <span className="font-medium text-amber">{plural(o.applications_pending, "candidature")}</span>}
      {o.applications_pending > 0 && o.drivers_banned > 0 && <span className="text-fg-muted"> · </span>}
      {o.drivers_banned > 0 && <span className="text-fg-muted">{plural(o.drivers_banned, "banni")}</span>}
    </span>
  );
}

/** Compte des frais Rydar d'une centrale, tel que le lisent les formats du super admin. */
const rydarAccount = (o: AdminCentraleRow) => ({ due_cents: Number(o.platform_due_cents ?? 0), declared_cents: Number(o.platform_declared_cents ?? 0) });

/** « 55 € en retard (dont 10 € déclarés, à confirmer) », « rien en retard ». */
function lateText(due: number, note: string | null) {
  return due > 0 ? `${formatPrice(due)} en retard${note ? ` (${note})` : ""}` : "rien en retard";
}

/**
 * Frais Rydar d'une centrale (ou du total) : retard en rouge, part déclarée à confirmer (sur le retard ou d'avance) en
 * ambre, solde. Mêmes mots que Frais Rydar et la fiche du client.
 */
function RydarDueLines({ due, balance, onLate, ahead, strong = false }: { due: number; balance: number; onLate: number; ahead: number; strong?: boolean }) {
  const lateNote = lateDeclaredNote({ due_cents: due, declared_cents: onLate });
  const aheadNote = aheadDeclaredNote({ due_cents: 0, declared_cents: ahead });
  return (
    <>
      <span className={cn("block", due > 0 ? cn("text-red", strong ? "font-semibold" : "font-medium") : "text-fg-subtle")}>
        {due > 0 ? (
          <>
            <span className="num">{formatPrice(due)}</span> en retard
          </>
        ) : (
          "rien en retard"
        )}
      </span>
      {lateNote && <span className="block text-[12px] text-amber">{lateNote}</span>}
      {aheadNote && <span className="block text-[12px] text-amber">{aheadNote}</span>}
      <span className="num block text-[12px] text-fg-muted">solde {formatPrice(balance)}</span>
    </>
  );
}

/** Frais Rydar dus par une centrale (ligne du tableau et carte sur téléphone). */
function RydarDue({ o }: { o: AdminCentraleRow }) {
  const split = declaredSplit(rydarAccount(o));
  return <RydarDueLines due={Number(o.platform_due_cents ?? 0)} balance={Number(o.platform_balance_cents ?? 0)} onLate={split.onLate} ahead={split.ahead} />;
}

/** Carte d'une centrale sur téléphone : toute la carte ouvre sa fiche ; chiffres sur deux colonnes, jamais coupés. */
function CentraleCard({ o }: { o: AdminCentraleRow }) {
  return (
    <li>
      <Link href={`/admin/organizations/${o.id}`} prefetch={false} className="flex items-start gap-3 px-4 py-3.5 transition-colors hover:bg-white/[0.03]">
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <p className="min-w-0 text-[14px] font-medium text-fg [overflow-wrap:anywhere]">{o.name}</p>
            {o.status !== "active" && (
              <Badge tone={ORG_STATUS_META[o.status].tone} dot={false}>
                {ORG_STATUS_META[o.status].label}
              </Badge>
            )}
          </div>
          <p className="mt-0.5 text-[12px] text-fg-muted">{joinText(o)}</p>
          <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-[13px]">
            <div className="min-w-0">
              <dt className="text-[12px] text-fg-muted">Chauffeurs</dt>
              <dd className="num text-fg">
                {formatNumber(o.drivers_active)}
                <DriversNote o={o} />
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-[12px] text-fg-muted">Courses</dt>
              <dd className="num text-fg">{formatNumber(o.rides)}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-[12px] text-fg-muted">Volume</dt>
              <dd className="num text-fg">{formatPrice(o.volume_cents)}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-[12px] text-fg-muted">Commissions</dt>
              <dd className="num text-fg">{formatPrice(o.commission_cents)}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-[12px] text-fg-muted">Dû par les chauffeurs</dt>
              <dd className="num text-fg">
                {formatPrice(o.outstanding_cents)}
                {o.overdue_cents > 0 && <span className="block text-[12px] font-medium text-red">{formatPrice(o.overdue_cents)} en retard</span>}
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-[12px] text-fg-muted">Frais Rydar</dt>
              <dd>
                <RydarDue o={o} />
              </dd>
            </div>
          </dl>
        </div>
        <ChevronRight aria-hidden className="mt-1 size-4 shrink-0 text-fg-subtle" />
      </Link>
    </li>
  );
}

/**
 * Carte-lien vers une autre page (Frais Rydar, signalements) : ce qu'il y a à y voir en une ligne, rouge seulement si
 * quelque chose attend (retard, signalement à examiner). Nom accessible : titre, phrase, puis la page visée si le titre
 * ne la nomme pas.
 */
function LinkCard({ href, title, text, linkLabel, alert }: { href: string; title: string; text: string; linkLabel?: string; alert: boolean }) {
  return (
    <Link
      href={href}
      prefetch={false}
      className={cn(
        "surface flex min-h-11 items-center gap-3 rounded-xl px-4 py-3 transition-colors hover:bg-ink-700",
        // Liseré rouge par ring : ne dépend pas de l'ordre des classes de `surface` (qui pose sa propre bordure)
        alert && "ring-1 ring-inset ring-red/30",
      )}
    >
      <span aria-hidden className={cn("size-2 shrink-0 rounded-full", alert ? "bg-red" : "bg-fg-subtle")} />
      <span className="min-w-0 flex-1">
        <span className="block text-[13.5px] font-medium text-fg">{title}</span>
        <span className="block text-[13px] text-fg-muted">{text}</span>
      </span>
      <span className="flex shrink-0 items-center gap-1 text-[13px] font-medium text-brand">
        {/* Page visée, quand le titre ne la nomme pas */}
        {linkLabel && <span className="max-sm:sr-only">{linkLabel}</span>}
        <ChevronRight aria-hidden className="size-4" />
      </span>
    </Link>
  );
}
