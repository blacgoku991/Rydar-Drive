"use client";
// Carte « Frais plateforme Rydar » (owner / admin ; tête de la page Encaissements d'une centrale, page « Frais Rydar »
// d'une flotte) : ce que l'organisation doit reverser à Rydar, l'échéance, les paiements déclarés et reçus, d'où vient
// l'argent (centrale seulement : une flotte n'a ni commission ni règlement chauffeur), les relances et le blocage
// éventuel, la hausse des frais par course annoncée (« À partir du JJ/MM/AAAA », 20260924006600). « J'ai payé » ouvre la
// déclaration ; seul Rydar confirme la réception.
import { formatNumber, formatPrice, platformDueSummary, type OrgPlatformAccount, type PlatformAccount } from "@rydar/shared";
import { BellRing, CalendarClock, FileText, Landmark, Lock, Send, TrendingDown } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { PlatformPayDialog } from "@/components/platform-fees/org-pay-dialog";
import { PlatformPaymentHistory } from "@/components/platform-fees/org-payment-history";
import { ago, cycleText, feeTermsText, isRecentReminder, price, scheduledFeeChangeText } from "@/components/platform-fees/org-platform-format";
import { CopyButton } from "@/components/platform-fees/org-platform-ui";
import { toneText } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useNow } from "@/hooks/use-now";
import { cn } from "@/lib/utils";

export type PlatformAccountData = Extract<OrgPlatformAccount, { enabled: true }>;

/** Montant restant après confirmation des paiements déclarés. */
export const remainingAfterDeclared = (a: Pick<PlatformAccount, "balance_cents" | "declared_cents">) => Math.max(0, a.balance_cents - a.declared_cents);

/** Couleur du solde : rouge en retard / bloqué, ambre s'il reste à payer, vert sinon. */
export function balanceTone(a: Pick<PlatformAccount, "balance_cents" | "due_cents" | "overdue_since" | "blocked">) {
  if (a.blocked || (a.due_cents > 0 && a.overdue_since)) return "red" as const;
  if (a.balance_cents > 0) return "amber" as const;
  return "green" as const;
}

