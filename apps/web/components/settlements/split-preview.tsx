"use client";
// Aperçu en direct de la répartition d'une course (mode centrale) : preview_ride_split, avec anti-rebond.
// « 59 € → 40 € chauffeur · 14 € commission · 5 € plateforme » ; COMMISSION_TOO_HIGH expliqué en clair.
import { formatPrice, type PreviewRideSplit } from "@rydar/shared";
import { TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { SplitBar } from "@/components/settlements/settlement-ui";
import { getBrowserClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

export type SplitPreviewState = { loading: boolean; data: PreviewRideSplit | null };

/** Répartition calculée par la base (mêmes règles que le trigger) ; null tant que le prix est inconnu. */
export function useSplitPreview(orgId: string | null | undefined, priceCents: number | null, commissionCents: number | null, enabled: boolean): SplitPreviewState {
  const [state, setState] = useState<SplitPreviewState>({ loading: false, data: null });
  useEffect(() => {
    if (!enabled || !orgId || priceCents == null || !Number.isFinite(priceCents) || priceCents < 0) {
      setState({ loading: false, data: null });
      return;
    }
    let alive = true;
    setState((s) => ({ ...s, loading: true }));
    const t = window.setTimeout(async () => {
      const { data, error } = await getBrowserClient().rpc("preview_ride_split", {
        p_org: orgId,
        p_price: Math.round(priceCents),
        p_commission: commissionCents == null ? null : Math.round(commissionCents),
      });
      if (alive) setState({ loading: false, data: error ? null : (data as PreviewRideSplit) });
    }, 250);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [enabled, orgId, priceCents, commissionCents]);
  return state;
}

/** Centimes → valeur de champ en euros (« 11,80 », « 59 »). */
export function centsToInput(cents: number | null | undefined): string {
  if (cents == null || !Number.isFinite(cents)) return "";
  return cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2).replace(".", ",");
}

/** Montant saisi en euros (« 14 », « 14,50 ») → centimes ; null si vide ; NaN si invalide. */
export function eurosToCents(v: string): number | null {
  const t = v.trim().replace(/\s/g, "").replace(",", ".");
  if (!t) return null;
  if (!/^\d+(\.\d{0,2})?$/.test(t)) return Number.NaN;
  return Math.round(Number(t) * 100);
}

export function SplitPreview({
  state,
  priceCents,
  currency = "EUR",
  className,
}: {
  state: SplitPreviewState;
  priceCents: number | null;
  currency?: string;
  className?: string;
}) {
  const d = state.data;
  if (priceCents == null) {
    return (
      <p className={cn("rounded-lg bg-white/[0.03] px-3 py-2 text-[12px] text-fg-subtle", className)}>
        Prix obligatoire : le chauffeur voit sa part (« Vous gagnez … ») avant d&apos;accepter.
      </p>
    );
  }
  if (d?.error === "COMMISSION_TOO_HIGH") {
    return (
      <p className={cn("flex items-start gap-2 rounded-lg border border-red/25 bg-red/[0.07] px-3 py-2 text-[12px] leading-[18px] text-red", className)} role="alert">
        <TriangleAlert className="mt-px size-3.5 shrink-0" />
        <span>
          Commission trop élevée : avec les frais plateforme
          {d.platform_fee_cents ? ` (${formatPrice(d.platform_fee_cents, currency)})` : ""}, elle dépasse le prix de la course ({formatPrice(priceCents, currency)}).
        </span>
      </p>
    );
  }
  const ready = d && d.driver_payout_cents != null && d.commission_cents != null;
  return (
    <div className={cn("rounded-lg bg-white/[0.03] px-3 py-2.5 transition-opacity", state.loading && "opacity-60", className)} aria-live="polite">
      {ready ? (
        <>
          <SplitBar split={{ price: priceCents, driver: d.driver_payout_cents!, commission: d.commission_cents!, platform: d.platform_fee_cents ?? 0 }} />
          <p className="mt-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[12.5px] text-fg-muted">
            <span className="mono text-fg">{formatPrice(priceCents, currency)}</span>
            <span className="text-fg-subtle">→</span>
            <span className="inline-flex items-baseline gap-1 whitespace-nowrap">
              <span className="mono font-semibold text-brand">{formatPrice(d.driver_payout_cents, currency)}</span> chauffeur
            </span>
            <span className="text-fg-subtle">·</span>
            <span className="inline-flex items-baseline gap-1 whitespace-nowrap">
              <span className="mono text-blue">{formatPrice(d.commission_cents, currency)}</span> commission{d.manual ? "" : " (auto)"}
            </span>
            {!!d.platform_fee_cents && (
              <>
                <span className="text-fg-subtle">·</span>
                <span className="inline-flex items-baseline gap-1 whitespace-nowrap">
                  <span className="mono text-violet">{formatPrice(d.platform_fee_cents, currency)}</span> plateforme
                </span>
              </>
            )}
          </p>
        </>
      ) : (
        <p className="text-[12px] text-fg-subtle">Calcul de la répartition…</p>
      )}
    </div>
  );
}
