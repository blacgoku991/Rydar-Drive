"use client";
// « J'ai payé » : la centrale déclare son reversement à Rydar (montant, moyen, référence, date, note).
// Les coordonnées de Rydar (bénéficiaire, IBAN, BIC, lien de paiement) et la référence à indiquer sont
// rappelées au-dessus du formulaire. Le solde ne baisse qu'une fois le paiement CONFIRMÉ par Rydar.
import { formatIban, formatPrice, type PlatformPayInfo, type PlatformPaymentMethod } from "@rydar/shared";
import { AlertTriangle, ExternalLink, Send } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { declarePlatformPayment } from "@/app/dashboard/settlements/platform-actions";
import { centsToEurosInput, eurosInputToCents, todayIn } from "@/components/platform-fees/org-platform-format";
import { CopyButton, PlatformMethodPicker } from "@/components/platform-fees/org-platform-ui";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/input";
import { runAction } from "@/lib/run-action";
import { cn, submitWith } from "@/lib/utils";

export function PlatformPayDialog({
  open,
  onOpenChange,
  pay,
  currency,
  timeZone,
  declaredCents = 0,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pay: PlatformPayInfo;
  currency: string;
  timeZone: string;
  /** Déjà déclaré et en attente : déduit du montant proposé */
  declaredCents?: number;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const suggested = Math.max(0, pay.amount_cents - declaredCents);
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<PlatformPaymentMethod | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [today, setToday] = useState("");

  // Préremplissage à l'ouverture seulement : une relecture de la page (temps réel) ne doit pas écraser la saisie
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
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
    else if (!Number.isFinite(cents) || cents < 1) local.amountCents = "Saisissez un montant valide (ex. 120 ou 120,50)";
    if (!method) local.method = "Choisissez le moyen de paiement";
    if (Object.keys(local).length) {
      setErrors(local);
      toast.error(
        local.amountCents
          ? `Montant : ${local.amountCents.charAt(0).toLowerCase()}${local.amountCents.slice(1)}`
          : `Moyen de paiement : ${local.method!.toLowerCase()}`,
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="md"
        title="J'ai payé Rydar"
        description="Déclarez votre reversement des frais plateforme : Rydar le confirme dès réception, puis votre solde baisse."
      >
        {/* Coordonnées de Rydar */}
        <section aria-label="Coordonnées de paiement de Rydar" className="mb-5 rounded-xl border border-line bg-white/[0.025]">
          {pay.configured ? (
            <>
              <dl className="divide-y divide-line text-[13px]">
                {hasBank && pay.payee_name && <PayRow label="Bénéficiaire" value={pay.payee_name} />}
                {pay.iban && <PayRow label="IBAN" value={formatIban(pay.iban)} copy={pay.iban} copyLabel="IBAN" mono />}
                {pay.bic && <PayRow label="BIC" value={pay.bic} copy={pay.bic} copyLabel="BIC" mono />}
                <PayRow label="Référence à indiquer" value={pay.reference} copy={pay.reference} copyLabel="Référence" mono strong />
                {pay.instructions && (
                  <div className="px-3.5 py-2.5">
                    <dt className="sr-only">Instructions</dt>
                    <dd className="whitespace-pre-line text-[12.5px] leading-5 text-fg-muted">{pay.instructions}</dd>
                  </div>
                )}
              </dl>
              {pay.link && pay.amount_cents > 0 && (
                <div className="border-t border-line px-3.5 py-3">
                  <Button asChild variant="outline" size="sm" className="w-full sm:w-auto">
                    <a href={pay.link} target="_blank" rel="noopener noreferrer">
                      <ExternalLink /> {declaredCents > 0 ? "Payer en ligne" : `Payer ${formatPrice(pay.amount_cents, currency)} en ligne`}
                    </a>
                  </Button>
                  <p className="mt-1.5 text-[12px] text-fg-muted">
                    {declaredCents > 0 ? `Lien prérempli avec ${formatPrice(pay.amount_cents, currency)} (solde avant vos paiements en attente) : ajustez si besoin. ` : ""}
                    Revenez ensuite déclarer le paiement ci-dessous.
                  </p>
                </div>
              )}
            </>
          ) : (
            <div className="space-y-2.5 px-3.5 py-3">
              <p className="flex items-start gap-2 text-[12.5px] leading-5 text-amber">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                <span>
                  Rydar ne vous a pas encore communiqué ses coordonnées de paiement. Contactez l&apos;équipe Rydar pour les obtenir, puis déclarez votre
                  paiement ici.
                </span>
              </p>
              <div className="flex items-center justify-between gap-3 border-t border-line pt-2.5">
                <span className="text-[12.5px] text-fg-muted">Référence à indiquer</span>
                <span className="flex items-center gap-1">
                  <span className="mono text-[13px] font-semibold text-fg">{pay.reference}</span>
                  <CopyButton value={pay.reference} label="Référence" />
                </span>
              </div>
            </div>
          )}
        </section>

        <form onSubmit={submitWith(submit)} noValidate className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Montant payé"
              htmlFor="pf-amount"
              error={errors.amountCents}
              hint={suggested > 0 ? `Montant à régler : ${formatPrice(suggested, currency)}` : undefined}
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
                  placeholder="0"
                  aria-invalid={!!errors.amountCents || undefined}
                  className="mono pr-9 text-[15px] font-semibold"
                />
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[13px] text-fg-subtle">€</span>
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
            <Textarea id="pf-note" name="note" maxLength={500} placeholder="Ex. virement des frais de septembre" className="min-h-[64px]" />
          </Field>

          <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:items-center sm:justify-end">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Annuler
            </Button>
            <Button type="submit" variant="primary" loading={pending}>
              <Send /> Déclarer le paiement
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function PayRow({
  label,
  value,
  copy,
  copyLabel,
  mono,
  strong,
}: {
  label: string;
  value: string;
  copy?: string;
  copyLabel?: string;
  mono?: boolean;
  strong?: boolean;
}) {
  return (
    <div className="flex flex-col gap-0.5 px-3.5 py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
      <dt className="shrink-0 text-[12.5px] text-fg-muted">{label}</dt>
      <dd className="flex min-w-0 items-center justify-between gap-1 sm:justify-end">
        <span className={cn("min-w-0 break-words text-fg sm:text-right", mono && "mono", strong && "font-semibold")}>{value}</span>
        {copy && <CopyButton value={copy} label={copyLabel ?? label} />}
      </dd>
    </div>
  );
}
