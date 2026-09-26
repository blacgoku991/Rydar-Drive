"use client";
// Super admin : mise à jour en direct des frais plateforme (événement « platform.updated » sur org:{id}),
// sélecteur du mois du relevé.
import { formatPrice, type PlatformEvent } from "@rydar/shared";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { NativeSelect } from "@/components/ui/input";
import { getBrowserClient } from "@/lib/supabase/client";
import { capitalize, monthLabel } from "./admin-platform-format";

/** Au-delà, pas d'abonnement individuel (la page reste actualisable) : évite d'ouvrir des centaines de canaux. */
const MAX_CHANNELS = 40;

/**
 * Écoute les centrales affichées : une déclaration « J'ai payé », une baisse de frais ou tout autre changement
 * rafraîchit la page (regroupé), et prévient le super admin de ce qui vient des centrales.
 */
export function PlatformLive({ orgs }: { orgs: { id: string; name: string }[] }) {
  const router = useRouter();
  const timer = useRef<number | null>(null);
  const names = useRef(new Map<string, string>());
  useEffect(() => {
    names.current = new Map(orgs.map((o) => [o.id, o.name]));
  }, [orgs]);
  const key = orgs
    .slice(0, MAX_CHANNELS)
    .map((o) => o.id)
    .sort()
    .join(",");

  useEffect(() => {
    if (!key) return;
    const supabase = getBrowserClient();
    const channels: RealtimeChannel[] = [];
    let disposed = false;
    const refresh = () => {
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => router.refresh(), 700);
    };
    // L'événement ne porte que des identifiants (canal lisible par tous les membres de la centrale) :
    // montant et motif relus par le super admin (RLS)
    const onEvent = async (e: PlatformEvent) => {
      refresh();
      const name = names.current.get(e.organization_id) ?? "Une centrale";
      if ((e.action === "declared" || e.action === "cancelled") && e.payment_id) {
        const { data } = await supabase.from("platform_payments").select("amount_cents").eq("id", e.payment_id).maybeSingle();
        if (!data) return;
        if (e.action === "declared") toast.info(`${name} a déclaré un paiement de ${formatPrice(data.amount_cents)}`, { description: "À confirmer dès réception." });
        else toast(`${name} a retiré sa déclaration de ${formatPrice(data.amount_cents)}`);
      } else if (e.action === "reduction_pending" && e.entry_id) {
        const { data } = await supabase.from("platform_fee_entries").select("label, reason").eq("id", e.entry_id).maybeSingle();
        if (data) toast.info(`Baisse de frais à valider\u00A0: ${name}`, { description: data.reason ?? data.label });
      }
    };
    (async () => {
      const { data } = await supabase.auth.getSession();
      if (data.session) await supabase.realtime.setAuth(data.session.access_token);
      if (disposed) return;
      for (const id of key.split(",")) {
        const ch = supabase.channel(`org:${id}`, { config: { private: true } });
        ch.on("broadcast", { event: "platform.updated" }, (message: { payload: unknown }) => {
          void onEvent(message.payload as PlatformEvent).catch(() => undefined);
        });
        ch.subscribe();
        channels.push(ch);
      }
    })().catch(() => undefined);
    return () => {
      disposed = true;
      if (timer.current) window.clearTimeout(timer.current);
      for (const ch of channels) void supabase.removeChannel(ch);
    };
  }, [key, router]);

  return null;
}

/** Mois du relevé (12 derniers mois). */
export function MonthSelect({ months, value, basePath }: { months: string[]; value: string; basePath: string }) {
  const router = useRouter();
  return (
    <NativeSelect
      aria-label="Mois du relevé"
      value={value}
      onChange={(e) => router.push(`${basePath}?mois=${e.target.value}`, { scroll: false })}
      className="h-8 min-w-[170px] text-[13px]"
    >
      {months.map((m) => (
        <option key={m} value={m}>
          {capitalize(monthLabel(m))}
        </option>
      ))}
    </NativeSelect>
  );
}
