// Super admin, frais plateforme : sections rendues côté serveur (listes, tableau des centrales, ventilation,
// historique des paiements, relevé mensuel). Les boutons d'action sont des composants client.
import {
  ORG_STATUS_META,
  formatNumber,
  formatPrice,
  isoDayLabel,
  type AdminPlatformRow,
  type PlatformAccount,
  type PlatformEntry,
  type PlatformPayment,
  type PlatformStatement,
} from "@rydar/shared";
import { CheckCircle2, ChevronRight, CircleDollarSign, Download, HandCoins, Inbox, TrendingDown } from "lucide-react";
import Link from "next/link";
import { Badge, toneText } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/misc";
import { Table, TD, TH, THead, TR } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import {
  PLATFORM_METHOD_ICON,
  ago,
  blockInfo,
  capitalize,
  entryKindLabel,
  entryStatusMeta,
  formatDay,
  formatDayTime,
  monthLabel,
  monthSignals,
  originParts,
  overdueInfo,
  paymentStatusLabel,
  paymentTone,
  platformMethodLabel,
  rideSettlementLabel,
  ridePaymentLabel,
  signedPrice,
} from "./admin-platform-format";
import { PaymentActions, ReductionActions } from "./admin-platform-dialogs";
import { MonthSelect } from "./admin-platform-live";
import { Metric, MoneyLine } from "./admin-platform-metric";

type AccountByOrg = Map<string, Pick<PlatformAccount, "balance_cents" | "due_cents" | "currency">>;

