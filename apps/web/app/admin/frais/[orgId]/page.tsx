import {
  DISPATCH_MODEL_META,
  ORG_STATUS_META,
  PLATFORM_CYCLE_META,
  formatNumber,
  formatPrice,
  platformDueSummary,
  type AdminPlatformAccount,
  type AdminPlatformOverview,
  type PlatformEntry,
} from "@rydar/shared";
import { AlarmClock, ArrowLeft, BellRing, Building2, CalendarClock, CircleDollarSign, HandCoins, Inbox, TrendingUp } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { formatPlatformFee } from "@/components/admin/fees";
import { PageBody } from "@/components/layout/page-header";
import { AccountActions, TermsForm } from "@/components/platform-fees/admin-account-actions";
import { MONTH_RE, ago, cancelledOnboard, formatDay, lastMonths, monthKey, overdueInfo, zeroPriceText } from "@/components/platform-fees/admin-platform-format";
import { PlatformLive } from "@/components/platform-fees/admin-platform-live";
import { Metric } from "@/components/platform-fees/admin-platform-metric";
import { OriginBreakdown, PaymentsHistory, PaymentsToConfirm, PendingReductions, StatementView } from "@/components/platform-fees/admin-platform-sections";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { requireSuperAdmin } from "@/lib/auth";

