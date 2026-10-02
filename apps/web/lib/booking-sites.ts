import "server-only";
import { cache } from "react";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Interrupteur plateforme des mini-sites de réservation (platform_settings, migration 20260924006200), réglé par le
 * super admin (Offres & limites). Coupé : menu « Mini-site » masqué, éditeur remplacé par une explication, /book,
 * devis, réservation, sous-domaines, domaines personnalisés et nouveaux certificats refusés (la base refuse aussi :
 * BOOKING_SITES_DISABLED). Les réglages de chaque centrale sont conservés.
 * Erreur de lecture = coupé : jamais un mini-site servi par défaut. Une lecture par requête (cache React).
 */
export const bookingSitesEnabled = cache(async (): Promise<boolean> => {
  try {
    const { data, error } = await createAdminClient().rpc("booking_sites_enabled");
    return !error && data === true;
  } catch {
    return false;
  }
});
