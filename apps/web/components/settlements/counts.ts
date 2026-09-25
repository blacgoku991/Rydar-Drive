// Compteurs de la navigation en mode centrale (serveur : mise en page ; client : après un événement temps réel).
// Requêtes « head » (aucune ligne transférée), RLS de l'utilisateur connecté.
import type { SupabaseClient } from "@supabase/supabase-js";

export type CentraleCounts = {
  /** Commissions signalées payées par les chauffeurs, à confirmer (« Reçu » / « Pas reçu ») */
  declared: number;
  /** Commissions en retard (échéance passée) ou contestées : elles bloquent les offres */
  overdue: number;
  /** Candidatures reçues par le lien d'inscription, en attente de validation */
  applications: number;
};

export const EMPTY_CENTRALE_COUNTS: CentraleCounts = { declared: 0, overdue: 0, applications: 0 };

export async function fetchCentraleCounts(supabase: SupabaseClient, orgId: string): Promise<CentraleCounts> {
  const now = new Date().toISOString();
  const settlements = () => supabase.from("ride_settlements").select("id", { count: "exact", head: true }).eq("organization_id", orgId);
  const [declared, late, disputed, applications] = await Promise.all([
    settlements().eq("status", "declared"),
    settlements().eq("direction", "driver_owes").eq("status", "due").lte("due_at", now),
    settlements().eq("direction", "driver_owes").eq("status", "disputed"),
    supabase.from("drivers").select("id", { count: "exact", head: true }).eq("organization_id", orgId).eq("application_status", "pending"),
  ]);
  return {
    declared: declared.count ?? 0,
    overdue: (late.count ?? 0) + (disputed.count ?? 0),
    applications: applications.count ?? 0,
  };
}
