import "server-only";
import { cache } from "react";
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
