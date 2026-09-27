// Ménage périodique (private.housekeeping, dernière définition 20260924004800) : durées de conservation annoncées
// par /confidentialite et /dpa. Les purges longues ou hors de nos tables (courses de plus de 10 ans, bannissements de
// plus de 3 ans, journal d'audit de Supabase Auth de plus d'un an) sont isolées en SQL : un échec revient dans
// « errors » sans bloquer le reste du ménage et elles sont retentées au passage suivant. Journal en niveau warn dans ce
// cas, pour qu'une purge qui échoue à chaque passage ne passe pas inaperçue.
import { log } from "./config";

export type QueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;
export type HousekeepingResult = Record<string, unknown> & { errors?: Record<string, string> };

export async function runHousekeeping(query: QueryFn): Promise<HousekeepingResult> {
  const { rows } = await query("select private.housekeeping() as r");
  const r = (rows[0]?.r ?? {}) as HousekeepingResult;
  if (r.errors && Object.keys(r.errors).length) log("warn", "housekeeping incomplete: purge failed, retried next run", r);
  else log("info", "housekeeping", r);
  return r;
}