export function OrgPlatformCard({
  data,
  serverNow,
  statementHref = "/dashboard/settlements/rydar",
}: {
  data: PlatformAccountData;
  serverNow: number;
  statementHref?: string;
}) {
  const now = useNow(60_000) ?? serverNow;
  const [payOpen, setPayOpen] = useState(false);
  const a = data.account;
  const tz = data.organization.timezone || "Europe/Paris";
  const cur = a.currency || "EUR";
  const due = platformDueSummary(a, tz);
  const tone = balanceTone(a);
  const remaining = remainingAfterDeclared(a);
  const reminder = isRecentReminder(a, now);
  const mustPay = a.balance_cents > 0 && remaining > 0;
  const fleet = (data.organization.dispatch_model ?? a.dispatch_model) === "fleet";
  const upcoming = scheduledFeeChangeText(a, fleet ? "fleet" : "centrale", tz);

  return (
    <section id="frais-plateforme" aria-labelledby="frais-plateforme-title" className="scroll-mt-6">
      <Card className={cn("overflow-hidden", tone === "red" && "border-red/35")}>
        {/* ------------------------------------------------------------ en-tête */}
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3 border-b border-line px-5 py-4">
          <div className="flex min-w-0 items-start gap-3">
            <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-lg bg-violet/[0.1] text-violet">
              <Landmark className="size-[18px]" />
            </span>
            <div className="min-w-0">
              <h2 id="frais-plateforme-title" className="text-[15px] font-semibold tracking-tight text-fg">
                Frais plateforme Rydar
              </h2>
              <p className="mt-0.5 text-[12.5px] text-fg-muted">
                À reverser à Rydar : {feeTermsText(a)}. {cycleText(a)}.
              </p>
            </div>
          </div>
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
            <Button asChild variant="outline" size="sm" className="flex-1 sm:flex-none">
              <Link href={statementHref} prefetch={false}>
                <FileText /> Relevé mensuel
              </Link>
            </Button>
            <Button variant={mustPay ? "primary" : "secondary"} size="sm" onClick={() => setPayOpen(true)} className="flex-1 sm:flex-none">
              <Send /> J&apos;ai payé
            </Button>
          </div>
        </div>

        {/* ------------------------------------------------------------ blocage, relance */}
        {a.blocked && (
          <Notice tone="red" icon={<Lock />} title="Création de courses suspendue par Rydar">
            {formatPrice(a.due_cents, cur)} de frais sont en retard depuis {a.days_overdue} jour{a.days_overdue > 1 ? "s" : ""}. Réglez-les puis déclarez le
            paiement : la création de courses reprend dès que votre déclaration couvre le montant échu.
          </Notice>
        )}
        {reminder && (
          <Notice tone="blue" icon={<BellRing />} title={`Rydar vous a relancé ${ago(a.reminded_at, now)}`}>
            {a.reminder_note ? <>«&nbsp;{a.reminder_note}&nbsp;»</> : "Merci de régler vos frais plateforme."}
          </Notice>
        )}
        {/* Hausse des frais par course annoncée (au moins 30 jours à l'avance), pas encore appliquée */}
        {upcoming && (
          <Notice tone="amber" icon={<CalendarClock />} title={upcoming.title}>
            {upcoming.body}
          </Notice>
        )}

        {/* ------------------------------------------------------------ chiffres */}
        <div className="grid grid-cols-2 gap-x-6 gap-y-5 px-5 py-5 lg:grid-cols-4">
          <Figure
            label="À reverser à Rydar"
            value={formatPrice(Math.max(0, a.balance_cents), cur)}
            valueClass={cn("text-[26px] sm:text-[28px]", toneText[tone])}
            sub={
              <>
                <span className={cn("font-medium", toneText[due.tone])}>{due.text}</span>
                {a.due_cents > 0 && a.balance_cents > a.due_cents && <span> · dont {formatPrice(a.due_cents, cur)} échus</span>}
                {a.balance_cents < 0 && <span> · {formatPrice(-a.balance_cents, cur)} d&apos;avance</span>}
                {a.block_after_days != null && !a.blocked && a.due_cents > 0 && a.overdue_since && (
                  <span className="block text-fg-muted">
                    Création de courses suspendue après {a.block_after_days} jour{a.block_after_days > 1 ? "s" : ""} de retard
                  </span>
                )}
              </>
            }
          />
          <Figure
            label="Déclaré, en attente"
            value={formatPrice(a.declared_cents, cur)}
            valueClass={a.declared_cents > 0 ? "text-blue" : "text-fg-subtle"}
            sub={
              a.declared_count > 0 ? (
                <>
                  {a.declared_count} paiement{a.declared_count > 1 ? "s" : ""} à confirmer par Rydar
                  {a.balance_cents > 0 && <span className="block">Restera ensuite : {formatPrice(remaining, cur)}</span>}
                </>
              ) : (
                "aucun paiement en attente"
              )
            }
          />
          <Figure
            label="Reçu par Rydar ce mois"
            value={formatPrice(a.month.received_cents, cur)}
            valueClass={a.month.received_cents > 0 ? "text-green" : "text-fg-subtle"}
            sub={a.last_payment_at ? `dernier paiement confirmé ${ago(a.last_payment_at, now)}` : "aucun paiement confirmé"}
          />
          <Figure
            label="Frais du mois"
            value={formatPrice(a.month.fees_cents, cur)}
            sub={`${formatNumber(a.month.rides)} course${a.month.rides > 1 ? "s" : ""} terminée${a.month.rides > 1 ? "s" : ""}`}
          />
        </div>

        {/* ------------------------------------------------------------ d'où vient l'argent (centrale) */}
        {!fleet && <MoneyOrigin a={a} currency={cur} />}

        {a.pending_reductions_count > 0 && (
          <p className="flex items-start gap-2 border-t border-line px-5 py-3 text-[12.5px] leading-5 text-amber">
            <TrendingDown className="mt-0.5 size-4 shrink-0" />
            <span>
              {a.pending_reductions_count === 1 ? "1 baisse de frais" : `${a.pending_reductions_count} baisses de frais`} (
              {price(a.pending_reductions_cents, cur)}) après correction d&apos;un prix : en attente de l&apos;accord de Rydar,{" "}
              {a.pending_reductions_count === 1 ? "elle ne compte" : "elles ne comptent"} pas encore dans le solde.
            </span>
          </p>
        )}

        {/* ------------------------------------------------------------ paiements */}
        <div className="border-t border-line">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-5 pb-1 pt-4">
            <h3 className="text-[13.5px] font-semibold tracking-tight">Vos paiements à Rydar</h3>
            <p className="flex items-center gap-1.5 whitespace-nowrap text-[12px] text-fg-muted">
              Référence à indiquer <span className="mono font-semibold text-fg">{a.reference}</span>
              <CopyButton value={a.reference} label="Référence" />
            </p>
          </div>
          <PlatformPaymentHistory payments={data.payments} currency={cur} timeZone={tz} now={now} />
        </div>
      </Card>

      <PlatformPayDialog open={payOpen} onOpenChange={setPayOpen} pay={data.pay} currency={cur} timeZone={tz} declaredCents={a.declared_cents} />
    </section>
  );
}

