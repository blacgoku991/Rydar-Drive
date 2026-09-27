import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Badge « N documents à valider » (entrée Chauffeurs) : mêmes règles que org_document_alerts (counts.pending, carte de la
 * page Chauffeurs) — dépôts en attente des chauffeurs non désactivés. Les pièces des candidats (chauffeurs inactifs,
 * candidature en attente) se traitent depuis Réseau et ne sont pas comptées.
 * Lu par le layout (serveur) et relu en temps réel par la barre latérale (navigateur). null si la lecture échoue.
 */
export async function countPendingDocuments(supabase: SupabaseClient, orgId: string): Promise<number | null> {
  const { count, error } = await supabase
    .from("driver_documents")
    .select("id, driver:drivers!inner(status)", { count: "exact", head: true })
    .eq("organization_id", orgId)
    .eq("status", "pending")
    .neq("driver.status", "inactive");
  return error ? null : (count ?? 0);
}
