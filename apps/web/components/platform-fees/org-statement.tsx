// Relevé mensuel des frais plateforme (côté centrale ou flotte) : solde d'ouverture, frais du mois, reçu par Rydar,
// solde de clôture, chaque écriture (course, correction, avoir) et chaque paiement. Rendu serveur. Flotte : pas de
// colonne « règlement chauffeur » (aucune commission), sauf course passée par le mode centrale.
import {
  PAYMENT_METHOD_LABELS,
  PLATFORM_ENTRY_KIND_META,
  platformEntryStatusMeta,
  PLATFORM_PAYMENT_STATUS_META,
  formatPrice,
  type PlatformEntry,
  type PlatformPayment,
  type PlatformStatement,
} from "@rydar/shared";
import { ArrowRight, ReceiptText } from "lucide-react";
import Link from "next/link";
import {
  dayTime, platformMethodLabel, price, rideSettlementText, shortDay, showSettlementColumn, signedPrice,
} from "@/components/platform-fees/org-platform-format";
import { Badge, toneText } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/misc";
import { TD, TH, THead, TR, Table } from "@/components/ui/table";
import { cn } from "@/lib/utils";

/** « septembre 2026 » */
export function monthLabel(month: string, style: "long" | "short" = "long") {
  return new Intl.DateTimeFormat("fr-FR", { month: style, year: "numeric", timeZone: "UTC" }).format(new Date(`${month}-01T12:00:00Z`));
}

/** Libellé d'une écriture : « Course », « Correction », « Avoir », « Frais ajoutés ». */
function kindLabel(e: PlatformEntry) {
  if (e.kind === "adjustment") return e.amount_cents < 0 ? "Avoir de Rydar" : "Frais ajoutés par Rydar";
  if (e.kind === "ride") return "Frais de course";
  return PLATFORM_ENTRY_KIND_META[e.kind].label;
}

/** Règlement chauffeur lié à la course (commission encaissée par la centrale, ou course payée à la centrale). */
function settlementText(e: PlatformEntry): { text: string; tone: string } | null {
  const st = rideSettlementText(e.ride);
  return st ? { text: st.text, tone: toneText[st.tone] } : null;
}

function amountClass(e: PlatformEntry) {
  if (e.status === "rejected") return "text-fg-subtle line-through";
  if (e.status === "pending") return "text-amber";
  if (e.amount_cents < 0) return "text-green";
  return "text-fg";
}

function EntryStatus({ e }: { e: PlatformEntry }) {
  if (e.status === "posted") return null;
  const meta = platformEntryStatusMeta(e);
  return <Badge tone={meta.tone}>{e.status === "pending" ? "En attente de Rydar" : meta.label}</Badge>;
}

function EntryText({ e, timeZone }: { e: PlatformEntry; timeZone: string }) {
  return (
    <div className="min-w-0">
      <p className="text-[13px] font-medium text-fg">{e.label}</p>
      <p className="text-[12px] text-fg-muted">
        {kindLabel(e)}
        {e.kind === "adjustment" && e.created_by_name ? ` · ${e.created_by_name}` : ""}
        {e.status !== "rejected" ? ` · échéance ${shortDay(e.due_at, timeZone)}` : ""}
      </p>
      {e.reason && <p className="mt-0.5 text-[12px] text-fg-muted">{e.reason}</p>}
      {e.status === "pending" && <p className="mt-0.5 text-[12px] text-amber">Ne compte pas tant que Rydar ne l&apos;a pas acceptée.</p>}
      {e.review_note && <p className="mt-0.5 text-[12px] text-fg-muted">Rydar&nbsp;: «&nbsp;{e.review_note}&nbsp;»</p>}
    </div>
  );
}

function RideCell({ e, currency }: { e: PlatformEntry; currency: string }) {
  const r = e.ride;
  if (!r) return <span className="text-[12px] text-fg-muted">{e.kind === "adjustment" ? "—" : "Course supprimée"}</span>;
  return (
    <div className="min-w-0">
      <p className="flex items-baseline gap-2 text-[13px]">
        <Link href={`/dashboard/rides/${r.id}`} prefetch={false} className="mono font-semibold text-fg hover:text-brand">
          #{r.number}
        </Link>
        <span className="mono text-fg">{formatPrice(r.price_cents, currency)}</span>
        <span className="truncate text-[12px] text-fg-muted">{PAYMENT_METHOD_LABELS[r.payment_method] ?? r.payment_method}</span>
      </p>
      <p className="truncate text-[12px] text-fg-muted" title={`${r.pickup ?? ""} → ${r.dropoff ?? ""}`}>
        {r.pickup ?? "—"} <ArrowRight className="inline size-3 -translate-y-px" /> {r.dropoff ?? "—"}
      </p>
    </div>
  );
}

