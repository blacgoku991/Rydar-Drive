"use client";
// Carte « Frais Rydar » (owner / admin) : tête de la page Encaissements d'une centrale, page « Frais Rydar » d'une flotte
// ou d'une Flotte Privée. Une bande qui montre sans rien déplier ce que promet l'article 5 des CGV : taux, montant
// principal (pay-now.ts : la même phrase que le bandeau et la fenêtre « J'ai payé »), échéance, solde, hausse annoncée
// et sa date d'effet (20260924006600), lien vers le relevé. Le détail (chiffres du mois, d'où vient l'argent d'une
// centrale, historique des paiements) est replié, ouvert d'office quand Rydar a suspendu la création de courses.
// « J'ai payé » ouvre la déclaration ; seul Rydar confirme la réception.
import { formatNumber, formatPrice, type OrgPlatformAccount, type PlatformAccount } from "@rydar/shared";
import { BellRing, CalendarClock, FileText, Landmark, Lock, Send } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { PlatformPayDialog } from "@/components/platform-fees/org-pay-dialog";
import { PlatformPaymentHistory } from "@/components/platform-fees/org-payment-history";
import { ago, cycleText, feeTermsText, isRecentReminder, price, scheduledFeeChangeText } from "@/components/platform-fees/org-platform-format";
import { PayNowLine } from "@/components/platform-fees/org-platform-ui";
import { payNowDetails, payNowSummary } from "@/components/platform-fees/pay-now";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card } from "@/components/ui/card";
import { CopyButton } from "@/components/ui/copy-button";
import { Disclosure } from "@/components/ui/disclosure";
import { useNow } from "@/hooks/use-now";
import { upperFirst } from "@/lib/wording";
import { cn } from "@/lib/utils";

export type PlatformAccountData = Extract<OrgPlatformAccount, { enabled: true }>;