// ---------------------------------------------------------------------------- éléments
function Figure({ label, value, sub, valueClass }: { label: string; value: string; sub?: React.ReactNode; valueClass?: string }) {
  return (
    <div className="min-w-0">
      <p className="truncate text-[12.5px] text-fg-muted">{label}</p>
      <p className={cn("mono mt-1 truncate text-[22px] font-semibold leading-tight tracking-tight text-fg", valueClass)}>{value}</p>
      {sub && <div className="mt-1 text-[12px] leading-[18px] text-fg-muted">{sub}</div>}
    </div>
  );
}

export function Notice({ tone, icon, title, children }: { tone: "red" | "blue" | "amber"; icon: React.ReactNode; title: string; children?: React.ReactNode }) {
  const styles = { red: "bg-red/[0.07] text-red", blue: "bg-blue/[0.07] text-blue", amber: "bg-amber/[0.07] text-amber" }[tone];
  return (
    <div className={cn("flex items-start gap-3 border-b border-line px-5 py-3", styles)} role={tone === "red" ? "alert" : "status"}>
      <span className="mt-0.5 shrink-0 [&_svg]:size-4">{icon}</span>
      <div className="min-w-0 text-[12.5px] leading-5">
        <p className="font-semibold">{title}</p>
        {children && <p className="text-fg-muted">{children}</p>}
      </div>
    </div>
  );
}

const ORIGIN = [
  {
    key: "collected_by_centrale_cents",
    label: "Déjà encaissé par vous",
    hint: "courses payées à la centrale, commissions reçues",
    bar: "bg-green",
    dot: "bg-green",
  },
  { key: "with_drivers_cents", label: "Encore chez les chauffeurs", hint: "commissions pas encore réglées", bar: "bg-amber", dot: "bg-amber" },
  { key: "waived_by_centrale_cents", label: "Dettes chauffeurs annulées", hint: "restent dues à Rydar", bar: "bg-red", dot: "bg-red" },
] as const;

/** Frais comptabilisés des courses, selon où se trouve l'argent aujourd'hui. */
function MoneyOrigin({ a, currency }: { a: PlatformAccount; currency: string }) {
  const total = ORIGIN.reduce((n, o) => n + Math.max(0, a[o.key]), 0);
  if (total <= 0) return null;
  return (
    <div className="border-t border-line px-5 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="text-[13.5px] font-semibold tracking-tight">D&apos;où vient cet argent</h3>
        <p className="text-[12px] text-fg-muted">
          sur <span className="mono text-fg">{formatPrice(total, currency)}</span> de frais de courses depuis le début
        </p>
      </div>
      <p className="mt-1 text-[12.5px] text-fg">Vos frais plateforme sont dus dès la fin de chaque course, que le chauffeur vous ait payé ou non.</p>
      <div className="mt-3 flex h-2 gap-[2px] overflow-hidden rounded-full bg-white/[0.06]" aria-hidden>
        {ORIGIN.filter((o) => a[o.key] > 0).map((o) => (
          <span key={o.key} className={cn("h-full first:rounded-l-full last:rounded-r-full", o.bar)} style={{ width: `${(a[o.key] / total) * 100}%` }} />
        ))}
      </div>
      <ul className="mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-3">
        {ORIGIN.map((o) => (
          <li key={o.key} className="flex min-w-0 items-start gap-2">
            <span className={cn("mt-[7px] size-1.5 shrink-0 rounded-full", o.dot)} />
            <div className="min-w-0">
              <p className="text-[12.5px] text-fg">
                {o.label} <span className="mono font-semibold">{formatPrice(a[o.key], currency)}</span>
              </p>
              <p className="text-[12px] text-fg-muted">{o.hint}</p>
            </div>
          </li>
        ))}
      </ul>
      {a.held_by_centrale_cents > 0 && (
        <p className="mt-3 rounded-lg bg-white/[0.03] px-3 py-2 text-[12.5px] text-fg-muted">
          Vous détenez déjà <span className="mono font-semibold text-fg">{formatPrice(a.held_by_centrale_cents, currency)}</span> encaissés qui reviennent à
          Rydar.
        </p>
      )}
    </div>
  );
}
