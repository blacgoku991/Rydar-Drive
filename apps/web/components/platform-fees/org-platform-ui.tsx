"use client";
// Frais plateforme (côté centrale) : éléments interactifs communs — moyens de paiement, statut d'un paiement, copie.
// Textes et formats purs : org-platform-format.ts (utilisables aussi par les pages serveur).
import {
  PLATFORM_PAYMENT_METHOD_META,
  PLATFORM_PAYMENT_METHODS,
  PLATFORM_PAYMENT_STATUS_META,
  type PlatformPayment,
  type PlatformPaymentMethod,
} from "@rydar/shared";
import { ArrowLeftRight, Banknote, Check, Copy, CreditCard, Ellipsis, Link2, type LucideIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export const PLATFORM_METHOD_ICON: Record<PlatformPaymentMethod, LucideIcon> = {
  transfer: ArrowLeftRight,
  link: Link2,
  cash: Banknote,
  card: CreditCard,
  other: Ellipsis,
};

/** Sélecteur du moyen de paiement (virement, lien, espèces, carte, autre). */
export function PlatformMethodPicker({
  value,
  onChange,
  invalid,
}: {
  value: PlatformPaymentMethod | null;
  onChange: (m: PlatformPaymentMethod) => void;
  invalid?: boolean;
}) {
  return (
    <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3" role="radiogroup" aria-label="Moyen de paiement" aria-invalid={invalid || undefined}>
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
              invalid && !value && "border-red/50",
            )}
          >
            <Icon className={cn("size-4 shrink-0", on ? "text-brand" : "text-fg-subtle")} />
            <span className="truncate">{PLATFORM_PAYMENT_METHOD_META[m].label}</span>
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
    <Badge tone={meta.tone} pulse={payment.status === "declared"} className={className}>
      {label}
    </Badge>
  );
}

/** Bouton « copier » (IBAN, BIC, référence). */
export function CopyButton({ value, label, className }: { value: string; label: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          toast.success(`${label} copié`);
          window.setTimeout(() => setDone(false), 1800);
        } catch {
          toast.error("Copie impossible : sélectionnez le texte à la main.");
        }
      }}
      className={cn(
        "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium text-fg-muted transition-colors hover:bg-white/[0.06] hover:text-fg",
        className,
      )}
      aria-label={`Copier ${label === label.toUpperCase() ? label : label.toLowerCase()}`}
    >
      {done ? <Check className="size-3.5 text-green" /> : <Copy className="size-3.5" />}
      {done ? "Copié" : "Copier"}
    </button>
  );
}