export function StatementSummary({ s }: { s: PlatformStatement }) {
  const cur = s.organization.currency || "EUR";
  const items = [
    { label: "Solde d'ouverture", value: price(s.opening_cents, cur), sub: `au 1er ${monthLabel(s.month)}`, op: null, cls: "text-fg" },
    { label: "Frais du mois", value: price(s.fees_cents, cur), sub: "courses, corrections, avoirs", op: "+", cls: "text-fg" },
    { label: "Reçu par Rydar", value: price(s.received_cents, cur), sub: "paiements confirmés", op: "−", cls: s.received_cents > 0 ? "text-green" : "text-fg" },
    {
      label: "Solde de clôture",
      value: price(Math.abs(s.closing_cents), cur),
      sub: s.closing_cents > 0 ? "restant à régler" : s.closing_cents < 0 ? "d'avance en votre faveur" : "rien à régler",
      op: "=",
      cls: s.closing_cents > 0 ? "text-amber" : "text-green",
    },
  ];
  return (
    <section aria-label="Résumé du mois" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {items.map((it) => (
        <div key={it.label} className="surface relative min-w-0 rounded-xl px-4 py-3.5">
          <p className="flex items-center gap-1.5 truncate text-[12.5px] text-fg-muted">
            {it.op && (
              <span className="mono text-fg-subtle" aria-hidden>
                {it.op}
              </span>
            )}
            {it.label}
          </p>
          <p className={cn("mono mt-1.5 truncate text-[22px] font-semibold leading-none tracking-tight sm:text-[24px]", it.cls)}>{it.value}</p>
          <p className="mt-1.5 line-clamp-2 text-[12px] text-fg-muted">{it.sub}</p>
        </div>
      ))}
    </section>
  );
}

