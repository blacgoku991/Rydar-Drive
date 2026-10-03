import "server-only";
import type { OrgNetworkSummary } from "@rydar/shared";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cache } from "react";
import { networkPendingWork, type NetworkAccess } from "@/components/network-share/access";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Interrupteur plateforme du réseau partagé (platform_settings.shared_network_enabled, migration 20260924006700),
 * réglé par le super admin. Coupé (défaut) : AUCUN écran réseau (menu, onglet, bandeaux) et rien ne change pour
 * personne ; la base refuse aussi (NETWORK_DISABLED). Erreur de lecture = coupé. Une lecture par requête (cache React,
 * partagée par la mise en page et la page).
 */
export const sharedNetworkEnabled = cache(async (): Promise<boolean> => {
  try {
    const { data, error } = await createAdminClient().rpc("shared_network_enabled");
    return !error && data === true;
  } catch {
    return false;
  }
});

/**
 * Résumé réseau de l'organisation (org_network_summary : pastille du menu, bandeau de la convention, en-tête et
 * indicateurs de l'onglet). Une lecture par requête : la mise en page et la page partagent le même client de session.
 * null si la lecture échoue (pastille à zéro, en-tête indisponible).
 */
export const networkSummary = cache(async (supabase: SupabaseClient, orgId: string): Promise<OrgNetworkSummary | null> => {
  const { data, error } = await supabase.rpc("org_network_summary", { p_org: orgId });
  return error ? null : ((data ?? null) as OrgNetworkSummary | null);
});

/**
 * Accès réseau de l'organisation ACTIVE (components/network-share/access.ts) :
 *   • interrupteur ouvert : onglet complet ;
 *   • interrupteur coupé et organisation déjà membre (network_memberships, RLS) : onglet réduit aux sommes en cours
 *     (NETWORK_CLOSED_RPCS) — les courses déjà acceptées vont à leur terme et créent leurs règlements ;
 *   • sinon null : aucun écran réseau, et aucune lecture de plus que l'interrupteur et l'adhésion.
 * Une lecture par requête (cache React) ; une adhésion illisible vaut « jamais membre ».
 */
export const networkAccess = cache(async (supabase: SupabaseClient, orgId: string): Promise<NetworkAccess | null> => {
  if (await sharedNetworkEnabled()) return { mode: "open", summary: await networkSummary(supabase, orgId) };
  const { data, error } = await supabase.from("network_memberships").select("organization_id").eq("organization_id", orgId).maybeSingle();
  if (error || !data) return null;
  const summary = await networkSummary(supabase, orgId);
  return { mode: "closed", summary, pending: networkPendingWork(summary) };
});