export const metadata: Metadata = { title: "Frais plateforme · compte" };
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function PlatformAccountPage({ params, searchParams }: { params: Promise<{ orgId: string }>; searchParams: Promise<{ mois?: string }> }) {
  const [{ orgId }, { mois }] = await Promise.all([params, searchParams]);
  if (!UUID.test(orgId)) notFound();
  const session = await requireSuperAdmin();
  const month = mois && MONTH_RE.test(mois) ? mois : null;
  const { data, error } = await session.supabase.rpc("admin_platform_account", { p_org: orgId, p_month: month });
  if (error) {
    return (
      <PageBody>
        <p className="rounded-xl border border-red/25 bg-red/[0.07] px-4 py-3 text-[13px] text-red">Compte indisponible&nbsp;: {error.message}</p>
      </PageBody>
    );
  }
  const d = (data ?? null) as AdminPlatformAccount | null;
  if (!d?.account) notFound();
  const { organization: org, account: a, payments, statement } = d;
  const tz = org.timezone || "Europe/Paris";
  const cur = a.currency;

  // Baisses en attente de cette organisation (toutes périodes confondues)
  let pending: PlatformEntry[] = [];
  if (a.pending_reductions_count > 0) {
    const { data: overview } = await session.supabase.rpc("admin_platform_overview");
    pending = ((overview ?? null) as AdminPlatformOverview | null)?.pending_reductions.filter((e) => e.organization_id === orgId) ?? [];
  }
  const declared = payments.filter((p) => p.status === "declared");
  const late = overdueInfo(a, tz);
  const summary = platformDueSummary(a, tz);
  const months = lastMonths(monthKey(new Date(), tz), 12);
  const basePath = `/admin/frais/${orgId}`;
  const fee = formatPlatformFee(a.fee_percent, a.fee_fixed_cents);
  const feeText = fee === "Aucun" ? "aucun frais par course" : `frais ${fee} par course`;
  const onboard = cancelledOnboard(a);

  return (
    <>
      <div id="top" className="border-b border-line">
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-end justify-between gap-4 px-6 pb-6 pt-6 lg:px-10">
          <div className="min-w-0">
            <Link href="/admin/frais" className="mb-3 inline-flex items-center gap-1.5 text-[12.5px] text-fg-subtle hover:text-fg">
              <ArrowLeft className="size-3.5" /> Frais plateforme
            </Link>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <h1 className="text-[26px] font-semibold tracking-tight">{org.name}</h1>
              <Badge tone={summary.tone}>{summary.text}</Badge>
              {a.blocked && <Badge tone="red">Création de courses bloquée</Badge>}
              {!a.blocked && a.block_suspended && <Badge tone="amber">Blocage suspendu (paiement déclaré à confirmer)</Badge>}
              {org.status !== "active" && <Badge tone={ORG_STATUS_META[org.status].tone}>{ORG_STATUS_META[org.status].label}</Badge>}
              {org.dispatch_model !== "centrale" && (
                <Badge tone="neutral" dot={false}>
                  {DISPATCH_MODEL_META[org.dispatch_model].short}
                </Badge>
              )}
            </div>
            <p className="mt-1.5 text-[13px] text-fg-muted [overflow-wrap:anywhere]">
              Référence de virement <span className="mono text-fg">{a.reference}</span> · {feeText} · {PLATFORM_CYCLE_META[a.cycle].label.toLowerCase()},{" "}
              {a.payment_days} j de délai
            </p>
            {a.reminded_at && (
              <p className="mt-1 flex items-center gap-1.5 text-[12.5px] text-fg-subtle">
                <BellRing className="size-3.5" /> Relancée {ago(a.reminded_at)}
                {a.reminder_note ? ` : « ${a.reminder_note} »` : ""}
              </p>
            )}
          </div>
          <div className="flex flex-col items-start gap-2 sm:items-end">
            <AccountActions orgId={orgId} orgName={org.name} account={a} timeZone={tz} />
            <Link href={`/admin/organizations/${orgId}`} className="inline-flex items-center gap-1.5 text-[12.5px] text-fg-subtle hover:text-fg">
              <Building2 className="size-3.5" /> Fiche du rattacheur
            </Link>
          </div>
        </div>
      </div>

      <PageBody className="space-y-6">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <Metric
            label="Solde"
            value={formatPrice(a.balance_cents, cur)}
            tone={a.balance_cents > 0 ? "amber" : "green"}
            sub={a.balance_cents < 0 ? `avance en faveur de ${org.dispatch_model === "fleet" ? "la flotte" : "la centrale"}` : "frais − paiements reçus"}
            icon={<CircleDollarSign />}
          />
          <Metric
            label="Échu"
            value={formatPrice(a.due_cents, cur)}
            tone={late ? "red" : a.due_cents > 0 ? "amber" : undefined}
            sub={late ? `${late.text} · ${late.since}` : "aucun retard"}
            icon={<AlarmClock />}
          />
          <Metric
            label="À confirmer"
            value={formatPrice(a.declared_cents, cur)}
            tone={a.declared_count ? "blue" : undefined}
            sub={a.declared_count ? `${a.declared_count} déclaration${a.declared_count > 1 ? "s" : ""}` : "aucune déclaration"}
            icon={<Inbox />}
            href={a.declared_count ? "#a-traiter" : undefined}
          />
          <Metric
            label="Prochaine échéance"
            value={a.next_due_at ? formatPrice(a.next_due_cents, cur) : "—"}
            sub={a.next_due_at ? `au plus tard le ${formatDay(a.next_due_at, tz)}` : "rien à venir"}
            icon={<CalendarClock />}
          />
          <Metric
            label="Reçu au total"
            value={formatPrice(a.received_cents, cur)}
            tone="green"
            sub={a.last_payment_at ? `dernier paiement ${ago(a.last_payment_at)}` : "aucun paiement reçu"}
            icon={<HandCoins />}
          />
          <Metric
            label="Frais du mois"
            value={formatPrice(a.month.fees_cents, cur)}
            tone="violet"
            sub={`${formatNumber(a.month.rides)} course${a.month.rides > 1 ? "s" : ""} · ${formatPrice(a.month.received_cents, cur)} reçus`}
            icon={<TrendingUp />}
          />
        </div>

        {(a.month.zero_price_rides > 0 || a.month.cancelled_assigned_rides > 0) && (
          <p className="rounded-xl border border-amber/25 bg-amber/[0.06] px-4 py-3 text-[12.5px] text-fg-muted">
            <span className="font-medium text-amber">À surveiller ce mois-ci&nbsp;:</span>{" "}
            {[
              a.month.zero_price_rides ? zeroPriceText(a.month.zero_price_rides, org.dispatch_model) : null,
              a.month.cancelled_assigned_rides
                ? `${a.month.cancelled_assigned_rides} course${a.month.cancelled_assigned_rides > 1 ? "s" : ""} annulée${a.month.cancelled_assigned_rides > 1 ? "s" : ""} après attribution à un chauffeur${
                    onboard ? `, dont ${onboard} après la prise en charge du client (aucun frais)` : ""
                  }`
                : null,
            ]
              .filter(Boolean)
              .join(" · ")}
            .
          </p>
        )}

        {(declared.length > 0 || pending.length > 0) && (
          <section id="a-traiter" aria-label="À traiter" className="scroll-mt-6 space-y-4">
            {declared.length > 0 && <PaymentsToConfirm payments={declared} orgName={org.name} timeZone={tz} />}
            {pending.length > 0 && <PendingReductions entries={pending} orgName={org.name} timeZone={tz} />}
          </section>
        )}

        <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
          <OriginBreakdown account={a} />
          <Card>
            <CardHeader
              title="Conditions"
              icon={<CalendarClock />}
              description="Échéance de chaque frais : fin du cycle dans le fuseau de l'organisation, plus le délai."
            />
            <CardBody>
              <TermsForm orgId={orgId} cycle={a.cycle} paymentDays={a.payment_days} blockAfterDays={a.block_after_days} />
            </CardBody>
          </Card>
        </div>

        <PaymentsHistory payments={payments} orgName={org.name} currency={cur} timeZone={tz} />

        <StatementView statement={statement} months={months} basePath={basePath} />
      </PageBody>
      <PlatformLive orgs={[{ id: org.id, name: org.name }]} />
    </>
  );
}
