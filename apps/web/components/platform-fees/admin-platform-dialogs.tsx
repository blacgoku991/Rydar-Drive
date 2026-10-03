"use client";
// Super admin : décisions sur les frais plateforme — « Reçu » (montant reçu, partiel possible), « Pas reçu »,
// « Rouvrir », baisse de frais acceptée / refusée. Chaque action passe par app/admin/frais/actions.ts.
import { PLATFORM_PAYMENT_METHODS, formatPrice, type PlatformEntry, type PlatformPayment, type PlatformPaymentMethod } from "@rydar/shared";
import { Check, CircleSlash, RotateCcw, ThumbsDown, ThumbsUp } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import {
  confirmPlatformPayment,
  rejectPlatformPayment,
  reopenPlatformPayment,
  reviewPlatformReduction,
  type PlatformActionResult,
} from "@/app/admin/frais/actions";
import { centsToInput, eurosToCents } from "@/components/admin/fees";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Input, Textarea, asFieldControl } from "@/components/ui/input";
import { runAction } from "@/lib/run-action";
import { cn, submitWith } from "@/lib/utils";
import { PLATFORM_METHOD_ICON, formatDay, platformMethodLabel, signedPrice } from "./admin-platform-format";

// ---------------------------------------------------------------------------- exécution
export function usePlatformRunner() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const run = (
    fn: () => Promise<PlatformActionResult>,
    opts: { onDone?: () => void; onError?: (res: Extract<PlatformActionResult, { ok: false }>) => void; success?: (message: string) => string } = {},
  ) =>
    start(() => runAction(async () => {
      const res = await fn();
      if (!res.ok) {
        toast.error(res.error);
        opts.onError?.(res);
        return;
      }
      toast.success(opts.success ? opts.success(res.message) : res.message || "Enregistré");
      opts.onDone?.();
      router.refresh();
    }));
  return { pending, run };
}

// ---------------------------------------------------------------------------- champs
/** Montant en euros (« 120 », « 120,50 ») avec le symbole à droite ; relié par Field (id, aide, erreur). */
export const AmountInput = asFieldControl(function AmountInput({ className, invalid, ...props }: React.InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  return (
    <div className="relative">
      <Input inputMode="decimal" autoComplete="off" className={cn("num pr-8", className)} aria-invalid={invalid || undefined} {...props} />
      <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[13px] text-fg-subtle">€</span>
    </div>
  );
});

/** Motifs fréquents (un clic remplit le champ). */
export function Chips({ options, onPick }: { options: readonly string[]; onPick: (v: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => (
        <button
          key={o}
          type="button"
          onClick={() => onPick(o)}
          className="rounded-full border border-line px-2.5 py-1 text-[12px] text-fg-muted transition-colors hover:border-line-strong hover:text-fg"
        >
          {o}
        </button>
      ))}
    </div>
  );
}

/** Moyen de paiement (virement, lien, espèces, carte, autre). */
export function PlatformMethodPicker({
  value,
  onChange,
  name,
}: {
  value: PlatformPaymentMethod | null;
  onChange: (m: PlatformPaymentMethod) => void;
  name?: string;
}) {
  return (
    <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3" role="radiogroup" aria-label="Moyen de paiement">
      {PLATFORM_PAYMENT_METHODS.map((m) => {
        const Icon = PLATFORM_METHOD_ICON[m];
        const on = value === m;
        return (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(m)}
            className={cn(
              "flex h-10 items-center justify-center gap-2 rounded-lg border px-2 text-[12.5px] font-medium transition-colors",
              on ? "border-brand/60 bg-brand/[0.08] text-fg" : "border-line text-fg-muted hover:border-line-strong hover:text-fg",
            )}
          >
            <Icon className={cn("size-4 shrink-0", on ? "text-brand" : "text-fg-subtle")} />
            <span className="truncate">{platformMethodLabel(m)}</span>
          </button>
        );
      })}
      {name && <input type="hidden" name={name} value={value ?? ""} />}
    </div>
  );
}