// ---------------------------------------------------------------------------- paiements à confirmer
export function PaymentsToConfirm({
  payments,
  accounts,
  orgName,
  timeZone = "Europe/Paris",
  emptyHint,
}: {
  payments: PlatformPayment[];
  /** Vue d'ensemble : solde de chaque centrale (aide à la décision) */
  accounts?: AccountByOrg;
  /** Compte d'une centrale : nom affiché dans les dialogues (pas de colonne centrale) */
  orgName?: string;
  timeZone?: string;
  emptyHint?: string;
}) {
  const total = payments.reduce((s, p) => s + p.amount_cents, 0);
  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Paiements à confirmer"
        icon={<Inbox />}
        description={
          payments.length
            ? `${payments.length} déclaration${payments.length > 1 ? "s" : ""} « J'ai payé » · ${formatPrice(total)} au total. Vérifiez votre compte, puis confirmez le montant reçu.`
            : "Les déclarations « J'ai payé » des centrales arrivent ici."
        }
        action={
          payments.length ? (
            <Badge tone="blue" pulse>
              {payments.length} à traiter
            </Badge>
          ) : undefined
        }
      />
      {!payments.length ? (
        <p className="flex items-center gap-2 px-5 py-5 text-[13px] text-fg-muted">
          <CheckCircle2 className="size-4 text-green" /> {emptyHint ?? "Aucun paiement en attente de confirmation."}
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {payments.map((p) => {
            const Icon = PLATFORM_METHOD_ICON[p.method] ?? PLATFORM_METHOD_ICON.other;
            const name = orgName ?? p.organization_name ?? "Centrale";
            const acc = accounts?.get(p.organization_id);
            return (
              <li key={p.id} className="grid gap-3 px-5 py-4 md:grid-cols-[minmax(0,1fr)_auto_auto] md:items-center md:gap-6">
                <div className="min-w-0 space-y-1">
                  {!orgName && (
                    <Link href={`/admin/frais/${p.organization_id}`} className="text-[14px] font-medium text-fg hover:underline">
                      {name}
                    </Link>
                  )}
                  <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[12.5px] text-fg-muted">
                    <Icon className="size-3.5 shrink-0 text-fg-subtle" />
                    {platformMethodLabel(p.method)}
                    {p.paid_on && <span>· payé le {formatDay(p.paid_on)}</span>}
                    {p.reference && (
                      <span>
                        · réf. <span className="mono text-fg">{p.reference}</span>
                      </span>
                    )}
                  </p>
                  {p.note && <p className="text-[12.5px] text-fg-muted [overflow-wrap:anywhere]">«&nbsp;{p.note}&nbsp;»</p>}
                  <p className="text-[11.5px] text-fg-subtle">
                    Déclaré {p.declared_by_name ? `par ${p.declared_by_name} ` : ""}
                    {ago(p.declared_at)} ({formatDayTime(p.declared_at, timeZone)}){p.review_note ? ` · rouvert : « ${p.review_note} »` : ""}
                    {acc
                      ? ` · dû : ${formatPrice(Math.max(0, acc.balance_cents), acc.currency)}${acc.due_cents > 0 ? ` dont ${formatPrice(acc.due_cents, acc.currency)} échu` : ""}`
                      : ""}
                  </p>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-3 md:contents">
                  <p className="mono text-[22px] font-semibold tracking-tight text-blue md:text-right">{formatPrice(p.amount_cents)}</p>
                  <PaymentActions payment={p} orgName={name} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------- baisses à valider
export function PendingReductions({ entries, orgName, timeZone = "Europe/Paris" }: { entries: PlatformEntry[]; orgName?: string; timeZone?: string }) {
  const total = entries.reduce((s, e) => s + e.amount_cents, 0);
  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Baisses de frais à valider"
        icon={<TrendingDown />}
        description={
          entries.length
            ? `Prix corrigé à la baisse après la course : ${formatPrice(-total)} de frais en moins si vous acceptez tout. Refus seulement si la correction ne correspond pas à la course réellement effectuée et payée, avec un motif (affiché à l'organisation) ; sans décision dans les 30 jours, la baisse est acceptée automatiquement (CGV, article 5).`
            : "Quand une centrale ou une flotte baisse le prix d'une course terminée, la baisse de frais attend votre décision ici (30 jours au plus, puis acceptée automatiquement)."
        }
        action={entries.length ? <Badge tone="amber">{entries.length} en attente</Badge> : undefined}
      />
      {!entries.length ? (
        <p className="flex items-center gap-2 px-5 py-5 text-[13px] text-fg-muted">
          <CheckCircle2 className="size-4 text-green" /> Aucune baisse en attente.
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {entries.map((e) => {
            const name = orgName ?? e.organization_name ?? "Centrale";
            const settlement = e.ride ? rideSettlementLabel(e.ride) : null;
            return (
              <li key={e.id} className="grid gap-3 px-5 py-4 md:grid-cols-[minmax(0,1fr)_auto_auto] md:items-center md:gap-6">
                <div className="min-w-0 space-y-1">
                  <p className="text-[14px] font-medium text-fg">
                    {!orgName && (
                      <>
                        <Link href={`/admin/frais/${e.organization_id}`} className="hover:underline">
                          {name}
                        </Link>
                        <span className="text-fg-subtle"> · </span>
                      </>
                    )}
                    {e.ride ? `Course ${e.ride.number}` : e.label}
                  </p>
                  <p className="text-[12.5px] text-fg-muted">{e.reason ?? e.label}</p>
                  <p className="text-[11.5px] text-fg-subtle">
                    {e.label}
                    {e.ride ? ` · ${ridePaymentLabel(e.ride.payment_method)}` : ""}
                    {settlement ? ` · règlement chauffeur : ${settlement.toLowerCase()}` : ""}
                    {` · ${ago(e.created_at)} (${formatDayTime(e.created_at, timeZone)})`}
                  </p>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-3 md:contents">
                  <p className="mono text-[22px] font-semibold tracking-tight text-amber md:text-right">{signedPrice(e.amount_cents)}</p>
                  <ReductionActions entry={e} orgName={name} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------- tableau des centrales
function BalanceCell({ cents, currency }: { cents: number; currency: string }) {
  return (
    <span
      className={cn("mono", cents > 0 ? "text-fg" : cents < 0 ? "text-green" : "text-fg-subtle")}
      title={cents < 0 ? "Avance en faveur de l'organisation" : undefined}
    >
      {formatPrice(cents, currency)}
    </span>
  );
}

function OrgFlags({ row }: { row: AdminPlatformRow }) {
  return (
    <>
      {row.blocked && (
        <Badge tone="red" dot={false} className="h-[18px]">
          Bloquée
        </Badge>
      )}
      {row.status !== "active" && (
        <Badge tone={ORG_STATUS_META[row.status].tone} dot={false} className="h-[18px]">
          {ORG_STATUS_META[row.status].label}
        </Badge>
      )}
      {row.dispatch_model !== "centrale" && (
        <Badge tone="neutral" dot={false} className="h-[18px]">
          Flotte
        </Badge>
      )}
      {row.scheduled_change && (
        // Hausse des frais par course annoncée, pas encore appliquée
        <Badge tone="amber" dot={false} className="h-[18px]">
          Hausse le {isoDayLabel(row.scheduled_change.effective_on)}
        </Badge>
      )}
    </>
  );
}

function PendingFlags({ row }: { row: AdminPlatformRow }) {
  const parts: React.ReactNode[] = [];
  if (row.declared_count)
    parts.push(
      <span key="d" className="text-blue">
        {row.declared_count} paiement{row.declared_count > 1 ? "s" : ""} à confirmer
      </span>,
    );
  if (row.pending_reductions_count)
    parts.push(
      <span key="r" className="text-amber">
        {row.pending_reductions_count} baisse{row.pending_reductions_count > 1 ? "s" : ""} à valider
      </span>,
    );
  const signals = monthSignals(row);
  if (signals)
    parts.push(
      <span key="s" className="text-fg-muted">
        Ce mois&nbsp;: {signals}
      </span>,
    );
  if (!parts.length) return null;
  return <p className="mt-0.5 flex flex-wrap gap-x-2 text-[11.5px]">{parts}</p>;
}

export function CentralesTable({ rows }: { rows: AdminPlatformRow[] }) {
  if (!rows.length) {
    return (
      <EmptyState
        icon={<CircleDollarSign />}
        title="Aucun compte"
        description="Les frais plateforme apparaissent dès qu'un rattacheur passe en « Option 2 — Centrale », ou qu'une flotte a des frais Rydar par course (fiche du rattacheur)."
        action={
          <Link href="/admin/centrales" className="text-[13px] font-medium text-brand hover:underline">
            Voir les centrales
          </Link>
        }
      />
    );
  }
  const sum = (k: keyof AdminPlatformRow) => rows.reduce((s, r) => s + Number(r[k] ?? 0), 0);
  const monthFees = rows.reduce((s, r) => s + Number(r.month?.fees_cents ?? 0), 0);
  const balancePositive = rows.reduce((s, r) => s + Math.max(0, r.balance_cents), 0);
  return (
    <>
      {/* Mobile : cartes */}
      <ul className="divide-y divide-line md:hidden">
        {rows.map((r) => {
          const late = overdueInfo(r);
          return (
            <li key={r.id}>
              <Link href={`/admin/frais/${r.id}`} className="flex items-start gap-3 px-4 py-3.5 active:bg-white/[0.03]">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-1.5 text-[14px] font-medium text-fg">
                    <span className="truncate">{r.name}</span> <OrgFlags row={r} />
                  </p>
                  <p className="mt-0.5 text-[12px] text-fg-muted">
                    {r.due_cents > 0 ? (
                      <span className={late ? "text-red" : "text-amber"}>
                        {formatPrice(r.due_cents, r.currency)} échu{late ? ` · ${late.text}` : ""}
                      </span>
                    ) : (
                      "Rien d'échu"
                    )}
                    {r.held_by_centrale_cents > 0 && (
                      <span className="text-amber"> · {formatPrice(r.held_by_centrale_cents, r.currency)} encaissés non reversés</span>
                    )}
                  </p>
                  <PendingFlags row={r} />
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-[11px] text-fg-subtle">Solde</p>
                  <p className="text-[15px] font-semibold">
                    <BalanceCell cents={r.balance_cents} currency={r.currency} />
                  </p>
                </div>
                <ChevronRight className="mt-3 size-4 shrink-0 text-fg-subtle" />
              </Link>
            </li>
          );
        })}
      </ul>

      {/* Bureau : tableau */}
      <div className="max-md:hidden">
        <Table>
          <THead>
            <tr>
              <TH>Centrale / flotte</TH>
              <TH className="text-right">Solde</TH>
              <TH className="text-right">Échu</TH>
              <TH>En retard</TH>
              <TH className="text-right">Déclaré</TH>
              <TH
                className="text-right"
                title="Frais encaissés par l'organisation (course de flotte, course payée à la centrale ou commission reçue du chauffeur) et pas encore reversés à Rydar"
              >
                Encaissé non reversé
              </TH>
              <TH className="text-right">Chez les chauffeurs</TH>
              <TH className="text-right">Frais du mois</TH>
              <TH>Dernier paiement</TH>
              <TH>Blocage</TH>
            </tr>
          </THead>
          <tbody>
            {rows.map((r) => {
              const late = overdueInfo(r);
              const block = blockInfo(r);
              return (
                <TR key={r.id} className="relative">
                  <TD className="py-2.5">
                    <Link href={`/admin/frais/${r.id}`} className="absolute inset-0" aria-label={`Compte de ${r.name}`} />
                    <p className="flex items-center gap-1.5 whitespace-nowrap text-[13.5px] font-medium">
                      {r.name} <OrgFlags row={r} />
                    </p>
                    <p className="mono mt-0.5 text-[11.5px] text-fg-subtle">{r.reference}</p>
                    <PendingFlags row={r} />
                  </TD>
                  <TD className="whitespace-nowrap text-right text-[13.5px] font-semibold">
                    <BalanceCell cents={r.balance_cents} currency={r.currency} />
                  </TD>
                  <TD
                    className={cn(
                      "mono whitespace-nowrap text-right",
                      r.due_cents > 0 ? (late ? "font-semibold text-red" : "font-semibold text-amber") : "text-fg-subtle",
                    )}
                  >
                    {formatPrice(r.due_cents, r.currency)}
                  </TD>
                  <TD className="whitespace-nowrap">
                    {late ? (
                      <>
                        <p className="text-[12.5px] font-medium text-red">{late.text}</p>
                        <p className="text-[11.5px] text-fg-subtle">{late.since}</p>
                      </>
                    ) : (
                      <span className="text-fg-subtle">—</span>
                    )}
                  </TD>
                  <TD className={cn("mono whitespace-nowrap text-right", r.declared_cents ? "text-blue" : "text-fg-subtle")}>
                    {formatPrice(r.declared_cents, r.currency)}
                  </TD>
                  <TD className="whitespace-nowrap text-right">
                    {r.held_by_centrale_cents > 0 ? (
                      <span className="mono rounded-md bg-amber/[0.1] px-1.5 py-0.5 font-semibold text-amber">
                        {formatPrice(r.held_by_centrale_cents, r.currency)}
                      </span>
                    ) : (
                      <span className="mono text-fg-subtle">{formatPrice(0, r.currency)}</span>
                    )}
                  </TD>
                  <TD className={cn("mono whitespace-nowrap text-right", r.with_drivers_cents ? "text-fg-muted" : "text-fg-subtle")}>
                    {formatPrice(r.with_drivers_cents, r.currency)}
                  </TD>
                  <TD className="whitespace-nowrap text-right">
                    <p className="mono text-violet">{formatPrice(r.month?.fees_cents ?? 0, r.currency)}</p>
                    <p className="text-[11.5px] text-fg-subtle">
                      {formatNumber(r.month?.rides ?? 0)} course{(r.month?.rides ?? 0) > 1 ? "s" : ""}
                    </p>
                  </TD>
                  <TD className="whitespace-nowrap text-[12.5px] text-fg-muted">
                    {r.last_payment_at ? formatDay(r.last_payment_at) : <span className="text-fg-subtle">Jamais</span>}
                  </TD>
                  <TD className="whitespace-nowrap">
                    {r.blocked ? (
                      <Badge tone="red">Bloquée</Badge>
                    ) : (
                      <span
                        className={cn("text-[12.5px]", toneText[block.tone])}
                        title={r.block_suspended ? "Retard au-delà du seuil : blocage suspendu par un paiement déclaré récent" : undefined}
                      >
                        {block.text}
                      </span>
                    )}
                  </TD>
                </TR>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="border-t border-line-strong bg-white/[0.02]">
              <TD className="text-[12.5px] font-semibold text-fg-muted">
                Total · {rows.length} compte{rows.length > 1 ? "s" : ""}
              </TD>
              <TD className="mono whitespace-nowrap text-right font-semibold">{formatPrice(balancePositive)}</TD>
              <TD className={cn("mono whitespace-nowrap text-right font-semibold", sum("due_cents") ? "text-amber" : "text-fg-subtle")}>
                {formatPrice(sum("due_cents"))}
              </TD>
              <TD />
              <TD className="mono whitespace-nowrap text-right text-blue">{formatPrice(sum("declared_cents"))}</TD>
              <TD className={cn("mono whitespace-nowrap text-right font-semibold", sum("held_by_centrale_cents") ? "text-amber" : "text-fg-subtle")}>
                {formatPrice(sum("held_by_centrale_cents"))}
              </TD>
              <TD className="mono whitespace-nowrap text-right text-fg-muted">{formatPrice(sum("with_drivers_cents"))}</TD>
              <TD className="mono whitespace-nowrap text-right text-violet">{formatPrice(monthFees)}</TD>
              <TD />
              <TD />
            </tr>
          </tfoot>
        </Table>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------- d'où vient l'argent
export function OriginBreakdown({ account: a }: { account: PlatformAccount }) {
  const parts = originParts(a);
  const positive = parts.filter((p) => p.cents > 0);
  const total = Math.max(
    1,
    positive.reduce((s, p) => s + p.cents, 0),
  );
  return (
    <Card>
      <CardHeader
        title="D'où vient l'argent"
        icon={<HandCoins />}
        description={`${formatPrice(a.posted_cents, a.currency)} de frais comptabilisés depuis le début, tous dus par ${a.dispatch_model === "fleet" ? "la flotte" : "la centrale"}.`}
      />
      <div className="space-y-4 p-5">
        <div className="flex h-2.5 gap-[2px] overflow-hidden rounded-full bg-white/[0.06]" aria-hidden>
          {positive.map((p) => (
            <span key={p.key} className={cn("h-full first:rounded-l-full last:rounded-r-full", p.bar)} style={{ width: `${(p.cents / total) * 100}%` }} />
          ))}
        </div>
        <ul className="space-y-2.5">
          {parts
            .filter((p) => p.cents !== 0 || p.key !== "other")
            .map((p) => (
              <li key={p.key} className="flex items-start justify-between gap-3">
                <span className="flex min-w-0 items-start gap-2.5">
                  <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", p.bar)} />
                  <span className="min-w-0">
                    <span className="block text-[13px] text-fg">{p.label}</span>
                    <span className="block text-[11.5px] text-fg-subtle">{p.hint}</span>
                  </span>
                </span>
                <span className="shrink-0 text-right">
                  <span className={cn("mono block text-[13.5px]", p.cents ? p.text : "text-fg-subtle")}>{p.cents < 0 ? signedPrice(p.cents, a.currency) : formatPrice(p.cents, a.currency)}</span>
                  {p.cents > 0 && <span className="block text-[11px] text-fg-subtle">{formatNumber((p.cents / total) * 100)} %</span>}
                </span>
              </li>
            ))}
        </ul>
        <div className="border-t border-line pt-2">
          <MoneyLine label="Reçu par Rydar" value={formatPrice(a.received_cents, a.currency)} tone="green" />
          <MoneyLine
            label={a.dispatch_model === "fleet" ? "Encaissé par la flotte, pas encore reversé" : "Encaissé par la centrale, pas encore reversé"}
            hint="Argent déjà entre ses mains"
            value={formatPrice(a.held_by_centrale_cents, a.currency)}
            tone={a.held_by_centrale_cents > 0 ? "amber" : undefined}
            strong
          />
          {a.pending_reductions_count > 0 && (
            <MoneyLine
              label={`Baisses en attente (${a.pending_reductions_count})`}
              hint="Pas encore déduites"
              value={signedPrice(a.pending_reductions_cents, a.currency)}
              tone="amber"
            />
          )}
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------- historique des paiements
export function PaymentsHistory({
  payments,
  orgName,
  currency,
  timeZone,
}: {
  payments: PlatformPayment[];
  orgName: string;
  currency: string;
  timeZone: string;
}) {
  return (
    <Card className="overflow-hidden">
      <CardHeader title="Paiements" icon={<HandCoins />} description="Déclarés par la centrale ou saisis par Rydar, avec la décision et son auteur." />
      {!payments.length ? (
        <p className="px-5 py-6 text-[13px] text-fg-subtle">Aucun paiement pour le moment.</p>
      ) : (
        <>
          <ul className="divide-y divide-line md:hidden">
            {payments.map((p) => (
              <li key={p.id} className={cn("space-y-2 px-4 py-3.5", p.status === "cancelled" && "opacity-60")}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[13.5px] text-fg">
                      {platformMethodLabel(p.method)} · {p.paid_on ? formatDay(p.paid_on) : formatDay(p.declared_at, timeZone)}
                    </p>
                    <p className="text-[11.5px] text-fg-subtle">
                      {p.source === "admin" ? "Saisi par Rydar" : `Déclaré${p.declared_by_name ? ` par ${p.declared_by_name}` : ""}`}
                      {p.reference ? ` · ${p.reference}` : ""}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="mono text-[15px] font-semibold text-fg">{formatPrice(p.amount_cents, currency)}</p>
                    {p.received_cents != null && p.received_cents !== p.amount_cents && (
                      <p className="mono text-[11.5px] text-green">reçu {formatPrice(p.received_cents, currency)}</p>
                    )}
                  </div>
                </div>
                {(p.review_note || p.note) && <p className="text-[12px] text-fg-muted [overflow-wrap:anywhere]">«&nbsp;{p.review_note ?? p.note}&nbsp;»</p>}
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Badge tone={paymentTone(p)} pulse={p.status === "declared"}>
                    {paymentStatusLabel(p)}
                  </Badge>
                  <PaymentActions payment={p} orgName={orgName} currency={currency} size="xs" />
                </div>
              </li>
            ))}
          </ul>
          <div className="max-md:hidden">
            <Table>
              <THead>
                <tr>
                  <TH>Date</TH>
                  <TH className="text-right">Montant</TH>
                  <TH className="text-right">Reçu</TH>
                  <TH>Moyen</TH>
                  <TH>Statut</TH>
                  <TH>Décision</TH>
                  <TH className="text-right">
                    <span className="sr-only">Actions</span>
                  </TH>
                </tr>
              </THead>
              <tbody>
                {payments.map((p) => {
                  const Icon = PLATFORM_METHOD_ICON[p.method] ?? PLATFORM_METHOD_ICON.other;
                  return (
                    <TR key={p.id} className={cn(p.status === "cancelled" && "opacity-60")}>
                      <TD className="whitespace-nowrap py-2.5">
                        <p className="text-[13px]">{p.paid_on ? formatDay(p.paid_on) : formatDay(p.declared_at, timeZone)}</p>
                        <p className="text-[11.5px] text-fg-subtle">
                          {p.source === "admin" ? "Saisi par Rydar" : `Déclaré${p.declared_by_name ? ` par ${p.declared_by_name}` : ""}`} ·{" "}
                          {formatDayTime(p.declared_at, timeZone)}
                        </p>
                      </TD>
                      <TD className="mono whitespace-nowrap text-right">{formatPrice(p.amount_cents, currency)}</TD>
                      <TD className={cn("mono whitespace-nowrap text-right", p.received_cents != null ? "text-green" : "text-fg-subtle")}>
                        {p.received_cents != null ? formatPrice(p.received_cents, currency) : "—"}
                      </TD>
                      <TD className="whitespace-nowrap">
                        <p className="flex items-center gap-1.5 text-[12.5px] text-fg-muted">
                          <Icon className="size-3.5 text-fg-subtle" /> {platformMethodLabel(p.method)}
                        </p>
                        {p.reference && <p className="mono max-w-[180px] truncate text-[11.5px] text-fg-subtle">{p.reference}</p>}
                      </TD>
                      <TD className="whitespace-nowrap">
                        <Badge tone={paymentTone(p)} pulse={p.status === "declared"}>
                          {paymentStatusLabel(p)}
                        </Badge>
                      </TD>
                      <TD className="min-w-[200px] max-w-[320px] py-2.5 text-[12px] text-fg-muted">
                        {p.reviewed_at ? (
                          <>
                            <p>
                              {p.reviewed_by_name ?? "Rydar"} · {formatDayTime(p.reviewed_at, timeZone)}
                            </p>
                            {p.review_note && <p className="text-fg-subtle [overflow-wrap:anywhere]">«&nbsp;{p.review_note}&nbsp;»</p>}
                          </>
                        ) : p.status === "declared" && p.review_note ? (
                          <p className="text-fg-subtle [overflow-wrap:anywhere]">Rouvert&nbsp;: «&nbsp;{p.review_note}&nbsp;»</p>
                        ) : p.note ? (
                          <p className="text-fg-subtle [overflow-wrap:anywhere]">«&nbsp;{p.note}&nbsp;»</p>
                        ) : (
                          <span className="text-fg-subtle">—</span>
                        )}
                      </TD>
                      <TD className="whitespace-nowrap text-right">
                        <PaymentActions payment={p} orgName={orgName} currency={currency} size="xs" className="justify-end" />
                      </TD>
                    </TR>
                  );
                })}
              </tbody>
            </Table>
          </div>
        </>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------- relevé mensuel
export function StatementView({ statement: s, months, basePath }: { statement: PlatformStatement; months: string[]; basePath: string }) {
  const tz = s.organization.timezone;
  const cur = s.organization.currency;
  const options = months.includes(s.month) ? months : [s.month, ...months];
  const monthPayments = s.payments;
  return (
    <Card className="overflow-hidden">
      <CardHeader
        title={`Relevé · ${capitalize(monthLabel(s.month))}`}
        icon={<CircleDollarSign />}
        description="Chaque course, correction, avoir et paiement du mois (fuseau de l'organisation)."
        className="flex-wrap"
        action={
          <div className="flex flex-wrap items-center gap-2">
            <MonthSelect months={options} value={s.month} basePath={basePath} />
            <Button asChild variant="outline" size="sm">
              <a href={`${basePath}/export?mois=${s.month}`} download>
                <Download /> Exporter CSV
              </a>
            </Button>
          </div>
        }
      />
      <div className="grid grid-cols-2 gap-3 border-b border-line p-5 lg:grid-cols-4">
        <Metric label="Solde d'ouverture" value={formatPrice(s.opening_cents, cur)} sub={`au 1er ${monthLabel(s.month)}`} />
        <Metric
          label="Frais du mois"
          value={formatPrice(s.fees_cents, cur)}
          tone="violet"
          sub={(() => {
            const n = s.entries.filter((e) => e.kind === "ride").length;
            return `${formatNumber(n)} course${n > 1 ? "s" : ""}`;
          })()}
        />
        <Metric label="Reçu dans le mois" value={formatPrice(s.received_cents, cur)} tone="green" />
        <Metric
          label="Solde de clôture"
          value={formatPrice(s.closing_cents, cur)}
          tone={s.closing_cents > 0 ? "amber" : "green"}
          sub={s.month === months[0] ? "à ce jour" : "fin du mois"}
        />
      </div>

      {!s.entries.length ? (
        <p className="px-5 py-6 text-[13px] text-fg-subtle">Aucune écriture ce mois-ci.</p>
      ) : (
        <>
          <ul className="divide-y divide-line/70 md:hidden">
            {s.entries.map((e) => {
              const meta = entryStatusMeta(e);
              const settlement = e.ride ? rideSettlementLabel(e.ride) : null;
              return (
                <li key={e.id} className={cn("flex items-start justify-between gap-3 px-4 py-2.5", e.status === "rejected" && "opacity-60")}>
                  <div className="min-w-0">
                    <p className="text-[13px] text-fg">
                      {e.ride ? `Course ${e.ride.number}` : entryKindLabel(e)}
                      {e.kind !== "ride" && e.ride && <span className="text-fg-subtle"> · {entryKindLabel(e).toLowerCase()}</span>}
                      <span className="text-fg-subtle"> · {formatDayTime(e.occurred_at, tz)}</span>
                    </p>
                    <p className="truncate text-[11.5px] text-fg-subtle">
                      {e.ride
                        ? [e.kind === "ride" ? null : e.reason, formatPrice(e.ride.price_cents, cur), ridePaymentLabel(e.ride.payment_method), settlement]
                            .filter(Boolean)
                            .join(" · ")
                        : (e.reason ?? e.label)}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p
                      className={cn(
                        "mono text-[13px]",
                        e.amount_cents < 0 ? "text-green" : "text-fg",
                        e.status !== "posted" && "line-through decoration-fg-subtle/60",
                      )}
                    >
                      {signedPrice(e.amount_cents, cur)}
                    </p>
                    {e.status !== "posted" && <p className={cn("text-[11px]", toneText[meta.tone])}>{meta.label}</p>}
                  </div>
                </li>
              );
            })}
          </ul>
          <div className="max-md:hidden">
            <Table>
              <THead>
                <tr>
                  <TH>Date</TH>
                  <TH>Écriture</TH>
                  <TH className="text-right">Prix</TH>
                  <TH>Encaissement</TH>
                  <TH>Règlement chauffeur</TH>
                  <TH className="text-right">Montant</TH>
                  <TH>Statut</TH>
                </tr>
              </THead>
              <tbody>
                {s.entries.map((e) => {
                  const meta = entryStatusMeta(e);
                  const settlement = e.ride ? rideSettlementLabel(e.ride) : null;
                  return (
                    <TR key={e.id} className={cn("[&>td]:h-12", e.status === "rejected" && "opacity-60")}>
                      <TD className="whitespace-nowrap py-2 text-[12.5px] text-fg-muted">{formatDayTime(e.occurred_at, tz)}</TD>
                      <TD className="min-w-[220px] py-2">
                        <p className="text-[13px] text-fg">
                          {e.ride ? `Course ${e.ride.number}` : entryKindLabel(e)}
                          {e.kind !== "ride" && e.ride && <span className="text-fg-subtle"> · {entryKindLabel(e).toLowerCase()}</span>}
                        </p>
                        <p className="max-w-[360px] truncate text-[11.5px] text-fg-subtle" title={e.reason ?? e.label}>
                          {e.kind === "ride" && e.ride
                            ? e.ride.pickup && e.ride.dropoff
                              ? `${e.ride.pickup} → ${e.ride.dropoff}`
                              : e.label
                            : (e.reason ?? e.label)}
                        </p>
                        {e.review_note && <p className="text-[11.5px] text-fg-subtle">Décision&nbsp;: «&nbsp;{e.review_note}&nbsp;»</p>}
                      </TD>
                      <TD className="mono whitespace-nowrap text-right text-fg-muted">{e.ride ? formatPrice(e.ride.price_cents, cur) : "—"}</TD>
                      <TD className="whitespace-nowrap text-[12.5px] text-fg-muted">{e.ride ? ridePaymentLabel(e.ride.payment_method) : "—"}</TD>
                      <TD className="whitespace-nowrap text-[12.5px] text-fg-muted">{settlement ?? "—"}</TD>
                      <TD
                        className={cn(
                          "mono whitespace-nowrap text-right",
                          e.amount_cents < 0 ? "text-green" : "text-fg",
                          e.status !== "posted" && "line-through decoration-fg-subtle/60",
                        )}
                      >
                        {signedPrice(e.amount_cents, cur)}
                      </TD>
                      <TD className="whitespace-nowrap">
                        {e.status === "posted" ? (
                          <span className="text-[12px] text-fg-subtle">{meta.label}</span>
                        ) : (
                          <Badge tone={meta.tone}>{meta.label}</Badge>
                        )}
                      </TD>
                    </TR>
                  );
                })}
              </tbody>
            </Table>
          </div>
        </>
      )}

      {monthPayments.length > 0 && (
        <div className="border-t border-line">
          <p className="px-5 pb-1 pt-4 text-[12.5px] font-medium text-fg-muted">Paiements du mois</p>
          <ul className="divide-y divide-line/70">
            {monthPayments.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-5 py-2.5">
                <span className="min-w-0 text-[12.5px] text-fg-muted">
                  {formatDayTime(p.reviewed_at ?? p.declared_at, tz)} · {platformMethodLabel(p.method)}
                  {p.reference ? <span className="mono"> · {p.reference}</span> : null}
                </span>
                <span className="flex items-center gap-3">
                  <Badge tone={paymentTone(p)}>{paymentStatusLabel(p)}</Badge>
                  <span className={cn("mono text-[13px]", p.status === "confirmed" ? "text-green" : "text-fg-subtle")}>
                    {p.status === "confirmed" && p.received_cents != null ? `−${formatPrice(p.received_cents, cur)}` : formatPrice(p.amount_cents, cur)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
