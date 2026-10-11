"use client";
import { useLayoutEffect } from "react";
import { rememberViewedOrg } from "@/lib/org-view";

/**
 * Pages hors de la coquille du tableau de bord qui agissent pour une centrale (/suspended : « J'ai payé », règlements
 * réseau) : posent rd_view comme la coquille, pour que les actions serveur refusent une centrale résolue différente.
 */
export function RememberViewedOrg({ orgId }: { orgId: string }) {
  useLayoutEffect(() => rememberViewedOrg(orgId), [orgId]);
  return null;
}
