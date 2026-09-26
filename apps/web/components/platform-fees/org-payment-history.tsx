"use client";
// Historique des paiements de la centrale à Rydar : déclaré / reçu (montant reçu s'il diffère), motif d'un refus,
// « Retirer » pour une déclaration que Rydar n'a pas encore traitée.
import { formatPrice, type PlatformPayment } from "@rydar/shared";
import { Undo2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { cancelPlatformPayment } from "@/app/dashboard/settlements/platform-actions";
import { ago, platformMethodLabel, shortDay } from "@/components/platform-fees/org-platform-format";
import { PLATFORM_METHOD_ICON, PlatformPaymentBadge } from "@/components/platform-fees/org-platform-ui";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export function PlatformPaymentHistory({
  payments,
  currency,
  timeZone,
  now,
  canCancel = true,
  limit = 5,
  className,
}: {
  payments: PlatformPayment[];
  currency: string;
  timeZone: string;
  now: number;
  canCancel?: boolean;
  /** Nombre de lignes avant « Afficher tout » */
  limit?: number;
  className?: string;
}) {
  const [all, setAll] = useState(false);
  const [cancelling, setCancelling] = useState<PlatformPayment | null>(null);
  const shown = all ? payments : payments.slice(0, limit);
  if (!payments.length) {
    return <p className={cn("px-5 py-6 text-center text-[12.5px] text-fg-muted", className)}>Aucun paiement déclaré pour l&apos;instant.</p>;
  }
  return (
    <div className={className}>
      <ul className="divide-y divide-line">
        {shown.map((p) => (
          <PaymentRow
            key={p.id}
            p={p}
            currency={currency}
            timeZone={timeZone}
            now={now}
            onCancel={canCancel && p.status === "declared" && p.source === "centrale" ? () => setCancelling(p) : undefined}
          />
        ))}
      </ul>
      {payments.length > limit && (
        <div className="border-t border-line px-5 py-2.5 text-center">
          <button type="button" onClick={() => setAll((v) => !v)} className="text-[12.5px] font-medium text-fg-muted hover:text-fg">
            {all ? "Afficher moins" : `Afficher les ${payments.length} paiements`}
          </button>
        </div>
      )}
      <CancelDialog payment={cancelling} currency={currency} onClose={() => setCancelling(null)} />
    </div>
  );
}

function PaymentRow({ p, currency, timeZone, now, onCancel }: { p: PlatformPayment; currency: string; timeZone: string; now: number; onCancel?: () => void }) {
  const Icon = PLATFORM_METHOD_ICON[p.method] ?? PLATFORM_METHOD_ICON.other;
  const partial = p.status === "confirmed" && p.received_cents != null && p.received_cents !== p.amount_cents;
  const detail = [platformMethodLabel(p.method), p.paid_on ? `payé le ${shortDay(p.paid_on, timeZone, now)}` : null, p.reference ? `réf. ${p.reference}` : null]
    .filter(Boolean)
    .join(" · ");
  const who =
    p.source === "admin"
      ? `enregistré par Rydar ${ago(p.reviewed_at ?? p.declared_at, now)}`
      : `déclaré ${ago(p.declared_at, now)}${p.declared_by_name ? ` par ${p.declared_by_name}` : ""}`;
  return (
    <li className="flex items-start gap-3 px-5 py-3">
      <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-white/[0.04] text-fg-muted">
        <Icon className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <span
            className={cn(
              "mono text-[14px] font-semibold tracking-tight",
              p.status === "cancelled" || p.status === "rejected" ? "text-fg-muted line-through" : "text-fg",
            )}
          >
            {formatPrice(partial ? p.received_cents : p.amount_cents, currency)}
          </span>
          {partial && <span className="text-[12px] text-amber">reçus sur {formatPrice(p.amount_cents, currency)} déclarés</span>}
          <PlatformPaymentBadge payment={p} />
        </div>
        <p className="mt-0.5 break-words text-[12px] text-fg-muted">{detail}</p>
        <p className="text-[12px] text-fg-muted">
          {who}
          {p.status !== "declared" && p.status !== "cancelled" && p.reviewed_at && p.source !== "admin" && (
            <>
              {" "}
              · {p.status === "confirmed" ? "confirmé" : "traité"} {ago(p.reviewed_at, now)}
            </>
          )}
        </p>
        {p.note && <p className="mt-0.5 line-clamp-2 text-[12px] text-fg-muted">Votre note&nbsp;: «&nbsp;{p.note}&nbsp;»</p>}
        {p.review_note && (
          <p
            className={cn(
              "mt-1 rounded-md px-2 py-1 text-[12px] leading-[18px]",
              p.status === "rejected" ? "bg-red/[0.08] text-red" : "bg-white/[0.04] text-fg-muted",
            )}
          >
            {p.status === "rejected" ? "Motif de Rydar" : "Rydar"}&nbsp;: «&nbsp;{p.review_note}&nbsp;»
          </p>
        )}
      </div>
      {onCancel && (
        <Button variant="ghost" size="xs" onClick={onCancel} className="shrink-0">
          <Undo2 /> Retirer
        </Button>
      )}
    </li>
  );
}

function CancelDialog({ payment, currency, onClose }: { payment: PlatformPayment | null; currency: string; onClose: () => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Dialog open={!!payment} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        size="sm"
        title="Retirer la déclaration"
        description="Rydar ne l'a pas encore traitée : elle disparaît de sa liste « à confirmer ». Vous pourrez déclarer à nouveau le bon paiement."
      >
        {payment && (
          <div className="mb-5 flex items-center justify-between gap-3 rounded-xl bg-white/[0.035] px-3.5 py-3">
            <div className="min-w-0">
              <p className="text-[13px] font-medium text-fg">{platformMethodLabel(payment.method)}</p>
              {payment.reference && <p className="mono truncate text-[12px] text-fg-muted">réf. {payment.reference}</p>}
            </div>
            <p className="mono shrink-0 text-[20px] font-semibold tracking-tight text-fg">{formatPrice(payment.amount_cents, currency)}</p>
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Garder
          </Button>
          <Button
            variant="danger"
            loading={pending}
            onClick={() =>
              payment &&
              start(async () => {
                const res = await cancelPlatformPayment(payment.id);
                if (!res.ok) {
                  toast.error(res.error);
                  // Déjà traité par Rydar entre-temps : la liste affichée est périmée (page suspendue : pas de temps réel)
                  if (res.code === "NOT_CANCELLABLE" || res.code === "NOT_FOUND") {
                    onClose();
                    router.refresh();
                  }
                  return;
                }
                toast.success(res.message);
                onClose();
                router.refresh();
              })
            }
          >
            <Undo2 /> Retirer
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