const NB = " ";
const days = (n: number) => `${n} jour${n > 1 ? "s" : ""}`;

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
  const pay = payNowSummary(a, now, tz);
  const reminder = isRecentReminder(a, now);
  const fleet = (data.organization.dispatch_model ?? a.dispatch_model) === "fleet";
  const upcoming = scheduledFeeChangeText(a, fleet ? "fleet" : "centrale", tz);
  // Avant le blocage : délai restant (seuil choisi par Rydar, en jours de retard)
  const blockLeft = a.block_after_days != null && !a.blocked && pay.kind === "now" ? a.block_after_days - a.days_overdue : null;
  const smallLine = [
    payNowDetails(pay),
    blockLeft != null && blockLeft > 0 ? `création de courses suspendue dans ${days(blockLeft)} sans règlement` : null,
  ].filter(Boolean);

  return (
    <section id="frais-plateforme" aria-labelledby="frais-plateforme-title" className="scroll-mt-6">
      <Card className={cn("overflow-hidden", pay.tone === "red" && "border-red/35")}>
        {/* ------------------------------------------------------------ nom, taux, actions */}
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3 px-4 pt-4 sm:px-5">
          <div className="flex min-w-0 flex-1 basis-[min(100%,16rem)] items-start gap-3">
            <span aria-hidden className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-lg bg-white/[0.05] text-fg-muted">
              <Landmark className="size-[18px]" />
            </span>
            <div className="min-w-0">
              <h2 id="frais-plateforme-title" className="text-[15px] font-semibold tracking-tight text-fg">
                Frais Rydar
              </h2>
              <p className="mt-0.5 text-[13px] text-fg-muted">{upperFirst(feeTermsText(a))}</p>
            </div>
          </div>
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
            <Button asChild variant="outline" size="sm" className="flex-1 max-sm:h-11 sm:flex-none">
              <Link href={statementHref} prefetch={false}>
                <FileText /> Relevé
              </Link>
            </Button>
            <Button variant={pay.kind === "nothing" ? "secondary" : "primary"} size="sm" onClick={() => setPayOpen(true)} className="flex-1 max-sm:h-11 sm:flex-none">
              <Send /> J&apos;ai payé
            </Button>
          </div>
        </div>

        {/* ------------------------------------------------------------ montant principal, échéance, solde */}
        <div className="px-4 pb-4 pt-3 sm:px-5">
          <PayNowLine pay={pay} />
          {smallLine.length > 0 && <p className="mt-1 text-[13px] leading-5 text-fg-muted">{smallLine.join(" · ")}</p>}
        </div>

        {/* ------------------------------------------------------------ blocage, relance, hausse annoncée */}
        {(a.blocked || reminder || upcoming) && (
          <div className="space-y-2 px-4 pb-4 sm:px-5">
            {a.blocked && (
              <Callout tone="danger" icon={<Lock />} title="Création de courses suspendue par Rydar">
                {formatPrice(a.due_cents, cur)} de frais sont en retard depuis {days(a.days_overdue)}. Réglez-les puis déclarez le paiement{NB}: la
                création de courses reprend dès que votre déclaration couvre le montant échu.
              </Callout>
            )}
            {reminder && (
              <Callout tone="info" icon={<BellRing />} title={`Rydar vous a relancé ${ago(a.reminded_at, now)}`}>
                {a.reminder_note ? <>«{NB}{a.reminder_note}{NB}»</> : "Merci de régler vos frais Rydar."}
              </Callout>
            )}
            {/* Hausse des frais par course annoncée (au moins 30 jours à l'avance), pas encore appliquée */}
            {upcoming && (
              <Callout tone="warning" icon={<CalendarClock />} title={upcoming.title}>
                {upcoming.body}
              </Callout>
            )}
          </div>
        )}

        {/* ------------------------------------------------------------ détail replié */}
        <Disclosure
          title="Détail : chiffres du mois et paiements à Rydar"
          forceOpen={a.blocked}
          className="border-t border-line"
          summaryClassName="px-4 sm:px-5"
        >
          <AccountDetail data={data} now={now} fleet={fleet} />
        </Disclosure>
      </Card>

      <PlatformPayDialog open={payOpen} onOpenChange={setPayOpen} pay={data.pay} account={a} currency={cur} timeZone={tz} />
    </section>
  );
}

// ---------------------------------------------------------------------------- détail
function AccountDetail({ data, now, fleet }: { data: PlatformAccountData; now: number; fleet: boolean }) {
  const a = data.account;
  const tz = data.organization.timezone || "Europe/Paris";
  const cur = a.currency || "EUR";
  return (
    <div className="pb-2">
      <p className="px-4 pb-3 text-[13px] text-fg-muted sm:px-5">
        {cycleText(a)}
        {a.block_after_days != null ? ` · création de courses suspendue après ${days(a.block_after_days)} de retard` : ""}.
      </p>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-4 border-t border-line px-4 py-4 sm:px-5 lg:grid-cols-4">
        <Figure label="Solde" value={formatPrice(a.balance_cents, cur)} sub={a.balance_cents < 0 ? "d'avance en votre faveur" : "frais comptés moins paiements reçus"} />
        <Figure
          label="Déclaré, en attente"
          value={formatPrice(a.declared_cents, cur)}
          sub={a.declared_count > 0 ? `${a.declared_count} paiement${a.declared_count > 1 ? "s" : ""} à confirmer par Rydar` : "aucun paiement en attente"}
        />
        <Figure
          label="Reçu par Rydar ce mois"
          value={formatPrice(a.month.received_cents, cur)}
          sub={a.last_payment_at ? `dernier paiement confirmé ${ago(a.last_payment_at, now)}` : "aucun paiement confirmé"}
        />
        <Figure
          label="Frais du mois"
          value={formatPrice(a.month.fees_cents, cur)}
          sub={`${formatNumber(a.month.rides)} course${a.month.rides > 1 ? "s" : ""} terminée${a.month.rides > 1 ? "s" : ""}`}
        />
      </dl>

      {/* D'où vient l'argent (centrale) : frais dus même si le chauffeur n'a pas encore payé sa commission */}
      {!fleet && <MoneyOrigin a={a} currency={cur} />}

      {a.pending_reductions_count > 0 && (
        <p className="border-t border-line px-4 py-3 text-[13px] leading-5 text-fg-muted sm:px-5">
          {a.pending_reductions_count === 1 ? "1 baisse de frais" : `${a.pending_reductions_count} baisses de frais`} ({price(a.pending_reductions_cents, cur)})
          après correction d&apos;un prix{NB}: en attente de l&apos;accord de Rydar, {a.pending_reductions_count === 1 ? "elle ne compte" : "elles ne comptent"} pas
          encore dans le solde.
        </p>
      )}

      <div className="border-t border-line">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 pb-1 pt-4 sm:px-5">
          <h3 className="text-[14px] font-semibold tracking-tight">Vos paiements à Rydar</h3>
          <p className="flex flex-wrap items-center gap-x-1.5 text-[13px] text-fg-muted">
            Référence à indiquer <span className="mono font-semibold text-fg">{a.reference}</span>
            <CopyButton value={a.reference} what="la référence" variant="ghost" size="xs" />
          </p>
        </div>
        <PlatformPaymentHistory payments={data.payments} currency={cur} timeZone={tz} now={now} />
      </div>
    </div>
  );
}

