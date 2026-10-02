"use client";
// Pages Réseau / Inscriptions : nouvelles candidatures en temps réel (driver.application sur org:{id}) + repli par sondage.
import type { DispatchModel, DriverApplicationEvent } from "@rydar/shared";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { joinedLabel } from "@/components/network/join-copy";
import { useRealtimeEvent } from "@/components/realtime/realtime-provider";
import { useLiveSync } from "@/components/realtime/use-live-sync";

export function NetworkLive({ pollMs = 30_000, model = "centrale" }: { pollMs?: number; model?: DispatchModel }) {
  const router = useRouter();
  // Temps réel indisponible : rafraîchissement périodique (délai croissant, en pause onglet caché)
  const { schedule } = useLiveSync(() => router.refresh(), { pollMs, maxPollMs: Math.max(pollMs, 120_000), debounceMs: 350 });

  useRealtimeEvent("driver.application", (e: DriverApplicationEvent) => {
    if (!e?.driver?.id) return;
    const name = `${e.driver.first_name} ${e.driver.last_name}`.trim();
    // Nouvelle candidature (id stable : un événement reçu deux fois ne crée qu'un toast). Validation / refus :
    // l'auteur a déjà son propre toast, les autres écrans se rafraîchissent simplement.
    if (e.action === "applied") {
      toast.info(`Nouvelle candidature : ${name}`, { id: `application-${e.driver.id}`, description: "Vérifiez ses informations puis validez ou refusez." });
    } else if (e.action === "approved" && e.driver.applied_at) {
      // Inscription par le lien avec validation automatique (svc_driver_apply)
      toast.success(`${name} ${joinedLabel(model)}`, {
        id: `application-${e.driver.id}`,
        description: model === "centrale" ? "Validation automatique : niveau « Nouveau »." : "Validation automatique.",
      });
    }
    schedule();
  });

  return null;
}
