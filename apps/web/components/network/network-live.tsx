"use client";
// Page Réseau : nouvelles candidatures en temps réel (driver.application sur org:{id}) + repli par sondage.
import type { DriverApplicationEvent } from "@rydar/shared";
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { useRealtimeEvent, useRealtimeStatus } from "@/components/realtime/realtime-provider";

export function NetworkLive({ pollMs = 30_000 }: { pollMs?: number }) {
  const router = useRouter();
  const status = useRealtimeStatus();
  const timer = useRef<number | null>(null);

  const refresh = () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => router.refresh(), 350);
  };
  useEffect(() => () => {
    if (timer.current) window.clearTimeout(timer.current);
  }, []);

  useRealtimeEvent("driver.application", (e: DriverApplicationEvent) => {
    if (!e?.driver?.id) return;
    const name = `${e.driver.first_name} ${e.driver.last_name}`.trim();
    // Nouvelle candidature (id stable : un événement reçu deux fois ne crée qu'un toast). Validation / refus :
    // l'auteur a déjà son propre toast, les autres écrans se rafraîchissent simplement.
    if (e.action === "applied") {
      toast.info(`Nouvelle candidature : ${name}`, { id: `application-${e.driver.id}`, description: "Vérifiez ses informations puis validez ou refusez." });
    } else if (e.action === "approved" && e.driver.applied_at) {
      // Inscription par le lien avec validation automatique (svc_driver_apply)
      toast.success(`${name} a rejoint le réseau`, { id: `application-${e.driver.id}`, description: "Validation automatique : niveau « Nouveau »." });
    }
    refresh();
  });

  // Temps réel indisponible : rafraîchissement périodique
  useEffect(() => {
    if (status === "live") return;
    const id = window.setInterval(() => router.refresh(), pollMs);
    return () => window.clearInterval(id);
  }, [status, router, pollMs]);

  return null;
}