export function StatementEntries({ s }: { s: PlatformStatement }) {
  const cur = s.organization.currency || "EUR";
  const tz = s.organization.timezone || "Europe/Paris";
  const pending = s.entries.filter((e) => e.status === "pending");
  const withSettlement = showSettlementColumn(s);
  return (
    <Card className="overflow-hidden">
      <CardHeader
        title={`Écritures · ${s.entries.length}`}
        description="Une écriture par course terminée ; toute modification ultérieure du montant ajoute une correction (les baisses attendent l'accord de Rydar)."
      />
      {s.entries.length === 0 ? (
        <EmptyState
          icon={<ReceiptText />}
          title="Aucune écriture ce mois-ci"
          description="Les frais apparaissent ici à la fin de chaque course."
          className="py-10"
        />
      ) : (
        <>
          {/* Grand écran : tableau */}
          <div className="hidden lg:block">
            <Table>
              <THead>
                <tr>
                  <TH className="w-[118px]">Date</TH>
                  <TH>Libellé</TH>
                  <TH>Course</TH>
                  {withSettlement && <TH>Règlement chauffeur</TH>}
                  <TH className="text-right">Montant</TH>
                </tr>
              </THead>
              <tbody>
                {s.entries.map((e) => {
                  const st = settlementText(e);
                  return (
                    <TR key={e.id} className={cn(e.status === "pending" && "bg-amber/[0.03]")}>
                      <TD className="h-auto whitespace-nowrap py-3 align-top text-[12.5px] text-fg-muted">{dayTime(e.occurred_at, tz)}</TD>
                      <TD className="h-auto max-w-[340px] py-3 align-top">
                        <EntryText e={e} timeZone={tz} />
                      </TD>
                      <TD className="h-auto max-w-[320px] py-3 align-top">
                        <RideCell e={e} currency={cur} />
                      </TD>
                      {withSettlement && <TD className={cn("h-auto py-3 align-top text-[12.5px]", st?.tone ?? "text-fg-muted")}>{st?.text ?? "—"}</TD>}
                      <TD className="h-auto py-3 text-right align-top">
                        <p className={cn("mono whitespace-nowrap text-[14px] font-semibold", amountClass(e))}>{signedPrice(e.amount_cents, cur)}</p>
                        <div className="mt-1 flex justify-end">
                          <EntryStatus e={e} />
                        </div>
                      </TD>
                    </TR>
                  );
                })}
              </tbody>
            </Table>
          </div>
          {/* Mobile / tablette : liste */}
          <ul className="divide-y divide-line lg:hidden">
            {s.entries.map((e) => {
              const st = withSettlement ? settlementText(e) : null;
              return (
                <li key={e.id} className={cn("space-y-2 px-4 py-3.5 sm:px-5", e.status === "pending" && "bg-amber/[0.03]")}>
                  <div className="flex items-start justify-between gap-3">
                    <EntryText e={e} timeZone={tz} />
                    <div className="shrink-0 text-right">
                      <p className={cn("mono whitespace-nowrap text-[14px] font-semibold", amountClass(e))}>{signedPrice(e.amount_cents, cur)}</p>
                      <p className="text-[12px] text-fg-muted">{dayTime(e.occurred_at, tz)}</p>
                    </div>
                  </div>
                  {e.ride && <RideCell e={e} currency={cur} />}
                  {(st || e.status !== "posted") && (
                    <div className="flex flex-wrap items-center gap-2">
                      {st && <span className={cn("text-[12px]", st.tone)}>{st.text}</span>}
                      <EntryStatus e={e} />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          {pending.length > 0 && (
            <p className="border-t border-line px-5 py-3 text-[12.5px] text-amber">
              {pending.length === 1 ? "1 baisse" : `${pending.length} baisses`} en attente de Rydar (
              {price(
                pending.reduce((n, e) => n + e.amount_cents, 0),
                cur,
              )}
              ) : non comptée{pending.length > 1 ? "s" : ""} dans les totaux.
            </p>
          )}
        </>
      )}
    </Card>
  );
}

export function StatementPayments({ s }: { s: PlatformStatement }) {
  const cur = s.organization.currency || "EUR";
  const tz = s.organization.timezone || "Europe/Paris";
  return (
    <Card className="overflow-hidden">
      <CardHeader
        title={`Paiements · ${s.payments.length}`}
        description="Déclarés ou traités par Rydar ce mois-ci. Seuls les paiements confirmés (montant reçu) font baisser le solde."
      />
      {s.payments.length === 0 ? (
        <EmptyState
          icon={<ReceiptText />}
          title="Aucun paiement ce mois-ci"
          description="Vos déclarations « J'ai payé » et les paiements enregistrés par Rydar apparaîtront ici."
          className="py-10"
        />
      ) : (
        <ul className="divide-y divide-line">
          {s.payments.map((p) => (
            <PaymentLine key={p.id} p={p} currency={cur} timeZone={tz} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function PaymentLine({ p, currency, timeZone }: { p: PlatformPayment; currency: string; timeZone: string }) {
  const meta = PLATFORM_PAYMENT_STATUS_META[p.status];
  const partial = p.status === "confirmed" && p.received_cents != null && p.received_cents !== p.amount_cents;
  return (
    <li className="flex flex-col gap-2 px-4 py-3.5 sm:flex-row sm:items-start sm:justify-between sm:px-5">
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <span
            className={cn("mono text-[14px] font-semibold", p.status === "rejected" || p.status === "cancelled" ? "text-fg-muted line-through" : "text-fg")}
          >
            {formatPrice(p.amount_cents, currency)}
          </span>
          <Badge tone={meta.tone}>{p.status === "confirmed" && p.source === "admin" ? "Enregistré par Rydar" : meta.label}</Badge>
          {partial && <span className="text-[12px] text-amber">{formatPrice(p.received_cents, currency)} reçus</span>}
        </p>
        <p className="mt-0.5 text-[12px] text-fg-muted">
          {[platformMethodLabel(p.method), p.paid_on ? `payé le ${shortDay(p.paid_on, timeZone)}` : null, p.reference ? `réf. ${p.reference}` : null]
            .filter(Boolean)
            .join(" · ")}
        </p>
        {p.note && <p className="text-[12px] text-fg-muted">«&nbsp;{p.note}&nbsp;»</p>}
        {p.review_note && <p className={cn("text-[12px]", p.status === "rejected" ? "text-red" : "text-fg-muted")}>Rydar&nbsp;: «&nbsp;{p.review_note}&nbsp;»</p>}
      </div>
      <div className="shrink-0 text-[12px] text-fg-muted sm:text-right">
        <p>{p.source === "admin" ? "Saisi par Rydar" : `Déclaré le ${dayTime(p.declared_at, timeZone)}`}</p>
        {p.reviewed_at && p.status !== "cancelled" && (
          <p>
            {p.status === "confirmed" ? "Confirmé" : "Traité"} le {dayTime(p.reviewed_at, timeZone)}
          </p>
        )}
        {p.status === "cancelled" && <p>Retiré par la centrale</p>}
        {p.status === "confirmed" && (
          <p className={cn("mono font-semibold", toneText.green)}>{price(-(p.received_cents ?? p.amount_cents), currency)} sur le solde</p>
        )}
      </div>
    </li>
  );
}
