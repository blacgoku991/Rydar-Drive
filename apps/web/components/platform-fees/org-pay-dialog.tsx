"use client";
// « J'ai payé Rydar » en deux temps (docs/REFONTE-PANELS.md, R9) :
//  1. « Payer Rydar » : le montant principal (pay-now.ts : même phrase que la carte et le bandeau), « Payer en ligne »
//     (lien de Rydar, montant calculé en base) et les coordonnées bancaires dans « Payer par virement » ;
//  2. « Déclarer votre paiement » : montant prérempli, moyen, date ; référence et note repliées (ouvertes d'office en cas
//     d'erreur). declarePlatformPayment et sa validation sont inchangés ; seul Rydar confirme la réception, puis le
//     solde baisse.
import { formatIban, formatPrice, type PlatformAccount, type PlatformPayInfo, type PlatformPaymentMethod } from "@rydar/shared";
import { ArrowLeft, ExternalLink, Send } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { declarePlatformPayment } from "@/app/dashboard/settlements/platform-actions";
import { centsToEurosInput, eurosInputToCents, todayIn } from "@/components/platform-fees/org-platform-format";
import { PayNowLine, PlatformMethodPicker } from "@/components/platform-fees/org-platform-ui";
import { payLinkHint, payNowDetails, payNowSummary } from "@/components/platform-fees/pay-now";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { CopyButton } from "@/components/ui/copy-button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Disclosure } from "@/components/ui/disclosure";
import { Field, Input, Textarea } from "@/components/ui/input";
import { NewTabHint } from "@/components/ui/new-tab";
import { runAction } from "@/lib/run-action";
import { cn, submitWith } from "@/lib/utils";

const NB = " ";

/** Montants du compte utiles à la fenêtre (carte, relevé, page « Compte suspendu »). */
export type PayDialogAccount = Pick<
  PlatformAccount,
  "balance_cents" | "due_cents" | "declared_cents" | "next_due_cents" | "next_due_at" | "days_overdue" | "blocked" | "currency"
>;

