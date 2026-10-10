"use client";
// Page « Compte suspendu » : si l'organisation doit des frais Rydar, montant principal (pay-now.ts : la même phrase que la
// carte, le bandeau et la fenêtre « J'ai payé ») et « J'ai payé » (la déclaration reste possible pour une organisation
// suspendue ; Rydar confirme puis réactive le compte).
import { Landmark, Send } from "lucide-react";
import { useState } from "react";
import type { PlatformAccountData } from "@/components/platform-fees/org-platform-card";
import { PlatformPayDialog } from "@/components/platform-fees/org-pay-dialog";
import { PlatformPaymentHistory } from "@/components/platform-fees/org-payment-history";
import { PayNowLine } from "@/components/platform-fees/org-platform-ui";
import { payNowDetails, payNowSummary } from "@/components/platform-fees/pay-now";
import { Button } from "@/components/ui/button";
import { useNow } from "@/hooks/use-now";

export function OrgSuspendedDues({ data, serverNow }: { data: PlatformAccountData; serverNow: number }) {
  const now = useNow(60_000) ?? serverNow;
  const [open, setOpen] = useState(false);
  const a = data.account;
  const tz = data.organization.timezone || "Europe/Paris";
  const cur = a.currency || "EUR";
  const pay = payNowSummary(a, now, tz);
  const recent = data.payments.filter((p) => p.status === "declared" || p.status === "rejected" || Date.parse(p.reviewed_at ?? p.declared_at) > now - 30 * 86_400_000);

  return (
    <div className="surface mt-8 overflow-hidden rounded-2xl text-left">
      <div className="flex items-start gap-3 border-b border-line px-5 py-4">
        <span aria-hidden className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-lg bg-white/[0.05] text-fg-muted">
          <Landmark className="size-[18px]" />
        </span>
        <div className="min-w-0">
          <p className="text-[13px] text-fg-muted">Frais Rydar</p>
          <PayNowLine pay={pay} />
          {payNowDetails(pay, false) && <p className="mt-0.5 text-[13px] text-fg-muted">{payNowDetails(pay, false)}</p>}
        </div>
      </div>
      <div className="px-5 py-4">
        <p className="text-[13px] leading-5 text-fg-muted">
          Réglez ce montant puis déclarez votre paiement ici&nbsp;: Rydar le confirmera dès réception. Référence à indiquer{" "}
          <span className="mono whitespace-nowrap font-semibold text-fg">{a.reference}</span>.
        </p>
        <Button variant={pay.kind === "nothing" ? "secondary" : "primary"} className="mt-3 w-full" onClick={() => setOpen(true)}>
          <Send /> J&apos;ai payé
        </Button>
      </div>
      {recent.length > 0 && (
        <div className="border-t border-line">
          <p className="px-5 pt-3 text-[13px] font-semibold text-fg">Vos derniers paiements</p>
          <PlatformPaymentHistory payments={recent} currency={cur} timeZone={tz} now={now} limit={3} />
        </div>
      )}
      <PlatformPayDialog open={open} onOpenChange={setOpen} pay={data.pay} account={a} currency={cur} timeZone={tz} />
    </div>
  );
}
