// Ménage périodique (private.housekeeping, dernière définition 20260924006600) : courses planifiées acceptées jamais
// démarrées clôturées 6 h après l'heure de prise en charge (« rides_expired ») ; hausses des frais Rydar annoncées
// appliquées à leur date d'effet (« platform_fee_changes_applied ») ; durées de conservation annoncées
// par /confidentialite et /dpa. Les purges longues ou hors de nos tables (courses de plus de 10 ans, bannissements de
// plus de 3 ans, journal d'audit de Supabase Auth de plus d'un an) sont isolées en SQL : un échec revient dans
// « errors » sans bloquer le reste du ménage et elles sont retentées au passage suivant. Journal en niveau warn dans ce
// cas, pour qu'une purge qui échoue à chaque passage ne passe pas inaperçue.
//
// Au même passage, formulaire de contact (private.purge_contact_data, migration 20260924005700) : demandes de plus de
// 3 ans, demandes indésirables de plus de 30 jours, e-mails sans demande (e-mails de test) de plus d'un an une fois
// envoyés ou en échec. Appel séparé qui ne lève jamais d'exception : son échec n'empêche pas le ménage principal.
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

/** Codes PostgreSQL d'une fonction ou d'un schéma absents (migration pas encore appliquée). */
const MISSING = new Set(["42883", "3F000"]);

/**
 * Purge du formulaire de contact : compteurs journalisés quand quelque chose a été supprimé ; fonction absente (base
 * pas encore migrée) signalée une seule fois, sans erreur ; autre échec en warn, retenté au passage suivant.
 * Renvoie les compteurs, ou null si la purge n'a pas eu lieu.
 */
export function createContactPurge() {
  let missingLogged = false;
  return async function purgeContactData(query: QueryFn): Promise<Record<string, unknown> | null> {
    try {
      const { rows } = await query("select private.purge_contact_data() as r");
      const r = (rows[0]?.r ?? {}) as Record<string, unknown>;
      missingLogged = false;
      if (Object.values(r).some((v) => typeof v === "number" && v > 0)) log("info", "contact data purged", r);
      return r;
    } catch (error) {
      const e = error as { code?: unknown; message?: unknown };
      if (typeof e.code === "string" && MISSING.has(e.code)) {
        if (!missingLogged) {
          missingLogged = true;
          log("warn", "contact data purge skipped: private.purge_contact_data() missing (migration not applied yet)");
        }
        return null;
      }
      log("warn", "contact data purge failed, retried next run", { error: String(e.message ?? error) });
      return null;
    }
  };
}
