"use client";
// Exécution d'une action serveur du réseau partagé hors formulaire (bouton, interrupteur) : transition + runAction
// (aucune exception jusqu'à la frontière d'erreur), toast du résultat, puis relecture de la page.
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";
import type { NetworkActionResult } from "@/app/dashboard/reseau-partage/actions";
import { runAction } from "@/lib/run-action";

export function useNetworkRunner() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const run = <T extends object>(fn: () => Promise<NetworkActionResult<T>>, after?: (res: Extract<NetworkActionResult<T>, { ok: true }>) => void) =>
    start(() => runAction(async () => {
      const res = await fn();
      if (!res.ok) return void toast.error(res.error);
      if (res.message) toast.success(res.message);
      after?.(res as Extract<NetworkActionResult<T>, { ok: true }>);
      router.refresh();
    }));
  return { pending, run };
}
