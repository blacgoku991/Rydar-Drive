import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AdminFraudReport } from "./fraud-reports";

// Signalements de fraude envoyés par les centrales (page /admin/signalements) : lecture du super admin avec SA session
// (RLS : private.is_super_admin()), jamais la clé service. Même lecture qu'avant son déplacement depuis /admin/centrales.

/** Signalement, centrale qui signale, auteurs (signalement, décision) et comptes bannis par ce signalement. */
const REPORT_COLUMNS =
  "id, organization_id, driver_id, driver_label, category, reason, identities, status, reported_by, reviewed_by, reviewed_at, review_note, created_at, updated_at, " +
  "organization:organizations(id, name), reporter:users!fraud_reports_reported_by_fkey(full_name, email), reviewer:users!fraud_reports_reviewed_by_fkey(full_name, email), " +
  "touched:drivers!drivers_ban_report_fk(id, number, first_name, last_name, organization:organizations(name))";

/** Signalements lus (200 au plus). */
export const FRAUD_REPORTS_LIMIT = 200;

const one = <T,>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));

/**
 * Les signalements les plus récents d'abord. `error` : lecture impossible — la page le dit, elle n'affiche jamais une
 * liste vide trompeuse (« aucun signalement »).
 */
export async function readFraudReports(supabase: SupabaseClient): Promise<{ reports: AdminFraudReport[]; error: boolean }> {
  const { data, error } = await supabase
    .from("fraud_reports")
    .select(REPORT_COLUMNS)
    .order("created_at", { ascending: false })
    .limit(FRAUD_REPORTS_LIMIT);
  if (error) {
    console.error("[admin/signalements] lecture des signalements impossible", error.message);
    return { reports: [], error: true };
  }
  const reports = ((data ?? []) as unknown as Record<string, unknown>[]).map(
    (r) =>
      ({
        ...r,
        organization: one(r.organization as AdminFraudReport["organization"]),
        reporter: one(r.reporter as AdminFraudReport["reporter"]),
        reviewer: one(r.reviewer as AdminFraudReport["reviewer"]),
        touched: ((r.touched ?? []) as Record<string, unknown>[]).map((d) => ({ ...d, organization: one(d.organization as { name: string } | null) })),
      }) as AdminFraudReport,
  );
  return { reports, error: false };
}
