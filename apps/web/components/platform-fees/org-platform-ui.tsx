"use client";
// Frais Rydar (côté organisation) : éléments interactifs communs — moyens de paiement, statut d'un paiement.
// Textes et formats purs : org-platform-format.ts et pay-now.ts (utilisables aussi par les pages serveur) ; copie :
// components/ui.
import { PLATFORM_PAYMENT_STATUS_META, type PlatformPayment, type PlatformPaymentMethod } from "@rydar/shared";
import { ArrowLeftRight, Banknote, CreditCard, Ellipsis, Link2, type LucideIcon } from "lucide-react";
import { PLATFORM_METHOD_ORDER, platformMethodLabel } from "@/components/platform-fees/org-platform-format";
import type { PayNow } from "@/components/platform-fees/pay-now";
import { Badge, toneText } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const NB = "\u00a0";

export const PLATFORM_METHOD_ICON: Record<PlatformPaymentMethod, LucideIcon> = {
  transfer: ArrowLeftRight,
  link: Link2,
  cash: Banknote,
  card: CreditCard,
  other: Ellipsis,
};

/** Sélecteur du moyen de paiement : Virement, Lien de paiement, Espèces, Carte, Autre moyen (ordre et libellés du web). */
export function PlatformMethodPicker({
  value,
  onChange,
  invalid,
  labelledBy,
}: {
  value: PlatformPaymentMethod | null;
  onChange: (m: PlatformPaymentMethod) => void;
  invalid?: boolean;
  /** Identifiant du libellé visible du champ (sinon : « Moyen de paiement ») */
  labelledBy?: string;
}) {
  return (
    <div
      className="grid grid-cols-2 gap-1.5 sm:grid-cols-3"
      role="radiogroup"
      aria-label={labelledBy ? undefined : "Moyen de paiement"}
      aria-labelledby={labelledBy}
      aria-invalid={invalid || undefined}
    >
      {PLATFORM_METHOD_ORDER.map((m) => {
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
              "flex min-h-11 items-center justify-center gap-2 rounded-lg border px-2 text-[13px] font-medium transition-colors sm:min-h-10",
              on ? "border-brand/60 bg-brand/[0.08] text-fg" : "border-line text-fg-muted hover:border-line-strong hover:text-fg",
              invalid && !value && "border-red/50",
            )}
          >
            <Icon aria-hidden className={cn("size-4 shrink-0", on ? "text-brand" : "text-fg-subtle")} />
            <span className="min-w-0 text-center leading-tight">{platformMethodLabel(m)}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Statut d'un paiement à Rydar (« En attente de confirmation », « Reçu par Rydar »…). */
export function PlatformPaymentBadge({ payment, className }: { payment: Pick<PlatformPayment, "status" | "source">; className?: string }) {
  const meta = PLATFORM_PAYMENT_STATUS_META[payment.status];
  const label = payment.status === "confirmed" && payment.source === "admin" ? "Enregistré par Rydar" : meta.label;
  return (
    <Badge tone={meta.tone} className={className}>
      {label}
    </Badge>
  );
}

/**
 * Phrase du montant principal, montant en grand : « À payer maintenant : 85 € · en retard depuis 4 jours ». Texte
 * continu (aucune boîte flexible) : lu d'un trait, identique au bandeau et à la fenêtre « J'ai payé ».
 */
export function PayNowLine({ pay, className, amountClassName }: { pay: PayNow; className?: string; amountClassName?: string }) {
  const tone = toneText[pay.tone];
  if (!pay.amount) {
    return <p className={cn("text-[18px] font-semibold tracking-tight", tone, className)}>{pay.text}</p>;
  }
  return (
    <p className={cn("text-[14px] font-medium leading-snug", tone, className)}>
      {pay.label}
      {NB}:{" "}
      <span className={cn("whitespace-nowrap text-[26px] font-semibold tabular-nums tracking-tight", amountClassName)}>{pay.amount}</span>
      {pay.detail && <> · {pay.detail}</>}
    </p>
  );
}
