// Super admin, frais Rydar (« frais plateforme » des CGV) : sections rendues côté serveur (à traiter, comptes des
// clients, ventilation, historique des paiements, relevé mensuel). Les boutons d'action sont des composants client.
// Couleur réservée à ce qui demande une action (docs/REFONTE-PANELS.md § 3.3) : rouge = retard ou blocage, ambre = à
// confirmer ou à décider ; les autres montants restent neutres.
import {
  ORG_STATUS_META,
  formatNumber,
  formatPrice,
  legalDateLabel,
  type AdminPlatformRow,
  type PlatformAccount,
  type PlatformEntry,
  type PlatformPayment,
  type PlatformStatement,
} from "@rydar/shared";
import { CheckCircle2, ChevronRight, CircleDollarSign, Download, HandCoins, Inbox, TrendingDown } from "lucide-react";
import Link from "next/link";
import { CLIENT_KIND_META, clientKind } from "@/components/admin/platform-data";
import { Badge, toneText } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Disclosure } from "@/components/ui/disclosure";
import { EmptyState } from "@/components/ui/misc";
import { DesktopTable, MobileList, Table, TD, TH, THead, TR } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { plural } from "@/lib/wording";
import {
  NETWORK_CONTEST_NOTE,
  PLATFORM_METHOD_ICON,
  STATEMENT_FIRST_LINES,
  ago,
  balanceLabel,
  blockInfo,
  capitalize,
  entryKindLabel,
  entryStatusMeta,
  formatDay,
  formatDayTime,
  isNetworkContest,
  monthLabel,
  monthSignals,
  moreLinesLabel,
  overdueInfo,
  paymentStatusLabel,
  paymentTone,
  pendingReductionsDescription,
  platformMethodLabel,
  rideSettlementLabel,
  ridePaymentLabel,
  signedPrice,
  visibleOriginParts,
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
  /** Vue d'ensemble : solde de chaque client (aide à la décision) */
  accounts?: AccountByOrg;
  /** Compte d'un client : nom affiché dans les fenêtres (pas de colonne client) */
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
            ? `${plural(payments.length, "déclaration")} « J'ai payé » · ${formatPrice(total)} au total. Vérifiez votre compte, puis confirmez le montant reçu.`
            : "Les déclarations « J'ai payé » de vos clients arrivent ici."
        }
        action={payments.length ? <Badge tone="amber">{payments.length} à traiter</Badge> : undefined}
      />
      {!payments.length ? (
        <p className="flex items-center gap-2 px-5 py-5 text-[13px] text-fg-muted">
          <CheckCircle2 aria-hidden className="size-4 text-green" /> {emptyHint ?? "Aucun paiement en attente de confirmation."}
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {payments.map((p) => {
            const Icon = PLATFORM_METHOD_ICON[p.method] ?? PLATFORM_METHOD_ICON.other;
            const name = orgName ?? p.organization_name ?? "Client";
            const acc = accounts?.get(p.organization_id);
            return (
              <li key={p.id} className="grid gap-3 px-5 py-4 md:grid-cols-[minmax(0,1fr)_auto_auto] md:items-center md:gap-6">
                <div className="min-w-0 space-y-1">
                  {!orgName && (
                    <Link href={`/admin/frais/${p.organization_id}`} prefetch={false} className="text-[14px] font-medium text-fg hover:underline">
                      {name}
                    </Link>
                  )}
                  <p className="text-[13px] text-fg-muted">
                    <Icon aria-hidden className="mr-1.5 inline size-3.5 align-[-2px] text-fg-subtle" />
                    {platformMethodLabel(p.method)}
                    {p.paid_on && ` · payé le ${formatDay(p.paid_on)}`}
                    {p.reference && (
                      <>
                        {" · réf.\u00a0"}
                        <span className="mono whitespace-nowrap text-fg">{p.reference}</span>
                      </>
                    )}
                  </p>
                  {p.note && <p className="text-[13px] text-fg-muted [overflow-wrap:anywhere]">«&nbsp;{p.note}&nbsp;»</p>}
                  <p className="text-[12px] text-fg-muted">
                    Déclaré {p.declared_by_name ? `par ${p.declared_by_name} ` : ""}
                    {ago(p.declared_at)} ({formatDayTime(p.declared_at, timeZone)}){p.review_note ? ` · rouvert : « ${p.review_note} »` : ""}
                    {acc
                      ? ` · dû : ${formatPrice(Math.max(0, acc.balance_cents), acc.currency)}${acc.due_cents > 0 ? `, dont ${formatPrice(acc.due_cents, acc.currency)} en retard` : ""}`
                      : ""}
                  </p>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-3 md:contents">
                  <p className="mono text-[22px] font-semibold tracking-tight text-fg md:text-right">{formatPrice(p.amount_cents)}</p>
                  <PaymentActions payment={p} orgName={name} className="max-sm:[&_button]:min-h-11" />
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
  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Baisses de frais à valider"
        icon={<TrendingDown />}
        description={pendingReductionsDescription(entries)}
        action={entries.length ? <Badge tone="amber">{entries.length} en attente</Badge> : undefined}
      />
      {!entries.length ? (
        <p className="flex items-center gap-2 px-5 py-5 text-[13px] text-fg-muted">
          <CheckCircle2 aria-hidden className="size-4 text-green" /> Aucune baisse en attente.
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {entries.map((e) => {
            const name = orgName ?? e.organization_name ?? "Client";
            const settlement = e.ride ? rideSettlementLabel(e.ride) : null;
            // Réseau partagé : baisse demandée en contestant une course partagée, jamais acceptée automatiquement
            const contest = isNetworkContest(e);
            return (
              <li key={e.id} className="grid gap-3 px-5 py-4 md:grid-cols-[minmax(0,1fr)_auto_auto] md:items-center md:gap-6">
                <div className="min-w-0 space-y-1">
                  <p className="text-[14px] font-medium text-fg">
                    {!orgName && (
                      <>
                        <Link href={`/admin/frais/${e.organization_id}`} prefetch={false} className="hover:underline">
                          {name}
                        </Link>
                        <span className="text-fg-subtle"> · </span>
                      </>
                    )}
                    {e.ride ? `Course ${e.ride.number}` : e.label}
                  </p>
                  {contest && (
                    <p className="flex flex-wrap items-center gap-2 text-[12px] text-fg-muted">
                      <Badge tone="violet" dot={false}>
                        Réseau partagé
                      </Badge>
                      {NETWORK_CONTEST_NOTE}
                    </p>
                  )}
                  <p className="text-[13px] text-fg-muted">{e.reason ?? e.label}</p>
                  <p className="text-[12px] text-fg-muted">
                    {e.label}
                    {e.ride ? ` · ${ridePaymentLabel(e.ride.payment_method)}` : ""}
                    {settlement ? ` · règlement chauffeur : ${settlement.toLowerCase()}` : ""}
                    {` · ${ago(e.created_at)} (${formatDayTime(e.created_at, timeZone)})`}
                  </p>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-3 md:contents">
                  <p className="mono text-[22px] font-semibold tracking-tight text-fg md:text-right">{signedPrice(e.amount_cents)}</p>
                  {/* Cibles de 44 px au toucher (les fenêtres, rendues hors de ce bloc, ne sont pas concernées) */}
                  <div className="max-sm:[&_button]:min-h-11">
                    <ReductionActions entry={e} orgName={name} />
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------- comptes des clients
function BalanceCell({ cents, currency }: { cents: number; currency: string }) {
  return (
    <span className={cn("mono", cents > 0 ? "text-fg" : cents < 0 ? "text-green" : "text-fg-subtle")} title={cents < 0 ? "Avance du client" : undefined}>
      {formatPrice(cents, currency)}
    </span>
  );
}

/** Type du client (Flotte, Centrale à commission, Flotte Privée), statut s'il n'est pas actif, blocage, hausse annoncée. */
function OrgFlags({ row, privateFleet }: { row: AdminPlatformRow; privateFleet: boolean }) {
  const kind = CLIENT_KIND_META[clientKind({ dispatch_model: row.dispatch_model, private_fleet: privateFleet })];
  return (
    <>
      <Badge tone={kind.tone} dot={false}>
        {kind.label}
      </Badge>
      {row.blocked && (
        <Badge tone="red" dot={false}>
          Bloquée
        </Badge>
      )}
      {row.status !== "active" && (
        <Badge tone={ORG_STATUS_META[row.status].tone} dot={false}>
          {ORG_STATUS_META[row.status].label}
        </Badge>
      )}
      {row.scheduled_change && (
        // Hausse des frais par course annoncée, pas encore appliquée
        <Badge tone="neutral" dot={false}>
          Hausse le {legalDateLabel(row.scheduled_change.effective_on)}
        </Badge>
      )}
    </>
  );
}

function PendingFlags({ row }: { row: AdminPlatformRow }) {
  const parts: React.ReactNode[] = [];
  if (row.declared_count)
    parts.push(
      <span key="d" className="text-amber">
        {plural(row.declared_count, "paiement à confirmer", "paiements à confirmer")}
      </span>,
    );
  if (row.pending_reductions_count)
    parts.push(
      <span key="r" className="text-amber">
        {plural(row.pending_reductions_count, "baisse à valider", "baisses à valider")}
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
  return <p className="mt-0.5 flex flex-wrap gap-x-2 text-[12px]">{parts}</p>;
}

/**
 * Comptes des clients (flottes et centrales qui ont des frais Rydar ou un historique) : cartes sous 768 px, tableau
 * au-delà ; une ligne ouvre le compte et son relevé. `privateIds` : clients Flotte Privée (badge de type).
 */
export function AccountsTable({ rows, privateIds }: { rows: AdminPlatformRow[]; privateIds: ReadonlySet<string> }) {
  if (!rows.length) {
    return (
      <EmptyState
        size="compact"
        icon={<CircleDollarSign />}
        title="Aucun client n'a de frais Rydar."
        description="Ils apparaissent ici dès qu'un client passe en centrale à commission, ou qu'une flotte a des frais par course (depuis sa fiche)."
        action={
          <Link href="/admin/organizations" prefetch={false} className="inline-flex min-h-11 items-center text-[13px] font-medium text-brand hover:underline sm:min-h-0">
            Voir les clients
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
      <MobileList>
        {rows.map((r) => {
          const late = overdueInfo(r);
          return (
            <li key={r.id}>
              <Link href={`/admin/frais/${r.id}`} prefetch={false} className="flex items-start gap-3 px-4 py-3.5 transition-colors hover:bg-white/[0.03]">
                <div className="min-w-0 flex-1">
                  <p className="text-[14px] font-medium text-fg [overflow-wrap:anywhere]">{r.name}</p>
                  <p className="mt-1 flex flex-wrap gap-1.5">
                    <OrgFlags row={r} privateFleet={privateIds.has(r.id)} />
                  </p>
                  <p className="mt-1 text-[13px] text-fg-muted">
                    {r.due_cents > 0 ? (
                      <span className="text-red">
                        {formatPrice(r.due_cents, r.currency)} en retard{late ? ` ${late.since}` : ""}
                      </span>
                    ) : (
                      "Rien en retard"
                    )}
                    {r.held_by_centrale_cents > 0 && <span> · {formatPrice(r.held_by_centrale_cents, r.currency)} encaissés, pas encore réglés</span>}
                  </p>
                  <PendingFlags row={r} />
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-[12px] text-fg-muted">Solde</p>
                  <p className="text-[15px] font-semibold">
                    <BalanceCell cents={r.balance_cents} currency={r.currency} />
                  </p>
                </div>
                <ChevronRight aria-hidden className="mt-3 size-4 shrink-0 text-fg-subtle" />
              </Link>
            </li>
          );
        })}
      </MobileList>

      <DesktopTable>
        <Table>
          <THead>
            <tr>
              <TH>Client</TH>
              <TH className="text-right">Solde</TH>
              <TH>En retard</TH>
              <TH className="text-right">À confirmer</TH>
              <TH
                className="text-right"
                title="Frais encaissés par le client (course de flotte, course payée à la centrale ou commission reçue du chauffeur) et pas encore réglés à Rydar"
              >
                Encaissé non réglé
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
                    <Link href={`/admin/frais/${r.id}`} prefetch={false} className="absolute inset-0" aria-label={`Compte de ${r.name}`} />
                    <p className="flex flex-wrap items-center gap-1.5 text-[13.5px] font-medium">
                      <span className="whitespace-nowrap">{r.name}</span> <OrgFlags row={r} privateFleet={privateIds.has(r.id)} />
                    </p>
                    <p className="mono mt-0.5 text-[12px] text-fg-muted">{r.reference}</p>
                    <PendingFlags row={r} />
                  </TD>
                  <TD className="whitespace-nowrap text-right text-[13.5px] font-semibold">
                    <BalanceCell cents={r.balance_cents} currency={r.currency} />
                  </TD>
                  <TD className="whitespace-nowrap">
                    {r.due_cents > 0 ? (
                      <>
                        <p className="mono font-semibold text-red">{formatPrice(r.due_cents, r.currency)}</p>
                        {late && (
                          <p className="text-[12px] text-fg-muted" title={late.since}>
                            {late.text}
                          </p>
                        )}
                      </>
                    ) : (
                      <span className="text-fg-subtle">—</span>
                    )}
                  </TD>
                  <TD className={cn("mono whitespace-nowrap text-right", r.declared_cents ? "text-amber" : "text-fg-subtle")}>
                    {formatPrice(r.declared_cents, r.currency)}
                  </TD>
                  <TD className={cn("mono whitespace-nowrap text-right", r.held_by_centrale_cents > 0 ? "text-fg" : "text-fg-subtle")}>
                    {formatPrice(r.held_by_centrale_cents, r.currency)}
                  </TD>
                  <TD className={cn("mono whitespace-nowrap text-right", r.with_drivers_cents ? "text-fg-muted" : "text-fg-subtle")}>
                    {formatPrice(r.with_drivers_cents, r.currency)}
                  </TD>
                  <TD className="whitespace-nowrap text-right">
                    <p className="mono text-fg">{formatPrice(r.month?.fees_cents ?? 0, r.currency)}</p>
                    <p className="text-[12px] text-fg-muted">{plural(r.month?.rides ?? 0, "course")}</p>
                  </TD>
                  <TD className="whitespace-nowrap text-[13px] text-fg-muted">{r.last_payment_at ? formatDay(r.last_payment_at) : "Jamais"}</TD>
                  <TD className="whitespace-nowrap">
                    {r.blocked ? (
                      <Badge tone="red">Bloquée</Badge>
                    ) : (
                      <span
                        className={cn("text-[13px]", toneText[block.tone])}
                        title={r.block_suspended ? "Retard au-delà du seuil : blocage suspendu par un paiement déclaré récent" : undefined}
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
              <TD className="text-[13px] font-semibold text-fg-muted">Total · {plural(rows.length, "client")}</TD>
              <TD className="mono whitespace-nowrap text-right font-semibold">{formatPrice(balancePositive)}</TD>
              <TD className={cn("mono whitespace-nowrap font-semibold", sum("due_cents") ? "text-red" : "text-fg-subtle")}>{formatPrice(sum("due_cents"))}</TD>
              <TD className={cn("mono whitespace-nowrap text-right", sum("declared_cents") ? "text-amber" : "text-fg-subtle")}>{formatPrice(sum("declared_cents"))}</TD>
              <TD className="mono whitespace-nowrap text-right font-semibold">{formatPrice(sum("held_by_centrale_cents"))}</TD>
              <TD className="mono whitespace-nowrap text-right text-fg-muted">{formatPrice(sum("with_drivers_cents"))}</TD>
              <TD className="mono whitespace-nowrap text-right">{formatPrice(monthFees)}</TD>
              <TD />
              <TD />
            </tr>
          </tfoot>
        </Table>
      </DesktopTable>
    </>
  );
}

// ---------------------------------------------------------------------------- d'où vient l'argent
export function OriginBreakdown({ account: a }: { account: PlatformAccount }) {
  const parts = visibleOriginParts(a);
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
          {parts.map((p) => (
            <li key={p.key} className="flex items-start justify-between gap-3">
              <span className="flex min-w-0 items-start gap-2.5">
                <span aria-hidden className={cn("mt-1.5 size-2 shrink-0 rounded-full", p.bar)} />
                <span className="min-w-0">
                  <span className="block text-[13px] text-fg">{p.label}</span>
                  <span className="block text-[12px] text-fg-muted">{p.hint}</span>
                </span>
              </span>
              <span className="shrink-0 text-right">
                <span className={cn("mono block text-[13.5px]", p.cents ? "text-fg" : "text-fg-subtle")}>
                  {p.cents < 0 ? signedPrice(p.cents, a.currency) : formatPrice(p.cents, a.currency)}
                </span>
                {p.cents > 0 && <span className="block text-[12px] text-fg-muted">{formatNumber((p.cents / total) * 100)}&nbsp;%</span>}
              </span>
            </li>
          ))}
        </ul>
        <div className="border-t border-line pt-2">
          <MoneyLine label="Reçu par Rydar" value={formatPrice(a.received_cents, a.currency)} />
          <MoneyLine
            label={a.dispatch_model === "fleet" ? "Encaissé par la flotte, pas encore réglé" : "Encaissé par la centrale, pas encore réglé"}
            hint="Argent déjà entre ses mains"
            value={formatPrice(a.held_by_centrale_cents, a.currency)}
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
      <CardHeader title="Paiements" icon={<HandCoins />} description="Déclarés par le client ou saisis par Rydar, avec la décision et son auteur." />
      {!payments.length ? (
        <EmptyState size="compact" title="Aucun paiement pour le moment." />
      ) : (
        <>
          <MobileList>
            {payments.map((p) => (
              <li key={p.id} className="space-y-2 px-4 py-3.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[13.5px] text-fg">
                      {platformMethodLabel(p.method)} · {p.paid_on ? formatDay(p.paid_on) : formatDay(p.declared_at, timeZone)}
                    </p>
                    <p className="text-[12px] text-fg-muted">
                      {p.source === "admin" ? "Saisi par Rydar" : `Déclaré${p.declared_by_name ? ` par ${p.declared_by_name}` : ""}`}
                      {p.reference && (
                        <>
                          {" · "}
                          <span className="whitespace-nowrap">{p.reference}</span>
                        </>
                      )}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="mono text-[15px] font-semibold text-fg">{formatPrice(p.amount_cents, currency)}</p>
                    {p.received_cents != null && p.received_cents !== p.amount_cents && (
                      <p className="mono text-[12px] text-fg-muted">reçu {formatPrice(p.received_cents, currency)}</p>
                    )}
                  </div>
                </div>
                {(p.review_note || p.note) && <p className="text-[12px] text-fg-muted [overflow-wrap:anywhere]">«&nbsp;{p.review_note ?? p.note}&nbsp;»</p>}
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Badge tone={paymentTone(p)}>{paymentStatusLabel(p)}</Badge>
                  <PaymentActions payment={p} orgName={orgName} currency={currency} size="sm" className="[&_button]:min-h-11" />
                </div>
              </li>
            ))}
          </MobileList>
          <DesktopTable>
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
                    <TR key={p.id}>
                      <TD className="whitespace-nowrap py-2.5">
                        <p className="text-[13px]">{p.paid_on ? formatDay(p.paid_on) : formatDay(p.declared_at, timeZone)}</p>
                        <p className="text-[12px] text-fg-muted">
                          {p.source === "admin" ? "Saisi par Rydar" : `Déclaré${p.declared_by_name ? ` par ${p.declared_by_name}` : ""}`} ·{" "}
                          {formatDayTime(p.declared_at, timeZone)}
                        </p>
                      </TD>
                      <TD className="mono whitespace-nowrap text-right">{formatPrice(p.amount_cents, currency)}</TD>
                      <TD className={cn("mono whitespace-nowrap text-right", p.received_cents != null ? "text-fg" : "text-fg-subtle")}>
                        {p.received_cents != null ? formatPrice(p.received_cents, currency) : "—"}
                      </TD>
                      <TD className="whitespace-nowrap">
                        <p className="flex items-center gap-1.5 text-[13px] text-fg-muted">
                          <Icon aria-hidden className="size-3.5 text-fg-subtle" /> {platformMethodLabel(p.method)}
                        </p>
                        {p.reference && (
                          <p className="mono max-w-[180px] truncate text-[12px] text-fg-muted" title={p.reference}>
                            {p.reference}
                          </p>
                        )}
                      </TD>
                      <TD className="whitespace-nowrap">
                        <Badge tone={paymentTone(p)}>{paymentStatusLabel(p)}</Badge>
                      </TD>
                      <TD className="min-w-[200px] max-w-[320px] py-2.5 text-[12.5px] text-fg-muted">
                        {p.reviewed_at ? (
                          <>
                            <p>
                              {p.reviewed_by_name ?? "Rydar"} · {formatDayTime(p.reviewed_at, timeZone)}
                            </p>
                            {p.review_note && <p className="[overflow-wrap:anywhere]">«&nbsp;{p.review_note}&nbsp;»</p>}
                          </>
                        ) : p.status === "declared" && p.review_note ? (
                          <p className="[overflow-wrap:anywhere]">Rouvert&nbsp;: «&nbsp;{p.review_note}&nbsp;»</p>
                        ) : p.note ? (
                          <p className="[overflow-wrap:anywhere]">«&nbsp;{p.note}&nbsp;»</p>
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
          </DesktopTable>
        </>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------- relevé mensuel
type StatementEntry = PlatformStatement["entries"][number];

/** Lignes du relevé sur téléphone (cartes). */
function StatementCards({ entries, tz, cur }: { entries: StatementEntry[]; tz: string; cur: string }) {
  return (
    <MobileList>
      {entries.map((e) => {
        const meta = entryStatusMeta(e);
        const settlement = e.ride ? rideSettlementLabel(e.ride) : null;
        const detail = e.ride
          ? [e.kind === "ride" ? null : e.reason, formatPrice(e.ride.price_cents, cur), ridePaymentLabel(e.ride.payment_method), settlement]
              .filter(Boolean)
              .join(" · ")
          : (e.reason ?? e.label);
        return (
          <li key={e.id} className="flex items-start justify-between gap-3 px-4 py-2.5">
            <div className="min-w-0">
              <p className="text-[13px] text-fg">
                {e.ride ? `Course ${e.ride.number}` : entryKindLabel(e)}
                {e.kind !== "ride" && e.ride && <span className="text-fg-muted"> · {entryKindLabel(e).toLowerCase()}</span>}
                <span className="text-fg-muted"> · {formatDayTime(e.occurred_at, tz)}</span>
              </p>
              <p className="truncate text-[12px] text-fg-muted" title={detail}>
                {detail}
              </p>
            </div>
            <div className="shrink-0 text-right">
              <p
                className={cn(
                  "mono text-[13px]",
                  e.amount_cents < 0 ? "text-green" : "text-fg",
                  e.status !== "posted" && "line-through decoration-fg-subtle",
                )}
              >
                {signedPrice(e.amount_cents, cur)}
              </p>
              {e.status !== "posted" && <p className={cn("text-[12px]", toneText[meta.tone])}>{meta.label}</p>}
            </div>
          </li>
        );
      })}
    </MobileList>
  );
}

/**
 * Lignes du relevé sur grand écran (tableau). Disposition fixe et largeurs de colonnes communes : les lignes repliées
 * (« Afficher les N autres lignes ») forment un second tableau aligné sur le premier.
 */
function StatementTable({ entries, tz, cur, head = true }: { entries: StatementEntry[]; tz: string; cur: string; head?: boolean }) {
  return (
    <Table className="min-w-[940px] table-fixed">
      <colgroup>
        <col className="w-[112px]" />
        <col />
        <col className="w-[92px]" />
        <col className="w-[136px]" />
        <col className="w-[176px]" />
        <col className="w-[96px]" />
        <col className="w-[132px]" />
      </colgroup>
      {/* Second tableau (lignes repliées) : en-têtes lus par les lecteurs d'écran, pas affichés une seconde fois */}
      <THead className={head ? undefined : "border-0"}>
        <tr className={head ? undefined : "sr-only"}>
          <TH>Date</TH>
          <TH>Détail</TH>
          <TH className="text-right">Prix</TH>
          <TH>Encaissement</TH>
          <TH>Règlement chauffeur</TH>
          <TH className="text-right">Montant</TH>
          <TH>Statut</TH>
        </tr>
      </THead>
      <tbody>
        {entries.map((e) => {
          const meta = entryStatusMeta(e);
          const settlement = e.ride ? rideSettlementLabel(e.ride) : null;
          const detail = e.kind === "ride" && e.ride ? (e.ride.pickup && e.ride.dropoff ? `${e.ride.pickup} → ${e.ride.dropoff}` : e.label) : (e.reason ?? e.label);
          return (
            <TR key={e.id} className="[&>td]:h-12">
              <TD className="whitespace-nowrap py-2 text-[13px] text-fg-muted">{formatDayTime(e.occurred_at, tz)}</TD>
              <TD className="py-2">
                <p className="truncate text-[13px] text-fg">
                  {e.ride ? `Course ${e.ride.number}` : entryKindLabel(e)}
                  {e.kind !== "ride" && e.ride && <span className="text-fg-muted"> · {entryKindLabel(e).toLowerCase()}</span>}
                </p>
                <p className="truncate text-[12px] text-fg-muted" title={e.reason ?? detail}>
                  {detail}
                </p>
                {e.review_note && (
                  <p className="truncate text-[12px] text-fg-muted" title={e.review_note}>
                    Décision&nbsp;: «&nbsp;{e.review_note}&nbsp;»
                  </p>
                )}
              </TD>
              <TD className="mono whitespace-nowrap text-right text-fg-muted">{e.ride ? formatPrice(e.ride.price_cents, cur) : "—"}</TD>
              <TD className="truncate whitespace-nowrap text-[13px] text-fg-muted">{e.ride ? ridePaymentLabel(e.ride.payment_method) : "—"}</TD>
              <TD className="truncate whitespace-nowrap text-[13px] text-fg-muted">{settlement ?? "—"}</TD>
              <TD
                className={cn(
                  "mono whitespace-nowrap text-right",
                  e.amount_cents < 0 ? "text-green" : "text-fg",
                  e.status !== "posted" && "line-through decoration-fg-subtle",
                )}
              >
                {signedPrice(e.amount_cents, cur)}
              </TD>
              <TD className="whitespace-nowrap">
                {e.status === "posted" ? <span className="text-[12px] text-fg-muted">{meta.label}</span> : <Badge tone={meta.tone}>{meta.label}</Badge>}
              </TD>
            </TR>
          );
        })}
      </tbody>
    </Table>
  );
}

/**
 * Relevé mensuel d'un client : quatre chiffres, les 15 premières lignes du mois, les suivantes dans un repli, puis les
 * paiements du mois. Mois (MonthSelect) et export CSV inchangés.
 */
export function StatementView({ statement: s, months, basePath }: { statement: PlatformStatement; months: string[]; basePath: string }) {
  const tz = s.organization.timezone;
  const cur = s.organization.currency;
  const options = months.includes(s.month) ? months : [s.month, ...months];
  const monthPayments = s.payments;
  const label = monthLabel(s.month);
  const rides = s.entries.filter((e) => e.kind === "ride").length;
  const first = s.entries.slice(0, STATEMENT_FIRST_LINES);
  const rest = s.entries.slice(STATEMENT_FIRST_LINES);
  return (
    <Card className="overflow-hidden">
      <CardHeader
        title={`Relevé · ${capitalize(label)}`}
        icon={<CircleDollarSign />}
        description="Chaque course, correction, avoir et paiement du mois (fuseau du client)."
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
      <div className="grid grid-cols-2 gap-3 border-b border-line p-4 sm:p-5 lg:grid-cols-4">
        <Metric label={balanceLabel(s.opening_cents, `au 1er ${label}`)} value={formatPrice(Math.abs(s.opening_cents), cur)} />
        <Metric label="Frais du mois" value={formatPrice(s.fees_cents, cur)} sub={plural(rides, "course")} />
        <Metric label="Reçu dans le mois" value={formatPrice(s.received_cents, cur)} />
        <Metric
          label={balanceLabel(s.closing_cents, s.month === months[0] ? "à ce jour" : `fin ${label}`)}
          value={formatPrice(Math.abs(s.closing_cents), cur)}
        />
      </div>

      {!s.entries.length ? (
        <EmptyState size="compact" title="Aucun frais ce mois-ci." />
      ) : (
        <>
          <StatementCards entries={first} tz={tz} cur={cur} />
          <DesktopTable>
            <StatementTable entries={first} tz={tz} cur={cur} />
          </DesktopTable>
          {rest.length > 0 && (
            <Disclosure
              title={moreLinesLabel(rest.length)}
              className="border-t border-line"
              summaryClassName="px-4 text-[13px] text-fg-muted hover:text-fg sm:px-5"
            >
              <StatementCards entries={rest} tz={tz} cur={cur} />
              <DesktopTable>
                <StatementTable entries={rest} tz={tz} cur={cur} head={false} />
              </DesktopTable>
            </Disclosure>
          )}
        </>
      )}

      {monthPayments.length > 0 && (
        <div className="border-t border-line">
          <h3 className="px-5 pb-1 pt-4 text-[13px] font-medium text-fg-muted">Paiements du mois</h3>
          <ul className="divide-y divide-line/70">
            {monthPayments.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-5 py-2.5">
                <span className="min-w-0 text-[13px] text-fg-muted">
                  {formatDayTime(p.reviewed_at ?? p.declared_at, tz)} · {platformMethodLabel(p.method)}
                  {p.reference ? (
                    <>
                      {" · "}
                      <span className="mono whitespace-nowrap">{p.reference}</span>
                    </>
                  ) : null}
                </span>
                <span className="flex items-center gap-3">
                  <Badge tone={paymentTone(p)}>{paymentStatusLabel(p)}</Badge>
                  <span className={cn("mono text-[13px]", p.status === "confirmed" ? "text-green" : "text-fg-muted")}>
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