// ---------------------------------------------------------------------------- résumés
function PaymentSummary({ payment: p, orgName, currency }: { payment: PlatformPayment; orgName: string; currency: string }) {
  const Icon = PLATFORM_METHOD_ICON[p.method] ?? PLATFORM_METHOD_ICON.other;
  return (
    <div className="mb-4 flex items-start justify-between gap-3 rounded-xl bg-white/[0.035] px-3.5 py-3">
      <div className="min-w-0 space-y-0.5">
        <p className="truncate text-[13px] font-medium text-fg">{orgName}</p>
        <p className="flex items-center gap-1.5 text-[12px] text-fg-muted">
          <Icon className="size-3.5 shrink-0 text-fg-subtle" />
          <span className="truncate">
            {platformMethodLabel(p.method)}
            {p.paid_on ? ` · payé le ${formatDay(p.paid_on)}` : ""}
          </span>
        </p>
        {p.reference && (
          <p className="truncate text-[12px] text-fg-subtle">
            Réf. <span className="mono text-fg-muted">{p.reference}</span>
          </p>
        )}
      </div>
      <div className="shrink-0 text-right">
        <p className="mono text-[20px] font-semibold tracking-tight text-fg">{formatPrice(p.amount_cents, currency)}</p>
        <p className="text-[11.5px] text-fg-subtle">
          {p.status === "confirmed" && p.received_cents != null ? `reçu ${formatPrice(p.received_cents, currency)}` : "déclaré"}
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------- Reçu / Pas reçu
const REJECT_REASONS = ["Rien reçu sur le compte", "Montant différent", "Référence introuvable", "Paiement rejeté par la banque"] as const;
const REOPEN_REASONS = ["Erreur de saisie", "Paiement finalement reçu", "Paiement annulé par la banque"] as const;

type PaymentMode = "confirm" | "reject" | "reopen" | null;

function PaymentDialogs({
  payment: p,
  orgName,
  currency,
  mode,
  onModeChange,
}: {
  payment: PlatformPayment;
  orgName: string;
  currency: string;
  mode: PaymentMode;
  onModeChange: (m: PaymentMode) => void;
}) {
  const { pending, run } = usePlatformRunner();
  const [amount, setAmount] = useState(centsToInput(p.amount_cents));
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!mode) return;
    setAmount(centsToInput(p.amount_cents));
    setNote("");
    setReason("");
    setError(null);
  }, [mode, p.id, p.amount_cents]);
  const close = () => onModeChange(null);

  const cents = eurosToCents(amount);
  const valid = Number.isFinite(cents) && cents >= 1 && cents <= 100_000_000;
  const diff = valid ? cents - p.amount_cents : 0;

  return (
    <>
      <Dialog open={mode === "confirm"} onOpenChange={(o) => !o && close()}>
        <DialogContent size="sm" title="Paiement reçu" description="Le montant reçu est déduit de ce que doit la centrale, qui est prévenue.">
          <PaymentSummary payment={p} orgName={orgName} currency={currency} />
          {p.note && (
            <p className="mb-4 rounded-lg border border-blue/25 bg-blue/[0.07] px-3 py-2 text-[12.5px] text-fg-muted">Note de la centrale&nbsp;: «&nbsp;{p.note}&nbsp;»</p>
          )}
          <form
            onSubmit={submitWith((fd) => {
              const received = eurosToCents(String(fd.get("received") ?? ""));
              if (!Number.isFinite(received) || received < 1) return setError("Montant invalide");
              setError(null);
              run(() => confirmPlatformPayment(p.id, received, String(fd.get("note") ?? "")), {
                onDone: close,
                onError: (res) => setError(res.fieldErrors?.receivedCents ?? null),
              });
            })}
            className="space-y-4"
          >
            <Field
              label="Montant reçu"
              htmlFor="pf-received"
              error={error ?? (!valid && amount.trim() ? "Montant invalide" : undefined)}
              hint={
                !valid ? undefined : diff < 0 ? (
                  <span className="text-amber">Paiement partiel&nbsp;: {formatPrice(-diff, currency)} resteront dus.</span>
                ) : diff > 0 ? (
                  <span className="text-blue">Plus que déclaré&nbsp;: l&apos;excédent réduit les prochains frais.</span>
                ) : (
                  "Montant déclaré par la centrale. Modifiez-le si vous avez reçu moins."
                )
              }
            >
              <AmountInput
                id="pf-received"
                name="received"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                invalid={!!error || (!valid && !!amount.trim())}
                autoFocus
              />
            </Field>
            <Field label="Note" optional htmlFor="pf-note">
              <Input id="pf-note" name="note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="Ex. virement reçu le 26/09" />
            </Field>
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="ghost" onClick={close}>
                Annuler
              </Button>
              <Button type="submit" variant="primary" loading={pending} disabled={!valid}>
                <Check /> {diff < 0 ? "Reçu en partie" : "Confirmer la réception"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={mode === "reject"} onOpenChange={(o) => !o && close()}>
        <DialogContent
          size="sm"
          title="Paiement non reçu"
          description="La centrale est prévenue avec votre motif et le montant reste dû. Vous pourrez rouvrir en cas d'erreur."
        >
          <PaymentSummary payment={p} orgName={orgName} currency={currency} />
          <form onSubmit={submitWith(() => run(() => rejectPlatformPayment(p.id, reason), { onDone: close }))}>
            <Field label="Ce qui ne va pas" htmlFor="pf-reason">
              <Textarea
                id="pf-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={500}
                placeholder="Ex. aucun virement reçu à ce jour"
                className="min-h-[72px]"
                autoFocus
              />
            </Field>
            <div className="mt-2.5">
              <Chips options={REJECT_REASONS} onPick={setReason} />
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={close}>
                Retour
              </Button>
              <Button type="submit" variant="danger" loading={pending} disabled={reason.trim().length < 3}>
                <CircleSlash /> Pas reçu
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={mode === "reopen"} onOpenChange={(o) => !o && close()}>
        <DialogContent
          size="sm"
          title="Rouvrir le paiement"
          description={
            p.status === "confirmed" && p.received_cents != null
              ? `Il redevient « à confirmer » : ${formatPrice(p.received_cents, currency)} ne sont plus comptés comme reçus.`
              : "Il redevient « à confirmer » et pourra être marqué reçu."
          }
        >
          <PaymentSummary payment={p} orgName={orgName} currency={currency} />
          <form onSubmit={submitWith(() => run(() => reopenPlatformPayment(p.id, reason), { onDone: close }))}>
            <Field label="Motif" htmlFor="pf-reopen">
              <Textarea
                id="pf-reopen"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={500}
                placeholder="Ex. montant saisi par erreur"
                className="min-h-[72px]"
                autoFocus
              />
            </Field>
            <div className="mt-2.5">
              <Chips options={REOPEN_REASONS} onPick={setReason} />
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={close}>
                Retour
              </Button>
              <Button type="submit" variant="primary" loading={pending} disabled={reason.trim().length < 3}>
                <RotateCcw /> Rouvrir
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** « Reçu » / « Pas reçu » (paiement déclaré), « Rouvrir » (reçu ou pas reçu). */
export function PaymentActions({
  payment,
  orgName,
  currency = "EUR",
  size = "sm",
  className,
}: {
  payment: PlatformPayment;
  orgName: string;
  currency?: string;
  size?: "xs" | "sm";
  className?: string;
}) {
  const [mode, setMode] = useState<PaymentMode>(null);
  if (payment.status === "cancelled") return null;
  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      {payment.status === "declared" ? (
        <>
          <Button variant="primary" size={size} onClick={() => setMode("confirm")}>
            <Check /> Reçu
          </Button>
          <Button variant="outline" size={size} onClick={() => setMode("reject")}>
            Pas reçu
          </Button>
        </>
      ) : (
        <Button variant="ghost" size={size} onClick={() => setMode("reopen")}>
          <RotateCcw /> Rouvrir
        </Button>
      )}
      <PaymentDialogs payment={payment} orgName={orgName} currency={currency} mode={mode} onModeChange={setMode} />
    </div>
  );
}

// ---------------------------------------------------------------------------- baisses de frais
const REFUSE_REASONS = ["Prix non justifié", "Course effectuée au prix initial", "Aucune explication de la centrale"] as const;

function EntrySummary({ entry: e, orgName, currency }: { entry: PlatformEntry; orgName: string; currency: string }) {
  return (
    <div className="mb-4 flex items-start justify-between gap-3 rounded-xl bg-white/[0.035] px-3.5 py-3">
      <div className="min-w-0 space-y-0.5">
        <p className="truncate text-[13px] font-medium text-fg">
          {orgName}
          {e.ride ? <span className="text-fg-subtle"> · Course {e.ride.number}</span> : null}
        </p>
        <p className="text-[12px] text-fg-muted">{e.reason ?? e.label}</p>
        <p className="text-[12px] text-fg-subtle">{e.label}</p>
      </div>
      <p className="mono shrink-0 text-[20px] font-semibold tracking-tight text-amber">{signedPrice(e.amount_cents, currency)}</p>
    </div>
  );
}

/** Baisse de frais en attente : « Accepter » (note facultative) / « Refuser » (motif obligatoire). */
export function ReductionActions({
  entry,
  orgName,
  currency = "EUR",
  size = "sm",
}: {
  entry: PlatformEntry;
  orgName: string;
  currency?: string;
  size?: "xs" | "sm";
}) {
  const { pending, run } = usePlatformRunner();
  const [mode, setMode] = useState<"approve" | "refuse" | null>(null);
  const [note, setNote] = useState("");
  useEffect(() => {
    if (mode) setNote("");
  }, [mode]);
  const close = () => setMode(null);
  const amount = formatPrice(Math.abs(entry.amount_cents), currency);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Button variant="outline" size={size} onClick={() => setMode("approve")}>
        <ThumbsUp /> Accepter
      </Button>
      <Button variant="outline" size={size} onClick={() => setMode("refuse")}>
        <ThumbsDown /> Refuser
      </Button>

      <Dialog open={mode === "approve"} onOpenChange={(o) => !o && close()}>
        <DialogContent
          size="sm"
          title="Accepter la baisse"
          description={`Les frais de cette course baissent de ${amount} : la centrale doit ${amount} de moins.`}
        >
          <EntrySummary entry={entry} orgName={orgName} currency={currency} />
          <form onSubmit={submitWith(() => run(() => reviewPlatformReduction(entry.id, true, note), { onDone: close }))}>
            <Field label="Note" optional htmlFor="pf-approve-note">
              <Input
                id="pf-approve-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={500}
                placeholder="Ex. geste commercial validé avec la centrale"
              />
            </Field>
            <div className="mt-6 flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={close}>
                Retour
              </Button>
              <Button type="submit" variant="primary" loading={pending}>
                <Check /> Accepter la baisse
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={mode === "refuse"} onOpenChange={(o) => !o && close()}>
        <DialogContent size="sm" title="Refuser la baisse" description="Les frais restent dus au montant initial ; la centrale voit votre motif.">
          <EntrySummary entry={entry} orgName={orgName} currency={currency} />
          <form onSubmit={submitWith(() => run(() => reviewPlatformReduction(entry.id, false, note), { onDone: close }))}>
            <Field label="Motif" htmlFor="pf-refuse-note">
              <Textarea
                id="pf-refuse-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={500}
                placeholder="Ex. la course a bien été facturée 62 €"
                className="min-h-[72px]"
                autoFocus
              />
            </Field>
            <div className="mt-2.5">
              <Chips options={REFUSE_REASONS} onPick={setNote} />
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={close}>
                Retour
              </Button>
              <Button type="submit" variant="danger" loading={pending} disabled={note.trim().length < 3}>
                <CircleSlash /> Refuser la baisse
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