export function PlatformPayDialog({
  open,
  onOpenChange,
  pay,
  account,
  currency,
  timeZone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pay: PlatformPayInfo;
  account: PayDialogAccount;
  currency: string;
  timeZone: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [step, setStep] = useState<1 | 2>(1);
  const [now, setNow] = useState(0);
  const summary = payNowSummary(account, now || Date.now(), timeZone);
  const declaredCents = Math.max(0, account.declared_cents);
  // Montant prérempli : le montant principal (le même que la carte) ; à défaut, ce que propose Rydar moins le déclaré
  const suggested = summary.amountCents ?? Math.max(0, pay.amount_cents - declaredCents);
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<PlatformPaymentMethod | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [today, setToday] = useState("");

  // Préremplissage à l'ouverture seulement : une relecture de la page (temps réel) ne doit pas écraser la saisie
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      setStep(1);
      setNow(Date.now());
      setAmount(centsToEurosInput(suggested));
      setMethod(pay.link && !pay.iban ? "link" : "transfer");
      setErrors({});
      setToday(todayIn(timeZone));
    }
    wasOpen.current = open;
  }, [open, suggested, pay.link, pay.iban, timeZone]);

  const submit = (data: FormData) => {
    const cents = eurosInputToCents(amount);
    const local: Record<string, string> = {};
    if (cents == null) local.amountCents = "Indiquez le montant payé";
    else if (!Number.isFinite(cents) || cents < 1) local.amountCents = "Saisissez un montant valide (ex. : 120 ou 120,50)";
    if (!method) local.method = "Choisissez le moyen de paiement";
    if (Object.keys(local).length) {
      setErrors(local);
      toast.error(
        local.amountCents
          ? `Montant : ${local.amountCents.charAt(0).toLowerCase()}${local.amountCents.slice(1)}`
          : `Moyen de paiement : ${local.method!.toLowerCase()}`,
      );
      return;
    }
    setErrors({});
    start(() => runAction(async () => {
      const res = await declarePlatformPayment({
        amountCents: cents!,
        method: method!,
        reference: String(data.get("reference") ?? ""),
        note: String(data.get("note") ?? ""),
        paidOn: String(data.get("paidOn") ?? ""),
      });
      if (!res.ok) {
        setErrors(res.fieldErrors ?? {});
        toast.error(res.error);
        return;
      }
      toast.success(res.message, { description: "Votre solde baissera dès que Rydar aura confirmé la réception." });
      onOpenChange(false);
      router.refresh();
    }));
  };

  const hasBank = !!(pay.iban || pay.payee_name || pay.bic);
  const linkHint = pay.link && pay.amount_cents > 0 ? payLinkHint(pay.amount_cents, summary, declaredCents, currency) : null;
  const extra = payNowDetails(summary, false);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="md"
        title="J'ai payé Rydar"
        description={`Réglez Rydar, puis déclarez votre paiement${NB}: Rydar le confirme dès réception, puis votre solde baisse.`}
      >
        <ol className="mb-4 flex flex-wrap gap-x-4 gap-y-1 text-[13px]" aria-label="Étapes">
          {(["Payer Rydar", "Déclarer votre paiement"] as const).map((label, i) => {
            const current = step === i + 1;
            return (
              <li key={label} aria-current={current ? "step" : undefined} className={cn("flex items-center gap-1.5", current ? "font-medium text-fg" : "text-fg-muted")}>
                <span
                  aria-hidden
                  className={cn(
                    "grid size-5 place-items-center rounded-full text-[12px] font-semibold",
                    current ? "bg-brand text-brand-fg" : "bg-white/[0.08] text-fg-muted",
                  )}
                >
                  {i + 1}
                </span>
                {label}
              </li>
            );
          })}
        </ol>

        {step === 1 ? (
          <div className="space-y-4">
            <div className="rounded-xl border border-line bg-white/[0.025] px-4 py-3">
              <PayNowLine pay={summary} />
              {extra && <p className="mt-1 text-[13px] text-fg-muted">{extra}</p>}
            </div>

            {pay.configured ? (
              <>
                {pay.link && pay.amount_cents > 0 && (
                  <div>
                    <Button asChild variant="outline" className="w-full sm:w-auto">
                      <a href={pay.link} target="_blank" rel="noopener noreferrer">
                        <ExternalLink /> Payer en ligne
                        <NewTabHint />
                      </a>
                    </Button>
                    {linkHint && <p className="mt-1.5 text-[13px] text-fg-muted">{linkHint}</p>}
                  </div>
                )}
                {hasBank && (
                  <Disclosure
                    title="Payer par virement"
                    defaultOpen={!pay.link}
                    className="rounded-xl border border-line"
                    summaryClassName="px-3.5"
                  >
                    <dl className="divide-y divide-line border-t border-line text-[13px]">
                      {pay.payee_name && <PayRow label="Bénéficiaire" value={pay.payee_name} />}
                      {pay.iban && <PayRow label="IBAN" value={formatIban(pay.iban)} copy={pay.iban} what="l'IBAN" mono />}
                      {pay.bic && <PayRow label="BIC" value={pay.bic} copy={pay.bic} what="le BIC" mono />}
                    </dl>
                  </Disclosure>
                )}
                <dl className="rounded-xl border border-line text-[13px]">
                  <PayRow label="Référence à indiquer" value={pay.reference} copy={pay.reference} what="la référence" mono strong />
                  {pay.instructions && (
                    <div className="border-t border-line px-3.5 py-2.5">
                      <dt className="sr-only">Instructions de Rydar</dt>
                      <dd className="whitespace-pre-line text-[13px] leading-5 text-fg-muted">{pay.instructions}</dd>
                    </div>
                  )}
                </dl>
              </>
            ) : (
              <>
                <Callout tone="warning" title="Coordonnées de paiement à demander">
                  Rydar ne vous a pas encore communiqué ses coordonnées de paiement. Contactez l&apos;équipe Rydar pour les obtenir, puis déclarez votre
                  paiement ici.
                </Callout>
                <dl className="rounded-xl border border-line text-[13px]">
                  <PayRow label="Référence à indiquer" value={pay.reference} copy={pay.reference} what="la référence" mono strong />
                </dl>
              </>
            )}

            <DialogFooter sticky>
              <Button type="button" variant="primary" onClick={() => setStep(2)}>
                <Send /> Déclarer votre paiement
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={submitWith(submit)} noValidate className="space-y-4">
            <button
              type="button"
              onClick={() => setStep(1)}
              className="-mt-1 inline-flex min-h-9 items-center gap-1.5 rounded-md text-[13px] text-fg-muted transition-colors hover:text-fg"
            >
              <ArrowLeft aria-hidden className="size-3.5" /> Revoir comment payer Rydar
            </button>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Montant payé"
                htmlFor="pf-amount"
                error={errors.amountCents}
                hint={suggested > 0 ? `Montant à régler${NB}: ${formatPrice(suggested, currency)}` : undefined}
              >
                <div className="relative">
                  <Input
                    id="pf-amount"
                    name="amount"
                    inputMode="decimal"
                    autoComplete="off"
                    value={amount}
                    onChange={(e) => {
                      setAmount(e.target.value);
                      if (errors.amountCents) setErrors(({ amountCents: _a, ...rest }) => rest);
                    }}
                    placeholder={`ex.${NB}: 120,50`}
                    aria-invalid={!!errors.amountCents || undefined}
                    className="mono pr-9 text-[15px] font-semibold"
                  />
                  <span aria-hidden className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[13px] text-fg-muted">
                    €
                  </span>
                </div>
              </Field>
              <Field label="Date du paiement" htmlFor="pf-date" error={errors.paidOn}>
                <Input
                  id="pf-date"
                  name="paidOn"
                  type="date"
                  defaultValue={today}
                  key={today}
                  max={today || undefined}
                  aria-invalid={!!errors.paidOn || undefined}
                />
              </Field>
            </div>

            <Field label="Moyen de paiement" error={errors.method}>
              <PlatformMethodPicker
                value={method}
                onChange={(m) => {
                  setMethod(m);
                  if (errors.method) setErrors(({ method: _m, ...rest }) => rest);
                }}
                invalid={!!errors.method}
              />
            </Field>

            <Disclosure
              title="Ajouter une référence ou une note"
              forceOpen={!!errors.reference || !!errors.note}
              className="rounded-xl border border-line"
              summaryClassName="px-3.5"
              contentClassName="space-y-4 border-t border-line px-3.5 pb-3.5 pt-3"
            >
              <Field
                label="Référence du paiement"
                htmlFor="pf-ref"
                optional
                error={errors.reference}
                hint="Celle indiquée sur le virement, le reçu ou le lien de paiement."
              >
                <Input id="pf-ref" name="reference" defaultValue={pay.reference} key={`${open}`} maxLength={80} autoComplete="off" className="mono" />
              </Field>
              <Field label="Note pour Rydar" htmlFor="pf-note" optional error={errors.note}>
                <Textarea id="pf-note" name="note" maxLength={500} placeholder={`ex.${NB}: virement des frais de septembre`} className="min-h-[64px]" />
              </Field>
            </Disclosure>

            <DialogFooter sticky backDisabled={pending}>
              <Button type="submit" variant="primary" loading={pending}>
                <Send /> Déclarer le paiement
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Bouton « J'ai payé » et sa fenêtre (relevé, page serveur). */
export function PlatformPayButton({
  pay,
  account,
  timeZone,
  primary = false,
  className,
}: {
  pay: PlatformPayInfo;
  account: PayDialogAccount;
  timeZone: string;
  primary?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant={primary ? "primary" : "outline"} onClick={() => setOpen(true)} className={className}>
        <Send /> J&apos;ai payé
      </Button>
      <PlatformPayDialog open={open} onOpenChange={setOpen} pay={pay} account={account} currency={account.currency || "EUR"} timeZone={timeZone} />
    </>
  );
}

function PayRow({ label, value, copy, what, mono, strong }: { label: string; value: string; copy?: string; what?: string; mono?: boolean; strong?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5 px-3.5 py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
      <dt className="shrink-0 text-[13px] text-fg-muted">{label}</dt>
      <dd className="flex min-w-0 items-center justify-between gap-1 sm:justify-end">
        <span className={cn("min-w-0 break-words text-fg sm:text-right", mono && "mono", strong && "font-semibold")}>{value}</span>
        {copy && <CopyButton value={copy} what={what} variant="ghost" size="xs" />}
      </dd>
    </div>
  );
}