function Figure({ label, value, sub }: { label: string; value: string; sub?: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[13px] text-fg-muted">{label}</dt>
      <dd className="mt-1 text-[20px] font-semibold leading-tight tabular-nums tracking-tight text-fg">{value}</dd>
      {sub && <dd className="mt-1 text-[12px] leading-[18px] text-fg-muted">{sub}</dd>}
    </div>
  );
}

const ORIGIN = [
  { key: "collected_by_centrale_cents", label: "Déjà encaissé par vous", hint: "courses payées à la centrale, commissions reçues" },
  { key: "with_drivers_cents", label: "Commissions pas encore reçues", hint: "courses payées au chauffeur : frais dus quand même" },
  { key: "waived_by_centrale_cents", label: "Commissions annulées", hint: "restent dues à Rydar" },
] as const;

/** Frais comptabilisés des courses, selon où se trouve l'argent aujourd'hui (centrale). */
function MoneyOrigin({ a, currency }: { a: PlatformAccount; currency: string }) {
  const total = ORIGIN.reduce((n, o) => n + Math.max(0, a[o.key]), 0);
  if (total <= 0) return null;
  return (
    <div className="border-t border-line px-4 py-4 sm:px-5">
      <h3 className="text-[14px] font-semibold tracking-tight">Vos frais selon l&apos;encaissement des courses</h3>
      <p className="mt-1 text-[13px] text-fg-muted">
        Vos frais Rydar sont dus dès la fin de chaque course, même si le chauffeur ne vous a pas encore payé. Depuis le début{NB}:{" "}
        <span className="mono text-fg">{formatPrice(total, currency)}</span> de frais de courses.
      </p>
      <ul className="mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-3">
        {ORIGIN.map((o) => (
          <li key={o.key} className="min-w-0">
            <p className="text-[13px] text-fg">
              {o.label} <span className="mono font-semibold">{formatPrice(a[o.key], currency)}</span>
            </p>
            <p className="text-[12px] text-fg-muted">{o.hint}</p>
          </li>
        ))}
      </ul>
      {a.held_by_centrale_cents > 0 && (
        <p className="mt-3 rounded-lg bg-white/[0.03] px-3 py-2 text-[13px] text-fg-muted">
          Vous détenez déjà <span className="mono font-semibold text-fg">{formatPrice(a.held_by_centrale_cents, currency)}</span> encaissés qui reviennent à
          Rydar.
        </p>
      )}
    </div>
  );
}
