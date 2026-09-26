"use client";
// Page « Compte suspendu » : si la centrale doit des frais plateforme à Rydar, montant, échéance et « J'ai payé »
// (la déclaration reste possible pour une centrale suspendue ; Rydar confirme puis réactive le compte).
import { formatPrice, platformDueSummary } from "@rydar/shared";
import { Landmark, Send } from "lucide-react";
import { useState } from "react";
import { type PlatformAccountData, balanceTone, remainingAfterDeclared } from "@/components/platform-fees/org-platform-card";
import { PlatformPayDialog } from "@/components/platform-fees/org-pay-dialog";
import { PlatformPaymentHistory } from "@/components/platform-fees/org-payment-history";
import { toneText } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useNow } from "@/hooks/use-now";
import { cn } from "@/lib/utils";

export function OrgSuspendedDues({ data, serverNow }: { data: PlatformAccountData; serverNow: number }) {
  const now = useNow(60_000) ?? serverNow;
  const [open, setOpen] = useState(false);
  const a = data.account;
  const tz = data.organization.timezone || "Europe/Paris";
  const cur = a.currency || "EUR";
  const due = platformDueSummary(a, tz);
  const remaining = remainingAfterDeclared(a);
  const recent = data.payments.filter((p) => p.status === "declared" || p.status === "rejected" || Date.parse(p.reviewed_at ?? p.declared_at) > now - 30 * 86_400_000);

  return (
    <div className="surface mt-8 overflow-hidden rounded-2xl text-left">
      <div className="flex items-start gap-3 border-b border-line px-5 py-4">
        <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-lg bg-violet/[0.1] text-violet">
          <Landmark className="size-[18px]" />
        </span>
        <div className="min-w-0">
          <p className="text-[12.5px] text-fg-muted">Frais plateforme dus à Rydar</p>
          <p className={cn("mono text-[26px] font-semibold leading-tight tracking-tight", toneText[balanceTone(a)])}>{formatPrice(Math.max(0, a.balance_cents), cur)}</p>
          <p className="text-[12.5px]">
            <span className={cn("font-medium", toneText[due.tone])}>{due.text}</span>
            {a.due_cents > 0 && a.balance_cents > a.due_cents && <span className="text-fg-muted"> · dont {formatPrice(a.due_cents, cur)} échus</span>}
          </p>
        </div>
      </div>
      {a.declared_cents > 0 && (
        <p className="border-b border-line bg-blue/[0.05] px-5 py-2.5 text-[12.5px] text-blue">
          {formatPrice(a.declared_cents, cur)} déclarés, en attente de confirmation par Rydar
          {remaining > 0 ? <span className="text-fg-muted"> · il restera {formatPrice(remaining, cur)}</span> : null}
        </p>
      )}
      <div className="px-5 py-4">
        <p className="text-[12.5px] leading-5 text-fg-muted">
          Réglez ce montant puis déclarez votre paiement ici : Rydar le confirmera dès réception. Référence à indiquer{" "}
          <span className="mono whitespace-nowrap font-semibold text-fg">{a.reference}</span>.
        </p>
        <Button variant={remaining > 0 ? "primary" : "secondary"} className="mt-3 w-full" onClick={() => setOpen(true)}>
          <Send /> J&apos;ai payé
        </Button>
      </div>
      {recent.length > 0 && (
        <div className="border-t border-line">
          <p className="px-5 pt-3 text-[12.5px] font-semibold text-fg">Vos derniers paiements</p>
          <PlatformPaymentHistory payments={recent} currency={cur} timeZone={tz} now={now} limit={3} />
        </div>
      )}
      <PlatformPayDialog open={open} onOpenChange={setOpen} pay={data.pay} currency={cur} timeZone={tz} declaredCents={a.declared_cents} />
    </div>
  );
}
